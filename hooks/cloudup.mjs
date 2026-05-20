/*
 * Cloudup upload hook for mpp-remote.
 *
 * Exposes a single `upload(path, …)` tool that collapses Cloudup's three-step
 * upload ceremony into one call from the agent's perspective. Loaded by
 * mpp-remote via `--hook hooks/cloudup.mjs` (see ../scripts/cloudup-server.sh).
 *
 * What the hook does on each `upload` call:
 *
 *   1. Safeguards. Sniff the file's magic bytes against an allowlist (default
 *      `image/*`) and require the path to resolve under $HOME or /tmp. Both
 *      checks run before any upstream call or byte transfer. The on-disk
 *      extension is ignored — a text file renamed `id_rsa.png` is refused.
 *
 *   2. Route by size. Files under QUICK_INLINE_THRESHOLD bytes go through
 *      `quick_upload` (inline base64; $0.01 SKU). Larger files go through
 *      `begin_upload` → S3 PUT → `complete_upload` ($0.25 SKU). The agent
 *      doesn't pick; the hook chooses the cheapest path that works.
 *
 *   3. Return Cloudup's response (share_url, direct_url, markdown,
 *      content_type, size_bytes, sku, expires_at) as a CallToolResult.
 *
 * Safety notes: the hook runs inside mpp-remote's process and has full FS
 * access. The MIME + path checks are belt-and-suspenders against an LLM
 * being induced to upload a sensitive file (~/.ssh/id_rsa, ~/.aws/credentials,
 * etc.). The OS sandbox is the real boundary; these checks just make the
 * obvious exfil attempts fail cheaply.
 */

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Per-SKU max payload sizes. The Cloudup server enforces base64 length caps on
// the inline upload tools; we stay a comfortable margin below them so a file
// at the threshold doesn't bump into the ceiling after base64 expansion (4:3).
//
// upload_image (`embed` SKU, 2-year retention) caps content_base64 at ~13.98M
// chars → ~10.5 MiB binary. 9 MiB leaves headroom.
//
// quick_upload (`quick` SKU, 30-day retention) caps content_base64 at ~2.8M
// chars → ~2 MiB binary. 1.5 MiB leaves headroom.
//
// Anything larger than these (or any image when stream_id is set, since
// upload_image doesn't accept stream_id) falls through to begin_upload +
// S3 PUT + complete_upload (`large` SKU, 30-day retention).
const EMBED_MAX_BYTES = 9 * 1024 * 1024;
const QUICK_MAX_BYTES = 1536 * 1024; // 1.5 MiB

// ---- Safeguards: MIME sniff --------------------------------------------

// Returns one of the recognized MIME strings, or null on no match. Reads from
// `buf` (>= 12 bytes; the ISO-BMFF brand check wants >= 12).
function detectMime(buf) {
	if (!buf || buf.length < 12) return null;
	const s = (start, len) => buf.subarray(start, start + len).toString('latin1');

	// PNG: \x89PNG\r\n\x1a\n
	if (
		buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
		buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
	) return 'image/png';

	// JPEG: FF D8 FF
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';

	// GIF87a / GIF89a
	if (s(0, 6) === 'GIF87a' || s(0, 6) === 'GIF89a') return 'image/gif';

	// BMP: BM
	if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';

	// RIFF....WEBP (size at offset 4 is the RIFF chunk length, ignored here)
	if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'image/webp';

	// ISO-BMFF: skip 4-byte size prefix, then "ftyp", then a 4-char brand.
	if (s(4, 4) === 'ftyp') {
		const brand = s(8, 4);
		// HEIC and HEIF still-image brands sometimes reported as image/heic.
		if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
			return 'image/heic';
		}
		if (['avif', 'avis'].includes(brand)) return 'image/avif';
		if (['mp41', 'mp42', 'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'M4V ', 'M4A ', 'dash', 'qt  '].includes(brand)) {
			return 'video/mp4';
		}
	}

	// WebM / Matroska EBML
	if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
		return 'video/webm';
	}

	return null;
}

function parseAllowedMime(spec) {
	if (!spec || typeof spec !== 'string') {
		throw new Error('allowed MIME spec must be a non-empty string');
	}
	const out = [];
	for (const raw of spec.split(',')) {
		const p = raw.trim().toLowerCase();
		if (!p) continue;
		const slash = p.indexOf('/');
		if (slash <= 0 || slash === p.length - 1) {
			throw new Error(`invalid MIME pattern "${raw}" (expected type/subtype)`);
		}
		out.push({ type: p.slice(0, slash), subtype: p.slice(slash + 1) });
	}
	if (out.length === 0) {
		throw new Error('allowed MIME spec produced no patterns');
	}
	return out;
}

