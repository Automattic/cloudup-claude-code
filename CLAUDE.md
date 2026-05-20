# Notes for agents working on this repo

## Bump the plugin version on every user-visible PR

Claude Code's plugin install cache lives under
`~/.claude/plugins/cache/cloudup-claude-code/cloudup/<version>/`. The
directory name is the version string from `.claude-plugin/plugin.json`. If
the version doesn't change between releases, installers reuse the cached
copy from their previous install of "the same version" — so a user who
already had `0.5.0` cached will *not* get new content when we ship more
code under the same `0.5.0` label. The cache only refreshes on a version
string change.

**Practical effect:** if you merge a PR that touches anything users will
see (scripts, hooks, skills, commands, README guidance) without bumping
the version, every existing installer is stuck on stale code until they
manually clear their cache. Bug reports about "I installed the plugin
but the new tool isn't there" almost always trace back to this.

### Rule

When merging a PR that changes any of:

- `scripts/` (especially `cloudup-server.sh`)
- `hooks/`
- `skills/`
- `commands/`
- behavior the user can observe (new env vars, new tools, changed
  routing, changed safeguards, changed setup steps)

…bump the version in **both** files:

1. `.claude-plugin/plugin.json` — `version` field.
2. `.claude-plugin/marketplace.json` — the `plugins[].version` for `cloudup`.

Both must stay in sync; the marketplace one is what the installer reads,
and the plugin one is what shows up in plugin metadata. A mismatch
between them is a footgun (the installer may pick one and the runtime
the other).

Then add a `## Version` section entry at the top of `README.md` with the
new version string and a short bullet list of what changed (look at the
existing entries — `0.5.0`, `0.4.0`, etc. — for the shape).

### When NOT to bump

Pure-internal changes that no installed user can observe:

- Test-only changes (`test/`, fixtures).
- Comments, internal refactors with identical observable behavior.
- CI / repo metadata (`.github/`, this file, etc.).
- Trunk-only docs that aren't shipped (e.g. design notes, plan docs).

If in doubt, bump. The cost of an unnecessary version bump is one extra
cache entry on installers' machines; the cost of a missed bump is users
running broken code and pinging you about it.

### Semver-ish convention

Look at existing version entries for tone. Roughly:

- **Minor bump** (0.5.0 → 0.6.0): new functionality, new tools, new
  setup paths, meaningfully changed behavior.
- **Patch bump** (0.5.0 → 0.5.1): bug fix, doc correction, small
  behavior tweak with no API change.
- **Major bump** (0.x → 1.x): currently no semantic meaning; we're pre-1.0.

PRs that touch multiple things can roll up into one bump — describe each
change as its own bullet in the README Version entry.
