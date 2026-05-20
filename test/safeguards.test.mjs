/*
 * Unit tests for the hook's safeguard layer in hooks/cloudup.mjs:
 *
 *   - detectMime: magic-byte recognition per format
 *   - parseAllowedMime / mimeAllowed: allowlist parsing and matching
 *   - resolveSafePath: $HOME/tmp confinement, realpath, symlink escape
 *   - validateUploadPath: end-to-end (path + size + sniff + allowlist)
 *
 * The classic attack the path + MIME safeguards must block is an agent being
 * induced to upload e.g. ~/.ssh/id_rsa under a renamed-png path; the symlink
 * escape (~/sneaky.png pointing at /etc/hosts) must be caught after realpath,
 * not before. Both are exercised below.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	detectMime,
	parseAllowedMime,
	mimeAllowed,
	resolveSafePath,
	validateUploadPath,
} from '../hooks/cloudup.mjs';

// ---- fixture buffers ---------------------------------------------------

// Pad a header buffer to N bytes so it survives detectMime's 12-byte minimum
// and validateUploadPath's non-empty-file check (zero-padding is fine — the
// signature is in the leading bytes).
function pad(buf, n = 32) {
	if (buf.length >= n) return buf;
	return Buffer.concat([buf, Buffer.alloc(n - buf.length)]);
}

const PNG = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const GIF87 = pad(Buffer.from('GIF87a\0\0', 'latin1'));
const GIF89 = pad(Buffer.from('GIF89a\0\0', 'latin1'));
const BMP = pad(Buffer.from('BM\0\0\0\0', 'latin1'));
const WEBP = pad(
	Buffer.concat([
		Buffer.from('RIFF', 'latin1'),
		Buffer.from([0, 0, 0, 0]),
		Buffer.from('WEBP', 'latin1'),
	]),
);
const HEIC = pad(
	Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftypheic', 'latin1')]),
);
const AVIF = pad(
	Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftypavif', 'latin1')]),
);
const MP4 = pad(
	Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftypisom', 'latin1')]),
);
const WEBM = pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
const TEXT = pad(Buffer.from('this is plain text, not an image\n', 'latin1'), 64);

// ---- detectMime --------------------------------------------------------

test('detectMime: PNG signature', () => assert.equal(detectMime(PNG), 'image/png'));
test('detectMime: JPEG signature', () => assert.equal(detectMime(JPEG), 'image/jpeg'));
test('detectMime: GIF87a', () => assert.equal(detectMime(GIF87), 'image/gif'));
test('detectMime: GIF89a', () => assert.equal(detectMime(GIF89), 'image/gif'));
test('detectMime: BMP', () => assert.equal(detectMime(BMP), 'image/bmp'));
test('detectMime: WebP (RIFF/WEBP container)', () => assert.equal(detectMime(WEBP), 'image/webp'));
test('detectMime: ISO-BMFF heic brand', () => assert.equal(detectMime(HEIC), 'image/heic'));
test('detectMime: ISO-BMFF avif brand', () => assert.equal(detectMime(AVIF), 'image/avif'));
test('detectMime: ISO-BMFF isom brand → video/mp4', () => assert.equal(detectMime(MP4), 'video/mp4'));
test('detectMime: WebM/Matroska EBML', () => assert.equal(detectMime(WEBM), 'video/webm'));

test('detectMime: plain text → null', () => assert.equal(detectMime(TEXT), null));
test('detectMime: too-short buffer → null', () => {
	assert.equal(detectMime(Buffer.from([0x89, 0x50])), null);
	assert.equal(detectMime(Buffer.alloc(11)), null);
});
test('detectMime: empty/null inputs → null', () => {
	assert.equal(detectMime(null), null);
	assert.equal(detectMime(undefined), null);
	assert.equal(detectMime(Buffer.alloc(0)), null);
});
test('detectMime: unknown ftyp brand → null', () => {
	const unknown = pad(
		Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftypzzzz', 'latin1')]),
	);
	assert.equal(detectMime(unknown), null);
});

// ---- parseAllowedMime --------------------------------------------------

test('parseAllowedMime: single pattern', () => {
	assert.deepEqual(parseAllowedMime('image/*'), [{ type: 'image', subtype: '*' }]);
});
test('parseAllowedMime: comma-separated, trimmed, lowercased', () => {
	assert.deepEqual(parseAllowedMime(' Image/PNG ,  video/Mp4 '), [
		{ type: 'image', subtype: 'png' },
		{ type: 'video', subtype: 'mp4' },
	]);
});
test('parseAllowedMime: empty entries skipped between commas', () => {
	assert.deepEqual(parseAllowedMime('image/png,,video/mp4'), [
		{ type: 'image', subtype: 'png' },
		{ type: 'video', subtype: 'mp4' },
	]);
});
test('parseAllowedMime: */* wildcard parses', () => {
	assert.deepEqual(parseAllowedMime('*/*'), [{ type: '*', subtype: '*' }]);
});

