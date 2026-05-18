#!/usr/bin/env bash
# Manage the Cloudup wallet key in the macOS Keychain.
#
# Subcommands:
#   set [<0x-key>] store a key. With no argument, prompts silently for the
#                  key via the macOS Keychain helper — the key never enters
#                  argv, shell history, or the Claude Code transcript.
#                  Requires a TTY; refuses to run from non-interactive
#                  contexts (including Claude's bash tool) for that reason.
#   generate       generate a fresh key, store it, print the address
#   address        print the wallet address derived from the stored key
#   remove         delete the stored key
#   status         report whether a key is stored
#
# There is intentionally no `show` subcommand: printing the private key from a
# script makes it trivially easy to leak it into a shell history, scrollback,
# or — worst case — a Claude Code transcript that gets sent off-box. If you
# really need the raw key (e.g. to copy it to another laptop), call the
# Keychain directly:
#
#   security find-generic-password -s cloudup -a wallet -w
#
# That's a deliberate friction step.

set -euo pipefail

SERVICE="cloudup"
ACCOUNT="wallet"

require_macos() {
    if ! command -v security >/dev/null 2>&1; then
        echo "cloudup-key: requires macOS Keychain (security CLI not found)" >&2
        exit 2
    fi
}

# viem is pinned to a specific version so a malicious `latest` cannot ride
# along into a process that's about to handle a private key. If the cache
# contains a different version, blow it away and reinstall.
VIEM_VERSION="2.49.2"
VIEM_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/cloudup/viem-$VIEM_VERSION"

# Install viem once into a stable cache dir so `node -e` can require() it.
# `npx -p viem -- node -e ...` does not work because npx only puts the
# package's bins on PATH, not in node's resolution path.
ensure_viem() {
    if [ -d "$VIEM_CACHE/node_modules/viem" ]; then
        return 0
    fi
    mkdir -p "$VIEM_CACHE"
    (cd "$VIEM_CACHE" \
        && printf '{"name":"cloudup-key-helper","private":true,"dependencies":{"viem":"%s"}}\n' "$VIEM_VERSION" > package.json \
        && npm install --silent --no-audit --no-fund >&2)
}

# Derive the Ethereum address from a private key. The key is passed via an
# env var, not as an argv string, so it never appears in `ps`-style listings.
derive_address() {
    local key="$1"
    ensure_viem >&2 || return 1
    (cd "$VIEM_CACHE" && CLOUDUP_DERIVE_KEY="$key" node -e 'console.log(require("viem/accounts").privateKeyToAccount(process.env.CLOUDUP_DERIVE_KEY).address)')
}

generate_key() {
    # 32 random bytes is a valid secp256k1 private key with overwhelming
    # probability (chance of being >= curve order is < 2^-128).
    if command -v openssl >/dev/null 2>&1; then
        printf '0x%s\n' "$(openssl rand -hex 32)"
    else
        node -e "console.log('0x' + require('crypto').randomBytes(32).toString('hex'))"
    fi
}

store() {
    local key="$1"
    if [[ ! "$key" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
        echo "cloudup-key: key must be a 0x-prefixed 32-byte hex string" >&2
        exit 1
    fi
    security add-generic-password -s "$SERVICE" -a "$ACCOUNT" -w "$key" -U >/dev/null
}

# Read the stored key and derive its address. Prints nothing on failure.
stored_address() {
    local key
    key="$(security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w 2>/dev/null)" || return 1
    derive_address "$key"
}

# Interactive paste flow. Delegates the actual prompt to `security`'s own
# tty-mode -w (no value) so the key never crosses bash's memory or argv.
# Verifies the result by deriving the address.
interactive_set() {
    if [ ! -t 0 ]; then
        cat >&2 <<'EOF'
cloudup-key set: refusing to prompt without a TTY.

Pasting a private key into a non-interactive context risks leaking it
into the Claude Code transcript, shell history, or process listings.

Open a regular terminal window outside Claude Code and run:

  cloudup-key.sh set

The macOS Keychain helper will prompt for the key silently. Paste it,
hit Enter, then come back to Claude Code.
EOF
        exit 1
    fi

    echo "Paste your 0x-prefixed private key when prompted. Input is hidden." >&2
    if ! security add-generic-password -s "$SERVICE" -a "$ACCOUNT" -U -w; then
        echo "cloudup-key: keychain import failed." >&2
        exit 1
    fi

    echo "Stored key in macOS Keychain ($SERVICE/$ACCOUNT)."
    local addr
    addr="$(stored_address 2>/dev/null || true)"
    if [ -n "$addr" ]; then
        echo "Wallet address: $addr"
        echo "Fund this address with Base Sepolia USDC."
    else
        echo "Key stored, but address derivation failed — the pasted value may not be a valid 0x-prefixed 32-byte hex key." >&2
        echo "Run \`cloudup-key.sh remove\` then \`cloudup-key.sh set\` again to retry." >&2
        exit 1
    fi
}

cmd="${1:-status}"

case "$cmd" in
    set)
        require_macos
        if [ $# -lt 2 ]; then
            interactive_set
        else
            store "$2"
            echo "Stored key in macOS Keychain ($SERVICE/$ACCOUNT)."
            addr="$(derive_address "$2" || true)"
            if [ -n "$addr" ]; then
                echo "Wallet address: $addr"
                echo "Fund this address with Base Sepolia USDC."
            fi
        fi
        ;;

    generate)
        require_macos
        key="$(generate_key)"
        store "$key"
        echo "Generated new wallet and stored in macOS Keychain ($SERVICE/$ACCOUNT)."
        addr="$(derive_address "$key" || true)"
        if [ -n "$addr" ]; then
            echo "Wallet address: $addr"
            echo "Fund this address with Base Sepolia USDC:"
            echo "  https://faucet.circle.com/"
            echo "  https://portal.cdp.coinbase.com/products/faucet"
        else
            echo "Key stored, but address derivation failed."
            echo "Run \`cloudup-key.sh address\` to retry derivation."
        fi
        ;;

    address)
        require_macos
        addr="$(stored_address)" || {
            echo "cloudup-key: no key stored" >&2
            exit 1
        }
        echo "$addr"
        ;;

    remove)
        require_macos
        security delete-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null
        echo "Removed key from macOS Keychain."
        ;;

    status)
        require_macos
        if security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w >/dev/null 2>&1; then
            echo "Key stored in macOS Keychain ($SERVICE/$ACCOUNT)."
        else
            echo "No key stored."
            exit 1
        fi
        ;;

    show)
        cat >&2 <<'EOF'
cloudup-key: `show` is intentionally disabled — printing the private key from
a script makes it easy to leak into shell history, scrollback, or a Claude
Code transcript.

If you really need the raw key (e.g. to copy to another machine), call the
Keychain directly:

  security find-generic-password -s cloudup -a wallet -w

EOF
        exit 2
        ;;

    *)
        cat >&2 <<EOF
Usage: cloudup-key <command>
  set [<0x-key>] store a key (interactive secure paste if no key given)
  generate       generate a fresh key, store it, print the address
  address        print the wallet address
  remove         delete the stored key
  status         report whether a key is stored
EOF
        exit 2
        ;;
esac
