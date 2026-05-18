#!/usr/bin/env bash
# Cloudup MCP wrapper — picks a signer for mpp-remote and execs the bridge.
#
# Three signer modes, tried in this order:
#
#   1. CLOUDUP_WALLET_KEY env var (CI / headless): if set (typically a
#      TeamCity secret), pass it through as MPP_WALLET_PRIVATE_KEY.
#      mpp-remote signs locally with viem. Suitable for unattended use
#      where neither `paw login` (browser-based) nor Keychain are
#      available.
#
#   2. macOS Keychain (locally-generated key): if a key exists under
#      service=cloudup, account=wallet, read it and pass through as
#      MPP_WALLET_PRIVATE_KEY. Provisioned by `cloudup-key generate` in
#      `/cloudup-setup`.
#
#   3. Privy agent-wallet CLI (Privy managed wallet): resolve the user's
#      wallet address via `paw list-wallets` and pass it to mpp-remote as
#      PRIVY_WALLET_ADDRESS. The signing key never leaves Privy. One-time
#      prereq: `npm i -g @privy-io/agent-wallet-cli && paw login`.
#
# Switching between modes 2 and 3 requires removing the previous one's
# state (`cloudup-key remove` or by clearing the paw session) — the
# wrapper just picks the highest-precedence signer that's configured.
#
# Claude Code's MCP launch environment does NOT inherit nvm/Homebrew PATH
# adjustments, so we have to find `npx` (and `paw`, in mode 3) ourselves.

set -euo pipefail

# ---- bin discovery -------------------------------------------------------

find_bin() {
    local name="$1" p

    p="$(command -v "$name" 2>/dev/null || true)"
    if [ -n "$p" ]; then echo "$p"; return 0; fi

    if [ -s "$HOME/.zshenv" ]; then
        # shellcheck disable=SC1091
        . "$HOME/.zshenv" 2>/dev/null || true
    fi
    local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$nvm_dir/nvm.sh" ]; then
        export NVM_DIR="$nvm_dir"
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh" 2>/dev/null || true
    fi

    p="$(command -v "$name" 2>/dev/null || true)"
    if [ -n "$p" ]; then echo "$p"; return 0; fi

    local cand
    for cand in \
        /opt/homebrew/bin/"$name" \
        /usr/local/bin/"$name" \
        "$HOME"/.nvm/versions/node/*/bin/"$name" \
        "$HOME"/.volta/bin/"$name" \
        /usr/bin/"$name"; do
        if [ -x "$cand" ]; then echo "$cand"; return 0; fi
    done

    return 1
}

NPX="$(find_bin npx)" || {
    cat >&2 <<'EOF'
cloudup: cannot find `npx` on PATH.

Claude Code launches MCP servers without sourcing your shell rc, so nvm /
Homebrew PATH additions are not inherited. Install Node.js system-wide
(e.g. via Homebrew: `brew install node`) or add the directory containing
`npx` to a non-interactive shell init file like ~/.zshenv.
EOF
    exit 1
}

export PATH="$(dirname "$NPX"):$PATH"

# ---- signer selection ----------------------------------------------------

KEYCHAIN_KEY=""
if command -v security >/dev/null 2>&1; then
    KEYCHAIN_KEY="$(security find-generic-password -s cloudup -a wallet -w 2>/dev/null || true)"
fi

if [ -n "${CLOUDUP_WALLET_KEY:-}" ]; then
    # Mode 1: env-var key (CI / headless).
    export MPP_WALLET_PRIVATE_KEY="$CLOUDUP_WALLET_KEY"
elif [ -n "$KEYCHAIN_KEY" ]; then
    # Mode 2: Keychain-stored key (locally-generated).
    export MPP_WALLET_PRIVATE_KEY="$KEYCHAIN_KEY"
else
    # Mode 3: Privy agent-wallet CLI.
    PAW="$(find_bin paw)" || {
        cat >&2 <<'EOF'
cloudup: no signer configured.

Run /cloudup-setup in Claude Code, or pick one of these paths manually:

  1. Privy: `npm i -g @privy-io/agent-wallet-cli && paw login`
  2. Locally-generated key: run `scripts/cloudup-key.sh generate`
  3. CI / headless: set CLOUDUP_WALLET_KEY to a 0x-prefixed private key

See the plugin README for the trade-offs.
EOF
        exit 1
    }
    export PATH="$(dirname "$PAW"):$PATH"

    if ! WALLETS_OUT="$("$PAW" list-wallets 2>&1)"; then
        cat >&2 <<EOF
cloudup: \`paw list-wallets\` failed. Run \`paw login\` first.

$WALLETS_OUT
EOF
        exit 1
    fi

    # `paw list-wallets` prints a human-readable block; pull the Ethereum line.
    ADDR="$(printf '%s\n' "$WALLETS_OUT" | sed -nE 's/.*Ethereum:[[:space:]]+(0x[0-9a-fA-F]+).*/\1/p' | head -n1)"

    if [ -z "$ADDR" ]; then
        cat >&2 <<EOF
cloudup: could not parse an Ethereum address from \`paw list-wallets\`:

$WALLETS_OUT
EOF
        exit 1
    fi

    export PRIVY_WALLET_ADDRESS="$ADDR"
    export PRIVY_AGENT_WALLET_BIN="$PAW"
fi

# ---- exec mpp-remote -----------------------------------------------------

export MPP_MAX_AMOUNT_USD="${CLOUDUP_MAX_USD:-0.20}"

# Opt-in proxy. The Cloudup staging endpoint is IP-restricted to the A8c
# network, so A8c users typically set CLOUDUP_PROXY=socks5h://127.0.0.1:8080
# (the conventional `ssh -D 8080 <bastion>` forwarder). External users hit
# the public endpoint directly and leave CLOUDUP_PROXY unset.
PROXY_ARGS=()
if [ -n "${CLOUDUP_PROXY:-}" ]; then
    PROXY_ARGS=(--proxy "$CLOUDUP_PROXY")
fi

exec "$NPX" -y github:tellyworth/mpp-remote \
    ${PROXY_ARGS[@]+"${PROXY_ARGS[@]}"} \
    "${CLOUDUP_MCP_URL:-https://api.stage-cloudup.com/mcp/public}"