test('parseAllowedMime: missing slash rejects', () => {
	assert.throws(() => parseAllowedMime('imageonly'), /invalid MIME pattern/);
});
test('parseAllowedMime: leading slash rejects', () => {
	assert.throws(() => parseAllowedMime('/png'), /invalid MIME pattern/);
});
test('parseAllowedMime: trailing slash rejects', () => {
	assert.throws(() => parseAllowedMime('image/'), /invalid MIME pattern/);
});
test('parseAllowedMime: empty string rejects', () => {
	assert.throws(() => parseAllowedMime(''), /non-empty string/);
});
test('parseAllowedMime: non-string rejects', () => {
	assert.throws(() => parseAllowedMime(null), /non-empty string/);
});
test('parseAllowedMime: spec that filters to zero patterns rejects', () => {
	assert.throws(() => parseAllowedMime(', , ,'), /no patterns/);
});

// ---- mimeAllowed -------------------------------------------------------

const IMAGE_STAR = parseAllowedMime('image/*');
const PNG_ONLY = parseAllowedMime('image/png');
const STAR_STAR = parseAllowedMime('*/*');

test('mimeAllowed: image/* matches any image/...', () => {
	assert.equal(mimeAllowed('image/png', IMAGE_STAR), true);
	assert.equal(mimeAllowed('image/jpeg', IMAGE_STAR), true);
	assert.equal(mimeAllowed('image/heic', IMAGE_STAR), true);
});
test('mimeAllowed: image/* refuses non-image', () => {
	assert.equal(mimeAllowed('video/mp4', IMAGE_STAR), false);
	assert.equal(mimeAllowed('application/pdf', IMAGE_STAR), false);
});
test('mimeAllowed: exact subtype', () => {
	assert.equal(mimeAllowed('image/png', PNG_ONLY), true);
	assert.equal(mimeAllowed('image/jpeg', PNG_ONLY), false);
});
test('mimeAllowed: */* matches anything', () => {
	assert.equal(mimeAllowed('image/png', STAR_STAR), true);
	assert.equal(mimeAllowed('application/octet-stream', STAR_STAR), true);
});
test('mimeAllowed: null / malformed mime rejected', () => {
	assert.equal(mimeAllowed(null, IMAGE_STAR), false);
	assert.equal(mimeAllowed('', IMAGE_STAR), false);
	assert.equal(mimeAllowed('noslash', IMAGE_STAR), false);
	assert.equal(mimeAllowed('/png', IMAGE_STAR), false);
});
test('mimeAllowed: case-insensitive', () => {
	assert.equal(mimeAllowed('IMAGE/PNG', IMAGE_STAR), true);
	assert.equal(mimeAllowed('Image/Jpeg', IMAGE_STAR), true);
});

// ---- filesystem fixtures for path tests --------------------------------

let homeRoot; // override for HOME
let tmpRoot; // override for tmp
let outsideRoot; // somewhere outside the hardcoded /tmp fallback — for prefix-collision tests
let outsideRootAvailable = false;

before(async () => {
	homeRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cloudup-test-home-')));
	tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cloudup-test-tmp-')));
	// resolveSafePath always checks a hardcoded /tmp root in addition to its
	// arguments, so tests for the isUnder() prefix-collision logic need a
	// location outside /tmp (and outside /private/tmp on macOS). Put that
	// under $HOME — works on both platforms, cleaned up in after().
	try {
		outsideRoot = await fs.realpath(
			await fs.mkdtemp(path.join(os.homedir(), '.cloudup-test-outside-')),
		);
		outsideRootAvailable = true;
	} catch {
		// $HOME unwritable (some CI sandboxes): skip the prefix-collision test.
		outsideRootAvailable = false;
	}
});

after(async () => {
	await fs.rm(homeRoot, { recursive: true, force: true }).catch(() => {});
	await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
	if (outsideRoot) await fs.rm(outsideRoot, { recursive: true, force: true }).catch(() => {});
});

