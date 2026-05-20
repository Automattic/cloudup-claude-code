/*
 * Tests for the SKU-dispatch logic in hooks/cloudup.mjs's uploadFile().
 *
 * 2f39b89 rewrote the previous "two-route by size" dispatch into a three-way
 * decision based on mime + size + stream_id presence. These tests lock that
 * decision table in:
 *
 *   image,    ≤9 MiB,  no streamId   → upload_image (embed)
 *   image,    ≤9 MiB,  with streamId → quick_upload (embed unavailable with stream_id)
 *   non-image ≤1.5 MiB                → quick_upload (quick)
 *   image,    >9 MiB                  → begin_upload (large)
 *   non-image >1.5 MiB                → begin_upload (large)
 *
 * Strategy: drive the hook's `handle()` with a fake callTool that records
 * which upstream tool was hit and returns either a parseable payload or an
 * isError envelope. The large-route tests short-circuit by failing the fake
 * on `begin_upload` — that proves dispatch landed in largeUpload without
 * having to mock the S3 PUT and complete_upload follow-ups.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import hook from '../hooks/cloudup.mjs';

// ---- fixtures ----------------------------------------------------------

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MP4_HEADER = Buffer.concat([
	Buffer.from([0, 0, 0, 32]),
	Buffer.from('ftypisom', 'latin1'),
]);

function buildFixture(header, size) {
	return Buffer.concat([header, Buffer.alloc(size - header.length)]);
}

let tmpRoot;
let savedAllowedMime;

before(async () => {
	tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cloudup-dispatch-')));
	// The non-image dispatch cases need video/mp4 in the allowlist; otherwise
	// validateUploadPath rejects them at the sniff step before dispatch runs.
	savedAllowedMime = process.env.CLOUDUP_ALLOWED_MIME;
	process.env.CLOUDUP_ALLOWED_MIME = 'image/*,video/mp4';
});

after(async () => {
	await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
	if (savedAllowedMime === undefined) delete process.env.CLOUDUP_ALLOWED_MIME;
	else process.env.CLOUDUP_ALLOWED_MIME = savedAllowedMime;
});

// Fake callTool: records each invocation, returns a parseable success
// envelope by default, or an isError envelope for any name in failOn.
function makeCallTool({ failOn = null } = {}) {
	const calls = [];
	return {
		calls,
		async callTool(name, args) {
			calls.push({ name, args });
			if (name === failOn) {
				return {
					jsonrpc: '2.0',
					result: {
						isError: true,
						content: [
							{ type: 'text', text: `${name} stub: short-circuiting dispatch test` },
						],
					},
				};
			}
			return {
				jsonrpc: '2.0',
				result: {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								direct_url: 'https://example.invalid/x',
								markdown: '![](https://example.invalid/x)',
								content_type: args.mime ?? 'image/png',
								size_bytes: args.size_bytes ?? 32,
								sku: 'stub',
								expires_at: '2099-01-01',
							}),
						},
					],
				},
			};
		},
	};
}

async function runDispatch(filename, contents, { callArgs = {}, failOn = null } = {}) {
	const p = path.join(tmpRoot, filename);
	await fs.writeFile(p, contents);
	const tool = makeCallTool({ failOn });
	const result = await hook.handle({
		name: 'upload',
		args: { path: p, ...callArgs },
		callTool: tool.callTool,
		logger: () => {},
	});
	return { tool, result };
}

// ---- the five cases ----------------------------------------------------

test('dispatch: image ≤9 MiB, no streamId → upload_image (embed)', async () => {
	const { tool, result } = await runDispatch('small.png', buildFixture(PNG_HEADER, 32));
	assert.equal(tool.calls.length, 1);
	assert.equal(tool.calls[0].name, 'upload_image');
	assert.equal(tool.calls[0].args.mime, 'image/png');
	assert.equal(tool.calls[0].args.filename, 'small.png');
	// upload_image's underlying schema doesn't accept stream_id, so embedUpload
	// must not forward one even if the route picks embed. This guards against
	// a future "drop streamTitle but accidentally keep streamId" regression.
	assert.equal('stream_id' in tool.calls[0].args, false);
	assert.equal(result.isError, undefined);
});

test('dispatch: image ≤9 MiB, with streamId → quick_upload (embed skipped)', async () => {
	const { tool, result } = await runDispatch(
		'small-with-stream.png',
		buildFixture(PNG_HEADER, 32),
		{ callArgs: { stream_id: 'STREAM123' } },
	);
	assert.equal(tool.calls[0].name, 'quick_upload');
	assert.equal(tool.calls[0].args.stream_id, 'STREAM123');
	assert.equal(tool.calls[0].args.mime, 'image/png');
	assert.equal(result.isError, undefined);
});

test('dispatch: non-image ≤1.5 MiB → quick_upload', async () => {
	const { tool, result } = await runDispatch('clip-small.mp4', buildFixture(MP4_HEADER, 64));
	assert.equal(tool.calls[0].name, 'quick_upload');
	assert.equal(tool.calls[0].args.mime, 'video/mp4');
	assert.equal(result.isError, undefined);
});

test('dispatch: image >9 MiB → begin_upload (large)', async () => {
	const size = 9 * 1024 * 1024 + 1;
	const { tool, result } = await runDispatch('large.png', buildFixture(PNG_HEADER, size), {
		failOn: 'begin_upload',
	});
	assert.equal(tool.calls[0].name, 'begin_upload');
	assert.equal(tool.calls[0].args.size_bytes, size);
	assert.equal(tool.calls[0].args.mime, 'image/png');
	// Stub fail short-circuits before PUT — handle surfaces isError.
	assert.equal(result.isError, true);
});

test('dispatch: non-image >1.5 MiB → begin_upload (large)', async () => {
	const size = 1536 * 1024 + 1;
	const { tool, result } = await runDispatch(
		'clip-large.mp4',
		buildFixture(MP4_HEADER, size),
		{ failOn: 'begin_upload' },
	);
	assert.equal(tool.calls[0].name, 'begin_upload');
	assert.equal(tool.calls[0].args.size_bytes, size);
	assert.equal(tool.calls[0].args.mime, 'video/mp4');
	assert.equal(result.isError, true);
});