function mimeAllowed(mime, patterns) {
	if (!mime) return false;
	const slash = mime.indexOf('/');
	if (slash <= 0) return false;
	const type = mime.slice(0, slash).toLowerCase();
	const subtype = mime.slice(slash + 1).toLowerCase();
	return patterns.some(
		(p) =>
			(p.type === '*' || p.type === type) &&
			(p.subtype === '*' || p.subtype === subtype),
	);
}

// ---- Safeguards: path confinement --------------------------------------

// Resolve `inputPath` via realpath (follows symlinks) and require the result
// to live under $HOME or /tmp. Both roots are themselves realpath'd, so
// macOS's `/tmp → /private/tmp` symlink is matched correctly.
export async function resolveSafePath(inputPath, { home, tmp } = {}) {
	if (typeof inputPath !== 'string' || inputPath === '') {
		throw new Error('upload path is required');
	}
	const homeDir = home ?? process.env.HOME ?? os.homedir();
	const tmpDir = tmp ?? os.tmpdir();

	// MCP args don't go through a shell, so expand ~ here so an LLM passing
	// "~/Pictures/foo.png" works as expected.
	let expanded = inputPath;
	if (expanded === '~') expanded = homeDir;
	else if (expanded.startsWith('~/')) expanded = path.join(homeDir, expanded.slice(2));

	const abs = path.resolve(expanded);
	let resolved;
	try {
		resolved = await fs.realpath(abs);
	} catch (e) {
		if (e.code === 'ENOENT') {
			throw new Error(`upload path does not exist: ${inputPath}`);
		}
		throw e;
	}

	const rootsToCheck = [];
	for (const root of [homeDir, tmpDir, '/tmp']) {
		if (!root) continue;
		try {
			rootsToCheck.push(await fs.realpath(root));
		} catch {
			// root doesn't exist on this system — skip; the others still apply.
		}
	}
	const uniqueRoots = [...new Set(rootsToCheck)];

	if (!uniqueRoots.some((r) => isUnder(resolved, r))) {
		throw new Error(
			`refusing to upload "${inputPath}" — resolves to "${resolved}", ` +
				`which is not under $HOME or /tmp. ` +
				`(roots checked: ${uniqueRoots.join(', ') || 'none'})`,
		);
	}
	return resolved;
}

function isUnder(child, root) {
	if (child === root) return true;
	const prefix = root.endsWith(path.sep) ? root : root + path.sep;
	return child.startsWith(prefix);
}

// ---- Safeguards: combined entry point ----------------------------------

// Validate a user-supplied path for upload. Returns { path, mime, size } on
// success and throws on any safeguard failure. The returned `path` is the
// realpath'd absolute path — callers should use that, not the input string,
// when opening or stat'ing the file (we already followed the symlink).
export async function validateUploadPath(inputPath, options = {}) {
	const allowedMimeSpec = options.allowedMime ?? process.env.CLOUDUP_ALLOWED_MIME ?? 'image/*';
	const patterns = parseAllowedMime(allowedMimeSpec);

	const resolved = await resolveSafePath(inputPath, options);

	const stat = await fs.stat(resolved);
	if (!stat.isFile()) {
		throw new Error(`refusing to upload "${inputPath}": not a regular file`);
	}
	if (stat.size === 0) {
		throw new Error(`refusing to upload "${inputPath}": empty file`);
	}

	const handle = await fs.open(resolved, 'r');
	let mime;
	try {
		const sniffBuf = Buffer.alloc(64);
		const { bytesRead } = await handle.read(sniffBuf, 0, 64, 0);
		mime = detectMime(sniffBuf.subarray(0, bytesRead));
	} finally {
		await handle.close();
	}

	if (!mime) {
		throw new Error(
			`refusing to upload "${inputPath}": file type not recognized by ` +
				`magic-byte sniff (allowlist: ${allowedMimeSpec}). ` +
				`Recognized formats: PNG, JPEG, GIF, BMP, WebP, AVIF, HEIC, MP4, WebM.`,
		);
	}
	if (!mimeAllowed(mime, patterns)) {
		throw new Error(
			`refusing to upload "${inputPath}": detected ${mime}, ` +
				`which is not in the allowlist (${allowedMimeSpec}).`,
		);
	}

	return { path: resolved, mime, size: stat.size };
}

// Tests need detectMime / parseAllowedMime / mimeAllowed and the
// complete_upload retry helper too — re-export.
export { detectMime, parseAllowedMime, mimeAllowed, callCompleteUploadWithRetry };

// ---- Upload flow -------------------------------------------------------