async function writeFixture(dir, name, contents) {
	const p = path.join(dir, name);
	await fs.writeFile(p, contents);
	return p;
}

// ---- resolveSafePath ---------------------------------------------------

test('resolveSafePath: accepts file under $HOME override', async () => {
	const p = await writeFixture(homeRoot, 'pic.png', PNG);
	const resolved = await resolveSafePath(p, { home: homeRoot, tmp: '/dev/null/unused' });
	assert.equal(resolved, await fs.realpath(p));
});

test('resolveSafePath: accepts file under tmp override', async () => {
	const p = await writeFixture(tmpRoot, 'pic.png', PNG);
	const resolved = await resolveSafePath(p, { home: '/dev/null/unused', tmp: tmpRoot });
	assert.equal(resolved, await fs.realpath(p));
});

test('resolveSafePath: ~ alone expands to homeDir', async () => {
	// resolveSafePath does realpath on the path but not a stat — the prefix
	// check is what we exercise here. validateUploadPath tests below cover
	// the full open-and-sniff flow.
	const resolved = await resolveSafePath('~', { home: homeRoot, tmp: '/dev/null/unused' });
	assert.equal(resolved, homeRoot);
});

test('resolveSafePath: ~/x expands relative to home override', async () => {
	const p = await writeFixture(homeRoot, 'inside.png', PNG);
	const resolved = await resolveSafePath('~/inside.png', {
		home: homeRoot,
		tmp: '/dev/null/unused',
	});
	assert.equal(resolved, await fs.realpath(p));
});

test('resolveSafePath: nonexistent path → "does not exist"', async () => {
	await assert.rejects(
		resolveSafePath(path.join(homeRoot, 'missing.png'), {
			home: homeRoot,
			tmp: '/dev/null/unused',
		}),
		/does not exist/,
	);
});

test('resolveSafePath: empty / non-string path rejects', async () => {
	await assert.rejects(resolveSafePath('', { home: homeRoot, tmp: tmpRoot }), /required/);
	await assert.rejects(resolveSafePath(null, { home: homeRoot, tmp: tmpRoot }), /required/);
});

test('resolveSafePath: /etc/hosts refused as outside both roots', async () => {
	// /etc/hosts exists on every Unix and realpath's to /etc/hosts (Linux) or
	// /private/etc/hosts (macOS). Neither is under $HOME, tmp override, or the
	// hardcoded /tmp fallback. The rejection message must mention the roots.
	await assert.rejects(
		resolveSafePath('/etc/hosts', { home: homeRoot, tmp: tmpRoot }),
		/not under \$HOME or \/tmp/,
	);
});

test('resolveSafePath: symlink escape to /etc/hosts refused after realpath', async () => {
	// Confused-deputy attack: a path that looks safe (under $HOME override)
	// but realpath's outside. Must be caught after symlink resolution.
	const linkPath = path.join(homeRoot, 'sneaky.png');
	await fs.symlink('/etc/hosts', linkPath);
	try {
		await assert.rejects(
			resolveSafePath(linkPath, { home: homeRoot, tmp: tmpRoot }),
			/not under \$HOME or \/tmp/,
		);
	} finally {
		await fs.unlink(linkPath);
	}
});

test('resolveSafePath: prefix-collision near-miss — sibling not treated as under root', async (t) => {
	if (!outsideRootAvailable) {
		t.skip('home dir not writable; cannot place fixture outside hardcoded /tmp fallback');
		return;
	}
	// Two sibling dirs that share a prefix: `safe` and `safeguard`. A file
	// under `safeguard/` must NOT be considered under `safe/` even though
	// the latter is a string prefix — isUnder() requires a separator.
	const safeDir = path.join(outsideRoot, 'safe');
	const safeguardDir = path.join(outsideRoot, 'safeguard');
	await fs.mkdir(safeDir, { recursive: true });
	await fs.mkdir(safeguardDir, { recursive: true });
	const p = await writeFixture(safeguardDir, 'pic.png', PNG);
	await assert.rejects(
		resolveSafePath(p, { home: safeDir, tmp: '/dev/null/unused' }),
		/not under \$HOME or \/tmp/,
	);
	// Sanity check: same file IS accepted when home points to safeguardDir.
	const ok = await resolveSafePath(p, { home: safeguardDir, tmp: '/dev/null/unused' });
	assert.equal(ok, await fs.realpath(p));
});

