---
name: cloudup-setup
description: One-time setup for the Cloudup plugin — pick a wallet path (Privy, locally generated, or bring-your-own) and walk through it. Re-run after setup to verify the whole stack with a small test upload.
---

# /cloudup-setup

One-time setup. Three wallet paths to pick from:

- **Privy agent wallet** (recommended): managed wallet, browser login, signing key never leaves Privy's wallet service.
- **Locally generated key**: a fresh secp256k1 key generated on this machine and stored in the macOS Keychain.
- **Bring your own key**: import an existing private key (e.g. one shared by your team, or exported from another machine) into the macOS Keychain via a secure-paste prompt.

The CI / headless `CLOUDUP_WALLET_KEY` path is not offered here — that's a build-agent flow, see the README.

## Instructions

**First, check whether a wallet is already configured.** Run these in order via Bash; if any returns positive, the user already has a wallet — skip the branch flow below and jump straight to the [Verify](#verify) section to confirm the existing setup works:

- `printenv CLOUDUP_WALLET_KEY` — non-empty? CI / env-var path is configured (highest precedence; if set, the wrapper ignores the others).
- `"$CLAUDE_PLUGIN_ROOT/scripts/cloudup-key.sh" status` — prints `Key stored in macOS Keychain (cloudup/wallet).`? Keychain path is configured (Branch B or C below).
- `command -v paw` succeeds **and** `paw list-wallets` prints an `Ethereum: 0x…` line? Privy path is configured.

Note the active path; you'll mention it in the Verify report. If none of the checks hit, the user needs to provision a wallet — continue with step 1 below.

1. Ask the user which path they want to use, via `AskUserQuestion`:
   - **Question**: "Which wallet do you want to set up?"
   - **Header**: "Wallet"
   - **Options**:
     - **"Privy agent wallet (Recommended)"** — Managed by Privy. Browser-based login. The signing key stays in Privy's service; only a per-user authorization keypair lives on this machine (in the OS keychain).
     - **"Locally generated key"** — A fresh secp256k1 key generated on this machine and stored in the macOS Keychain. macOS only today. You hold the key; back it up accordingly.
     - **"Bring your own key"** — Import an existing private key (e.g. shared by your team, or exported from another machine) into the macOS Keychain. macOS only today. The paste happens in a separate terminal so the key never crosses Claude.

2. Follow the matching branch below based on the user's selection.

---

### Branch A — Privy agent wallet

1. Check whether `paw` is installed by running `command -v paw` via Bash. If it prints a path, skip to step 3.
2. If `paw` is missing, try to install it yourself via Bash:
   ```
   npm i -g @privy-io/agent-wallet-cli
   ```
   - On success, continue to step 3.
   - On failure: if the error contains `EACCES`, `permission denied`, or `EPERM`, npm's global prefix needs elevation. Do **not** retry with `sudo`. Tell the user to run the install themselves in the prompt — they know their npm setup:
     ```
     ! sudo npm i -g @privy-io/agent-wallet-cli
     ```
     or, if they prefer a user-prefixed npm (`~/.npm-global` or nvm), the same command without `sudo`. Wait for them to confirm before continuing.
   - For other failures (network, registry, etc.), surface the error verbatim and stop.
3. Run `paw list-wallets` via Bash.
   - If it prints an `Ethereum: 0x…` line, a session already exists. Print the address and tell the user setup is done — they only need to restart Claude Code if this is the first time the plugin's been wired up. Stop here.
   - If it prints `Not logged in. Run \`privy login\` first.`, proceed to step 4.
4. Tell the user to run `paw login` themselves **in a regular terminal window outside Claude Code** so stdin stays open for the browser round-trip:
   ```
   paw login
   ```
   The CLI prints a URL — the user opens it in a browser, signs in, pastes the credentials blob back at the `Paste your wallet credentials:` prompt, and the CLI stores the session in the OS keychain. Wait for them to confirm.

   (Running `paw login` via the `! …` prompt inside Claude Code aborts before the paste completes — that's the stdin issue we've seen. A regular terminal works.)
5. Re-run `paw list-wallets` to confirm. Print the Ethereum address and tell the user:
   - Fund this address with **Base Sepolia USDC** for the current (staging) endpoint. They can use `paw fund` to open the on-ramp, or any Base Sepolia faucet.
   - Restart Claude Code so the MCP server picks up the new wallet at session start.
   - Then re-run `/cloudup-setup`. It'll detect the wallet and run a small end-to-end test upload to confirm everything's working.

---

### Branch B — Locally generated key

1. Check the platform via Bash: `uname -s`. If it doesn't return `Darwin`, tell the user this path is **macOS only today** (the helper uses the macOS Keychain) and recommend Branch A (Privy) instead. Stop here.
2. Check whether a key is already stored: `"$CLAUDE_PLUGIN_ROOT/scripts/cloudup-key.sh" status`.
   - If it prints `Key stored in macOS Keychain (cloudup/wallet).`, a key already exists. Run `"$CLAUDE_PLUGIN_ROOT/scripts/cloudup-key.sh" address` to print the funded address, and tell the user setup is done — they only need to restart Claude Code if this is the first time the plugin's been wired up. Stop here.
   - If it prints `No key stored.`, proceed to step 3.
3. Generate a fresh key: `"$CLAUDE_PLUGIN_ROOT/scripts/cloudup-key.sh" generate`. This produces 32 random bytes, stores them in the macOS Keychain under service `cloudup`, account `wallet`, and prints the derived Ethereum address.
4. Print the address back to the user and tell them:
   - Fund this address with **Base Sepolia USDC** for the current (staging) endpoint. Use any Base Sepolia faucet:
     - https://faucet.circle.com/ (USDC-only, primary)
     - https://portal.cdp.coinbase.com/products/faucet (ETH + USDC, fallback)
   - Restart Claude Code so the MCP server picks up the key at session start.
   - Then re-run `/cloudup-setup`. It'll detect the wallet and run a small end-to-end test upload to confirm everything's working.
   - The key lives in Keychain only on this machine. If they want to use the same wallet from another laptop, they'll need to either export/import via `cloudup-key.sh show` / `cloudup-key.sh set` or run Privy on the other machine instead.

---

### Branch C — Bring your own key

1. Check the platform via Bash: `uname -s`. If it doesn't return `Darwin`, tell the user this path is **macOS only today** (the helper uses the macOS Keychain) and recommend Branch A (Privy) instead. Stop here.
2. Check whether a key is already stored: `"$CLAUDE_PLUGIN_ROOT/scripts/cloudup-key.sh" status`.
   - If it prints `Key stored in macOS Keychain (cloudup/wallet).`, a key already exists. Run `"$CLAUDE_PLUGIN_ROOT/scripts/cloudup-key.sh" address` to print the funded address, and tell the user setup is done — they only need to restart Claude Code if this is the first time the plugin's been wired up. Stop here.
   - If it prints `No key stored.`, proceed to step 3.
3. Tell the user to import their key themselves, **in a regular terminal window outside Claude Code**, so the key never enters this Claude session's transcript, shell history, or process arguments:
   ```
   "$CLAUDE_PLUGIN_ROOT/scripts/cloudup-key.sh" set
   ```
   (Print the absolute path to the script so they can paste it directly. Get the path by running `echo "$CLAUDE_PLUGIN_ROOT/scripts/cloudup-key.sh"` via Bash.)

   The script will prompt silently via the macOS Keychain helper (`security add-generic-password ... -U -w`). The user pastes the 0x-prefixed private key, hits Enter, and the key is stored under service `cloudup` / account `wallet`. The key never appears in argv, shell history, or the Claude transcript.

   Running `cloudup-key.sh set` (no argument) via the `! …` prompt inside Claude Code refuses to prompt — it requires a TTY by design. A regular terminal works.

   Wait for the user to confirm import completed.
4. Verify the import: run `"$CLAUDE_PLUGIN_ROOT/scripts/cloudup-key.sh" status` and `"$CLAUDE_PLUGIN_ROOT/scripts/cloudup-key.sh" address`. Print the derived address back to the user. If `address` fails, the pasted value was malformed — tell them to run `cloudup-key.sh remove` then repeat step 3.
5. Tell the user:
   - Fund this address with **Base Sepolia USDC** for the current (staging) endpoint, unless someone has already funded the shared wallet. Faucets:
     - https://faucet.circle.com/ (USDC-only, primary)
     - https://portal.cdp.coinbase.com/products/faucet (ETH + USDC, fallback)
   - Restart Claude Code so the MCP server picks up the key at session start.
   - Then re-run `/cloudup-setup`. It'll detect the wallet and run a small end-to-end test upload to confirm everything's working.
   - If the key is shared (e.g. a team wallet), be aware that anyone with the key can drain the funded balance — keep `CLOUDUP_MAX_USD` set conservatively.

---

## Verify

Reached automatically when the detection block at the top of Instructions finds an existing wallet. Runs a small end-to-end test upload to confirm the whole stack — proxy/tunnel, MCP, signer, x402 verify, server settle, S3 — is wired up correctly. For Automattic staff on staging, the test upload also exercises (and pre-warms) the server-side auto-fund, so the user's first real upload after this won't pay the ~2s cold-call latency.

1. **Look up the wallet address** where possible, so the report can include it:
   - Privy: `paw list-wallets` → grep the `Ethereum: 0x…` line.
   - Keychain (Branch B or C): `"$CLAUDE_PLUGIN_ROOT/scripts/cloudup-key.sh" address`.
   - `CLOUDUP_WALLET_KEY` env: skip — the address isn't directly derivable without web3 tooling the plugin doesn't ship. Just note "configured via `CLOUDUP_WALLET_KEY`" in the report.

2. **Call the test upload** via the cloudup MCP server's `quick_upload` tool (cheapest SKU, $0.01, 30-day retention). Pass this literal 1×1 transparent PNG as `content_base64` — it's the smallest valid PNG (96 chars base64) and is embedded inline so nothing extra needs shipping:
   ```
   content_base64: iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=
   alt: cloudup-setup-verify
   ```
   For Automattic staff on staging this charge is covered by the server's auto-fund treasury — the user's wallet doesn't have to be pre-funded.

3. **On success** (the response includes `direct_url` and `markdown`):
   - Report briefly: active signer path, wallet address (if obtained in step 1), and the `direct_url` of the test image. Tell the user setup is complete and uploads will work from now on. Keep it short — they're done.

4. **On failure**, surface a targeted next step rather than the raw error:
   - **Tool not found / MCP server not connected** → the wrapper couldn't start. Common causes:
     - A duplicate manually-configured MCP server is suppressing the plugin's — have them run `claude mcp list` and remove any `cloudup-*` entry. See README §5.
     - Automattic staff: the SOCKS tunnel isn't up. They need `ssh -D 8080 <bastion>` running on `localhost:8080` and `CLOUDUP_PROXY=socks5h://127.0.0.1:8080` set in the shell that launched Claude. See README §"Reaching the staging endpoint".
     - The wrapper script errored out — re-running `/cloudup-setup` once Claude is restarted should surface the wrapper's stderr.
   - **"Insufficient balance" / `invalid_exact_evm_insufficient_balance`** → on the default staging endpoint this should auto-resolve via the server's staff-wallet auto-fund. A single retry is acceptable (the funding tx can briefly lag the facilitator's verify on the cold call). If it persists and the error includes "Staff treasury depleted, ping #cloudup-eng", surface that message verbatim — funding is an operational task for the cloudup-eng team. On non-staging endpoints, point at funding (README §3 / `paw fund` / faucet).
   - **"Spending cap exceeded"** → `CLOUDUP_MAX_USD` is below the `quick` SKU's $0.01, which is well below the default $0.30. Someone lowered it; tell them to raise it.
   - **Other errors** → surface the message verbatim with a note that this is unexpected. Suggest they ping `#cloudup-eng` with the error string and the active signer path.

---

## Headless / CI note

This command assumes there is a human + browser in the loop. On a TeamCity build agent (or any unattended environment), neither Privy's `paw login` (browser-based) nor the macOS Keychain are available. Skip this command entirely and use the **`CLOUDUP_WALLET_KEY` env-var** path documented in the plugin README — set it to a `0x…` private key (typically a CI secret) and the wrapper signs locally with viem. If a user is invoking `/cloudup-setup` from a CI context, point them at that path and stop.