// Cloudup's tool results return JSON as content[0].text — parse it. Returns
// null on missing/malformed payloads; callers surface the raw tool result.
function parseToolText(result) {
	const text = result?.content?.[0]?.text;
	if (typeof text !== 'string') return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function describeToolError(result) {
	if (!result) return 'no result';
	const text = result?.content?.[0]?.text;
	if (typeof text === 'string' && text.length > 0) return text;
	if (result.structuredContent) return JSON.stringify(result.structuredContent);
	return JSON.stringify(result);
}

// Common shape check for every callTool round-trip we make to Cloudup: the
// JSON-RPC envelope must be successful, the tool result must not be isError,
// and the text payload must be JSON-parseable. Returns the parsed payload or
// throws with a tool-name-prefixed message.
function unwrapToolResponse(toolName, resp) {
	if (resp.error) {
		throw new Error(`${toolName} JSON-RPC: ${JSON.stringify(resp.error)}`);
	}
	if (!resp.result || resp.result.isError) {
		throw new Error(`${toolName}: ${describeToolError(resp.result)}`);
	}
	const payload = parseToolText(resp.result);
	if (!payload) {
		throw new Error(`${toolName} returned unparseable result: ${JSON.stringify(resp.result)}`);
	}
	return payload;
}

// complete_upload sits on the wrong side of the value-transferred boundary:
// by the time we call it, the bytes are already in S3 and we've paid for the
// large SKU. A transient failure here that bubbles up as a tool error makes
// the agent's natural retry — re-calling upload(path) — pay AGAIN for
// begin_upload while the previous bytes sit stranded. So we retry in-hook,
// and on final failure throw an error that carries upload_id so a human (or
// future smarter caller) can recover via complete_upload directly.
const COMPLETE_UPLOAD_BACKOFFS_MS = [200, 800];

async function callCompleteUploadWithRetry(callTool, upload_id, logger, backoffsMs = COMPLETE_UPLOAD_BACKOFFS_MS) {
	const attempts = backoffsMs.length + 1;
	let lastError;
	for (let i = 0; i < attempts; i++) {
		if (i > 0) {
			await new Promise((r) => setTimeout(r, backoffsMs[i - 1]));
			logger(`complete_upload retry ${i}/${attempts - 1} (upload_id=${upload_id})`);
		}
		try {
			return unwrapToolResponse(
				'complete_upload',
				await callTool('complete_upload', { upload_id }),
			);
		} catch (e) {
			lastError = e;
			logger(`complete_upload attempt ${i + 1} failed: ${e.message}`);
		}
	}
	const err = new Error(
		`complete_upload failed after ${attempts} attempts (S3 PUT succeeded). ` +
			`upload_id: ${upload_id}. Last error: ${lastError.message}. ` +
			`Recovery: retry complete_upload with this upload_id; do NOT re-call ` +
			`upload(path) — that would re-run begin_upload and pay again on bytes ` +
			`already in S3.`,
	);
	err.upload_id = upload_id;
	err.recoverable_via = 'complete_upload';
	throw err;
}

async function embedUpload({ callTool, safePath, mime, size, filename, streamTitle, logger }) {
	// upload_image → `embed` SKU. 2-year retention, $0.05. Best default for
	// images that might end up in PR comments or other long-lived markdown.
	// Doesn't accept stream_id (the underlying server tool's schema omits it),
	// so the caller routes around this when stream_id is set.
	logger(`upload_image (embed): ${filename} (${size} bytes, ${mime})`);
	const bytes = await fs.readFile(safePath);
	const args = {
		filename,
		content_base64: bytes.toString('base64'),
		mime,
	};
	if (streamTitle) args.stream_title = streamTitle;

	return unwrapToolResponse('upload_image', await callTool('upload_image', args));
}

async function quickUpload({ callTool, safePath, mime, size, filename, streamId, streamTitle, logger }) {
	// quick_upload → `quick` SKU. 30-day retention, $0.01. Used for non-image
	// small files, and for any small file when stream_id is set (since
	// upload_image doesn't support stream_id).
	logger(`quick_upload: ${filename} (${size} bytes, ${mime})`);
	const bytes = await fs.readFile(safePath);
	const args = {
		filename,
		content_base64: bytes.toString('base64'),
		mime,
	};
	if (streamId) args.stream_id = streamId;
	if (streamTitle) args.stream_title = streamTitle;

	return unwrapToolResponse('quick_upload', await callTool('quick_upload', args));
}

async function largeUpload({ callTool, safePath, mime, size, filename, streamId, streamTitle, logger }) {
	logger(`begin_upload: ${filename} (${size} bytes, ${mime})`);
	const beginArgs = { filename, size_bytes: size, mime };
	if (streamId) beginArgs.stream_id = streamId;
	if (streamTitle) beginArgs.stream_title = streamTitle;

	const beginPayload = unwrapToolResponse('begin_upload', await callTool('begin_upload', beginArgs));
	if (!beginPayload?.upload_id || !beginPayload?.s3_url) {
		throw new Error(
			`begin_upload response missing upload_id or s3_url: ${JSON.stringify(beginPayload)}`,
		);
	}

	// PUT to the presigned S3 URL. Streaming the file so a multi-MB upload
	// doesn't sit in memory. Content-Length is required (the URL was signed
	// for an exact body length).
	const r = await fetch(beginPayload.s3_url, {
		method: 'PUT',
		body: createReadStream(safePath),
		headers: {
			'Content-Type': mime,
			'Content-Length': String(size),
		},
		duplex: 'half',
	});
	if (!r.ok) {
		const detail = await r.text().catch(() => '');
		// 403 typically means the presigned URL has expired; 5xx is transient
		// S3. In both cases the recovery is to restart the ceremony — call
		// begin_upload again to mint a fresh URL, don't retry PUT on the old
		// one. Hint that in the error so the agent doesn't loop on the dead URL.
		const retryHint =
			r.status === 403 || r.status >= 500
				? ' — presigned URL may have expired; retry from begin_upload, not PUT'
				: '';
		throw new Error(`S3 PUT failed: HTTP ${r.status} ${detail.slice(0, 200)}${retryHint}`);
	}
	logger(`PUT ok (HTTP ${r.status})`);

	return callCompleteUploadWithRetry(callTool, beginPayload.upload_id, logger);
}

async function uploadFile({ callTool, filePath, streamId, streamTitle, allowedMime, logger }) {
	const { path: safePath, mime, size } = await validateUploadPath(filePath, { allowedMime });
	const filename = path.basename(safePath);
	const ctx = { callTool, safePath, mime, size, filename, streamId, streamTitle, logger };

	// SKU routing prefers retention over raw cost for the common case
	// (image headed for a PR-comment markdown embed):
	//   image, no stream_id, ≤9 MiB  → upload_image (embed, 2-year, $0.05)
	//   ≤1.5 MiB                     → quick_upload  (quick, 30-day, $0.01)
	//   otherwise                    → begin_upload (large, 30-day, $0.25)
	// upload_image doesn't take stream_id, so callers that pass one skip embed
	// and land in quick or large instead.
	const isImage = mime.startsWith('image/');
	if (isImage && !streamId && size <= EMBED_MAX_BYTES) return embedUpload(ctx);
	if (size <= QUICK_MAX_BYTES) return quickUpload(ctx);
	return largeUpload(ctx);
}

// ---- Hook export -------------------------------------------------------

export default {
	mppRemoteApi: 1,
	tools: [
		{
			name: 'upload',
			description:
				'Upload a local file to Cloudup in a single call and get a share URL. ' +
				'The bridge picks the SKU automatically: images up to ~9 MB go via ' +
				'upload_image (embed SKU, 2-year retention — good for PR comments), ' +
				'other small files via quick_upload (30-day, $0.01), anything larger ' +
				'via begin_upload + S3 PUT + complete_upload (30-day, $0.25). The path ' +
				'is realpath-resolved and must live under $HOME or /tmp; the file type ' +
				'is sniffed from magic bytes (default allowlist: image/*; override ' +
				'with CLOUDUP_ALLOWED_MIME). Files that fail either check are refused.',
			inputSchema: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description:
							'Absolute path to the file. May begin with ~/. After symlink ' +
							'resolution must be under $HOME or /tmp.',
					},
					stream_id: {
						type: 'string',
						description: 'Optional: append to an existing stream UID.',
					},
					stream_title: {
						type: 'string',
						description:
							'Optional: title for a new stream (used only if stream_id is unset).',
					},
				},
				required: ['path'],
			},
		},
	],
	async handle({ name, args, callTool, logger }) {
		if (name !== 'upload') return null;
		const log = logger ?? (() => {});
		try {
			const payload = await uploadFile({
				callTool,
				filePath: args.path,
				streamId: typeof args.stream_id === 'string' ? args.stream_id : undefined,
				streamTitle: typeof args.stream_title === 'string' ? args.stream_title : undefined,
				allowedMime: process.env.CLOUDUP_ALLOWED_MIME,
				logger: log,
			});
			return {
				content: [{ type: 'text', text: JSON.stringify(payload) }],
				structuredContent: payload,
			};
		} catch (e) {
			const msg = `upload: ${e.message}`;
			const structured = { error: msg };
			// Surface recovery handles attached by callCompleteUploadWithRetry so
			// a smarter caller can finalize the upload without paying again. The
			// plaintext error already mentions upload_id; this just makes it
			// programmatically accessible.
			if (e.upload_id) structured.upload_id = e.upload_id;
			if (e.recoverable_via) structured.recoverable_via = e.recoverable_via;
			return {
				isError: true,
				content: [{ type: 'text', text: msg }],
				structuredContent: structured,
			};
		}
	},
};
