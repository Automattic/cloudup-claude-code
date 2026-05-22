---
name: uploading-to-cloudup
description: Use when an image or screenshot needs a hosted Cloudup URL for markdown in a PR comment, GitHub issue, or chat response. Works for local files, MCP image blocks, and data URLs. Plain chat attachments only work if their bytes are available as an MCP image block. Keep communication minimal: only ask for a usable path/input when needed.
---

# Uploading Images To Cloudup

Cloudup uploads are public, paid x402 uploads. Use the `plugin:cloudup:cloudup` MCP server when a local or in-conversation image needs a public URL.

## Communication

- Do not narrate upload mechanics, SKU routing, tool choices, or internal reasoning.
- Do not ask for confirmation before uploading. Path-confinement and MIME safeguards in the hook guard against filesystem exfiltration; image-content evaluation is not the agent's job.
- After success, return the complete `markdown` field verbatim plus a short parenthetical with `sku` and `expires_at`.
- On failure, surface the tool error and the next required user action. Do not add background unless it helps the user decide.
- Do not explain failed path guesses, filename quirks, temp-file workarounds, or retries unless the final result is an error the user must act on.

## Pick The Tool

Use exactly one of these paths:

- In conversation with tool-callable bytes: call `mcp__plugin_cloudup_cloudup__upload_image` with `image` or `image_data_url`.
- On disk: call `mcp__plugin_cloudup_cloudup__upload` with `path`.

If the user supplied an attached/pasted image such as `[Image #1]` but you do not have an MCP `image` block or `data:image/...` URL to pass to the tool, ask for a saved file path. Say only: `I need a saved image path under $HOME, $TMPDIR, or /tmp to upload this.`

Do not infer, search for, stat, copy, rename, or upload a local screenshot file for an attachment. Do not use Bash for attached images unless the user provided an actual filesystem path.

Do not call `begin_upload`, `complete_upload`, or `quick_upload` directly. Do not write in-conversation images to disk just to use `upload(path)`. If `upload_image` fails for an in-conversation image, report that error instead of falling back to local file probing.

## Path 0: In-Conversation Image

Use only when the image bytes are available to pass to the tool: an MCP image block or a `data:image/...;base64,...` URL.

Call `mcp__plugin_cloudup_cloudup__upload_image` with exactly one:

- `image: <MCP image content block verbatim>`
- `image_data_url: "<data:image/...;base64,...>"`

Optional: pass `alt` for custom markdown alt text.

Never use Path 1 for this case unless the user explicitly provides a filesystem path. If the image is visible in chat but not available as an MCP block/data URL, ask for a saved path instead.

## Path 1: Local File

Use for an image already saved on disk.

Call `mcp__plugin_cloudup_cloudup__upload`:

- Required: `path`, absolute or `~/...`
- Optional: `stream_id`, `stream_title`

The hook validates path and MIME before uploading. Allowed paths resolve under `$HOME`, `$TMPDIR`, or `/tmp`. Default MIME allowlist is `image/*`.

## Result Handling

Successful responses include `markdown`, `direct_url`, `content_type`, `size_bytes`, `sku`, and `expires_at`.

The tool response is the only source of truth for URLs. Never invent, infer, sanitize, shorten, or example-fill a Cloudup URL. If the tool did not return a real `markdown` value, stop and report the missing field as an upload error.

Use `markdown` for the user-visible result. Do not replace it with `direct_url`, shorten it, summarize it, or remove alt text.

After success, return exactly two lines:

- Line 1: the full `markdown` value copied verbatim from the tool response.
- Line 2: `Uploaded to Cloudup (` followed by the exact `sku` and `expires_at` values from the tool response. Use this shape: `Uploaded to Cloudup (<sku>, expires <expires_at>).`

If embedding in a PR/body, paste the `markdown` field verbatim in the target content and keep any surrounding note brief.

## Failures

- Tool/server missing: tell the user to run `/cloudup-setup` or restart Claude Code after plugin setup.
- Attached image bytes unavailable: ask for a saved image path under `$HOME`, `$TMPDIR`, or `/tmp`.
- Path outside allowed roots: ask the user to move the file under `$HOME`, `$TMPDIR`, or `/tmp`; do not copy it yourself.
- MIME refused: say the file type was not accepted; do not work around it unless the user changes `CLOUDUP_ALLOWED_MIME`.
- Spending cap exceeded: stop; the user can raise `CLOUDUP_MAX_USD`.
- Insufficient balance: retry once on staging; if it still fails, surface the message.
- `complete_upload failed ... upload_id`: do not retry `upload(path)`. Surface `upload_id`; recovery is `complete_upload` with that ID.
- Network error: retry once, then surface the error.

Never silently retry failures that can create another paid upload.