test('resolveSafePath: macOS /tmp → /private/tmp symlink handled on both sides', async () => {
	// Files mkdtemp'd under the system tmpdir realpath to platform-specific
	// locations (/private/var/... on macOS, /tmp/... on Linux). The roots are
	// realpath'd too, so the prefix check matches after symlink resolution.
	const p = await writeFixture(tmpRoot, 'on-tmp.png', PNG);
	const resolved = await resolveSafePath(p, { home: homeRoot, tmp: tmpRoot });
	assert.equal(resolved, await fs.realpath(p));
});

// ---- validateUploadPath ------------------------------------------------

test('validateUploadPath: accepts a real PNG under tmp', async () => {
	const p = await writeFixture(tmpRoot, 'real.png', PNG);
	const r = await validateUploadPath(p, {
		home: homeRoot,
		tmp: tmpRoot,
		allowedMime: 'image/*',
	});
	assert.equal(r.path, await fs.realpath(p));
	assert.equal(r.mime, 'image/png');
	assert.equal(r.size, PNG.length);
});

test('validateUploadPath: id_rsa.png exfil — text renamed to .png is refused', async () => {
	// The headline attack: an agent induced to upload ~/.ssh/id_rsa via a path
	// ending in .png. The extension is ignored; the magic-byte sniff sees text.
	const p = await writeFixture(homeRoot, 'id_rsa.png', TEXT);
	await assert.rejects(
		validateUploadPath(p, { home: homeRoot, tmp: tmpRoot, allowedMime: 'image/*' }),
		/not recognized by magic-byte sniff/,
	);
});

test('validateUploadPath: MP4 refused under default image/* allowlist', async () => {
	const p = await writeFixture(tmpRoot, 'vid.mp4', MP4);
	await assert.rejects(
		validateUploadPath(p, { home: homeRoot, tmp: tmpRoot, allowedMime: 'image/*' }),
		/detected video\/mp4.*not in the allowlist/,
	);
});

test('validateUploadPath: MP4 accepted when allowlist widened', async () => {
	const p = await writeFixture(tmpRoot, 'vid2.mp4', MP4);
	const r = await validateUploadPath(p, {
		home: homeRoot,
		tmp: tmpRoot,
		allowedMime: 'image/*,video/mp4',
	});
	assert.equal(r.mime, 'video/mp4');
});

test('validateUploadPath: empty file refused before mime sniff', async () => {
	const p = path.join(tmpRoot, 'empty.png');
	await fs.writeFile(p, Buffer.alloc(0));
	await assert.rejects(
		validateUploadPath(p, { home: homeRoot, tmp: tmpRoot, allowedMime: 'image/*' }),
		/empty file/,
	);
});

test('validateUploadPath: directory refused (not a regular file)', async () => {
	const d = path.join(tmpRoot, 'a-directory');
	await fs.mkdir(d, { recursive: true });
	await assert.rejects(
		validateUploadPath(d, { home: homeRoot, tmp: tmpRoot, allowedMime: 'image/*' }),
		/not a regular file/,
	);
});

test('validateUploadPath: symlink-escape file refused before any open', async () => {
	// Path confinement runs before the file is opened; the rejection message
	// must come from resolveSafePath, not from a later mime check.
	const linkPath = path.join(tmpRoot, 'sneaky-hosts.png');
	await fs.symlink('/etc/hosts', linkPath);
	try {
		await assert.rejects(
			validateUploadPath(linkPath, { home: homeRoot, tmp: tmpRoot, allowedMime: 'image/*' }),
			/not under \$HOME or \/tmp/,
		);
	} finally {
		await fs.unlink(linkPath);
	}
});

test('validateUploadPath: narrower image/png allowlist still refuses JPEG', async () => {
	const p = await writeFixture(tmpRoot, 'photo.jpg', JPEG);
	await assert.rejects(
		validateUploadPath(p, { home: homeRoot, tmp: tmpRoot, allowedMime: 'image/png' }),
		/detected image\/jpeg.*not in the allowlist/,
	);
});

test('validateUploadPath: HEIC accepted under default image/* allowlist', async () => {
	const p = await writeFixture(tmpRoot, 'photo.heic', HEIC);
	const r = await validateUploadPath(p, {
		home: homeRoot,
		tmp: tmpRoot,
		allowedMime: 'image/*',
	});
	assert.equal(r.mime, 'image/heic');
});
