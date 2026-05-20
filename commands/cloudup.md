---
name: cloudup
description: Upload an image to Cloudup and return the full markdown result. Works with a file path, or with an MCP image block/data URL available to tools.
---

# /cloudup

Upload an image to Cloudup and return only the full ready-to-paste markdown plus brief SKU/expiry metadata.

## Usage

```
/cloudup <path-to-image>
/cloudup                    # upload an MCP image block/data URL from the conversation
```

## Instructions

1. The user has invoked `/cloudup` with arguments: `$ARGUMENTS`.
2. Decide which input source to upload:
   - **`$ARGUMENTS` is non-empty** → treat it as a path to a local file. Resolve it to an absolute path if it isn't already, and verify the file exists. If it doesn't, report the error and stop.
   - **`$ARGUMENTS` is empty** → look for a tool-callable image in the current conversation context: either an MCP `image` content block or a `data:image/...;base64,...` URL. If only a plain chat attachment like `[Image #1]` is visible and no bytes are available to pass to the upload tool, ask for a saved path under `$HOME`, `$TMPDIR`, or `/tmp`. Do not search the filesystem for a matching screenshot name.
3. Invoke the `cloudup:uploading-to-cloudup` skill to perform the upload. The skill is the source of truth for tool choice, safety confirmation, errors, and concise result formatting.
