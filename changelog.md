# Changelog

## 2026-09-18 — Bump skill pin for MCP mutation fix

Update `SKILL_PIN` from `dea8889b` to `bf7cd4e1` (cohesivity-skill PR #10).
The installed standalone skill now allows direct HTTP for control-plane
mutations when MCP is unavailable. Consent rules unchanged. Updated the
release observation fixture to match the new canonical skill bytes
(20663 bytes, sha256 `be4adbeb`). No installer behavior change; this is
a pin-only update. 65/65 tests pass.

### CICD classification
Installer release inputs only. No npm publication in this PR.

## 2026-09-17 — Release 0.8.2

Bump version from 0.8.1 to 0.8.2 for the `--tenant-only` flag added in the
previous commit. No code changes beyond the version constants and test pin.

## 2026-09-17 — Add undocumented --tenant-only flag

### What changed
Accept `--tenant-only` in the arg validator. When set, skip all delivery — no
standalone skill, no plugin, no MCP configuration. Tenant creation, machine-id
attribution, project file pointers, and gitignore are unchanged.

The flag is intentionally absent from `--help` and the README. Third-party
integration skills (e.g. Agentty Sites) reference it to bootstrap a tenant
without installing the broader Cohesivity skill on the user's machine. Agents
calling the normal `npx @cohesivity/init` flow still get the full delivery.

### CICD classification
npm installer source change. No hosted runtime deployment, workflow change,
release tag, or npm publication in this PR.

### Verification
51/51 tests pass, including two new tests: one proving that `--tenant-only`
creates a tenant with attribution but no skill/plugin, and one proving the
flag does not appear in `--help` output.

## 2026-09-15 — Pin the v2 MCP metadata patch in init 0.6.7

### Why
COH-276 identified local MCP tool-call failures when a client includes optional
request metadata. npm remains on the six-tool v2 plugin contract, so this patch
pins plugin 2.1.5 rather than migrating initializer users to v3.

### What changed
- Bump package and CLI versions from 0.6.6 to 0.6.7.
- Pin the final 2.1.5 manifest at plugin commit
  `f1b3e82d57a2df873aa3486152d6073606f635dc`, with 9,610 bytes and SHA-256
  `3e70241b60f23af3893c98845f809cfcefe340c7c3ad452fd82fdeac0a373ece`.
- Update the pin regression and current-release documentation. Preserve client
  adapters, the canonical skill pin, and the v2 confirmation behavior.

### CICD classification
Docs / scripts / metadata under `docs/CICD.md`; npm installer release inputs.
No hosted runtime deployment, workflow changes, release tag, or npm publication.
The plugin v2 PR should be reviewed and merged before the initializer release.

### Verification
- Confirmed npm and initializer main both reported 0.6.6 before the patch.
- The updated immutable-pin regression failed before the implementation change.
- Node 24 and Node 18: all 49 tests pass; CLI syntax validation passes.
- HTTP retrieval verifies the exact pinned manifest bytes and all six immutable
  archives against their sizes, SHA-256 hashes, and local release bytes.
- `npm pack` produces the expected four files. Packed CLI and package metadata
  match the worktree; packed `--help` reports 0.6.7.
- `git diff --check` passes. Tests use temporary homes and mocked endpoints;
  no real tenants or native client installations are involved.

### Rollback
Retain init 0.6.6 and its plugin 2.1.4 pin. Existing immutable release assets
remain unchanged.

Refs COH-276.

## 2026-09-15 — Clarify the shared CI/CD policy reference

### Why
The preceding entry's `docs/CICD.md` refers to the sibling documentation
repository, not a path inside this initializer repository.

### What changed
The shared policy is [cohesivity-org/docs: CICD.md](https://github.com/cohesivity-org/docs/blob/main/CICD.md).
This appended clarification preserves the earlier changelog entry.

### CICD classification
Docs-only clarification; no code, package, release pin, or plugin changes.

### Verification
- Confirmed `CICD.md` is tracked in the sibling documentation checkout.
- All 49 initializer tests and `git diff --check` pass.

Refs COH-276.

## 2026-09-15 — Move init 0.7.0 to the four-tool plugin

### Why
The selected contract is four bootstrap tools for both local and hosted MCP,
superseding the earlier decision to keep npm on the six-tool v2 plugin. Moving
from plugin 2.1.5 to 3.0.5 removes local tool names and requires the new
`confirmed: true` argument on mutations, so this initializer release advances
from 0.6.7 to 0.7.0 rather than shipping another patch.

### What changed
- Update the package and CLI version to 0.7.0 and pin the already-published
  plugin 3.0.5 manifest at `a10fde6309d99c5102d72acd867239eb40844c46`:
  9,400 bytes, SHA-256
  `f2ed554af17a5218d438869b6221d692de1678303fe9525f4d8f4bd79a191e30`.
  Its immutable archive source is `49e9458d319ec0e7d8a7b47c7a859dedbfaef7f4`.
- Align the standalone skill with plugin 3.0.5's documented upstream commit
  `78d6d26c09ea955e2ab2392a62d980817bcabb39`, metadata version `2923f0623a63`.
  Its 14,616 public bytes match the plugin's canonical skill SHA-256
  `f995c85b94ac5198eb0bdb45c7847d76092f7905cb6d7802e5e0caa6c2d8e502`.
- Update release regressions and README migration guidance. Bulk provisioning
  moves to `provision_resource`; deprovisioning is outside the four-tool MCP.
  Local mutations now require literal `confirmed: true`, which v2.1.5 did not
  accept. Direct control-plane mutations remain prohibited by the published
  skill; the migration guidance does not offer an HTTP bypass.
- Adapters, neutral delivery fixtures, OAuth handling, and initializer tenant
  bootstrap remain unchanged. The upstream skill's pinned init 0.6.6 no-MCP
  fallback is documented but not rewritten; no upstream plugin or skill
  artifacts or safety-policy changes are authored here.

### CICD classification
Docs / scripts / metadata under [cohesivity-org/docs: CICD.md](https://github.com/cohesivity-org/docs/blob/main/CICD.md);
npm installer release inputs only. This change does not deploy the hosted MCP,
publish npm, create a release tag, or change workflows. Hosted four-tool delivery
is handled separately in core PR #436.

### Verification
- The package-version, skill-pin, and plugin-pin regressions all failed before
  implementation; `node --check bin/cli.js` and `node --test` pass on Node
  18.20.8, 22.23.2, and 24.18.0, with all 49 tests passing on each version.
- Public HTTP retrieval verified the manifest and all six immutable archives
  against their exact byte sizes and SHA-256 hashes. A scratch harness exercised
  the initializer's verified extraction against those cached public bytes and
  checked every manifest file pin. Each extracted server reports 3.0.5 and only
  `create_tenant`, `claim_tenant`, `tenant_status`, and `provision_resource` on
  Node 18 and 24; initialize, discovery, and ping create no project files.
- `npm pack` contains only LICENSE, README.md, bin/cli.js, and package.json;
  packed CLI/package bytes match the worktree and packed `--help` reports 0.7.0.
- `git diff --check` passes. Tests use temporary homes and mocked endpoints;
  no production tenant, native-client installation, or OAuth session is changed.

### Rollback
Retain init 0.6.7 with its plugin 2.1.5 and prior standalone-skill pins. Existing
immutable assets are unchanged; this does not roll back the hosted MCP.

## 2026-09-15 — Check drift between installer deliveries

### Why
Published init 0.6.7 consistently installs plugin 2.1.5 and its matching older
skill, while the shell quickstart delivers plugin 3.0.5 and the current skill.
Internal npm pin assertions cannot catch that disagreement. PR #30 already
aligns the initializer's release inputs in 0.7.0; this companion adds verification
without duplicating that migration or publishing it.

### What changed
- Add `scripts/verify-release.mjs`: a read-only comparison of the actual npm
  `latest` tarball, live quickstart, canonical skill, and all six client plugin
  artifacts. Verify archive/manifest integrity before comparing their versions
  and delivered skill bytes. `--source` checks a candidate before publication.
- Keep Claude's intentionally adapted skill distinct from the canonical skill,
  but require exact agreement between npm and quickstart Claude packages.
- Add offline unit regressions for internally consistent stale npm, both paths
  lagging canonical content, same-version client drift, missing clients, invalid
  pins, and malformed archives. Record the independently verified source
  candidate observation in `tests/fixtures/release-observation.json`.
- Document snapshot refresh and before/after-publication checks. The unit suite
  does not claim to detect subsequent live releases without running that check.
  No installer, skill policy, native adapter, or CI workflow is changed here.

### CICD classification
Docs / scripts / metadata per the sibling docs `CICD.md`. This is stacked on
initializer PR #30 and changes no runtime, release pointer, deployment, or npm
publication. The existing tag-triggered publication remains separately required.

### Verification
- The new unit file failed before the verifier existed, then passed with the
  implementation. Focused tests exercise matching and mismatched release inputs.
- Read-only live verification passes for PR #30's init 0.7.0 source: plugin
  3.0.5 and all six client skill deliveries match quickstart; the five unadapted
  skills match the canonical SHA-256
  `f995c85b94ac5198eb0bdb45c7847d76092f7905cb6d7802e5e0caa6c2d8e502`.
- The same command against published npm latest fails as expected, detecting
  plugin 2.1.5 versus 3.0.5 and the old standalone/client skills. No tenant,
  client configuration, or authentication state was created or changed.
- All 58 tests pass with `node --test`; verifier syntax and `git diff --check`
  pass on Node 24.8.0.

## 2026-09-15 — Verify packaged client versions

### Why
Greptile identified that the release comparison trusted the npm manifest's
aggregate version. An older client archive with unchanged skill bytes could
pass that check, and the offline observation did not bind the installer version.

### What changed
- Read each downloaded client's own metadata and MCP `SERVER_VERSION`, require
  them to agree, and compare them with the release version for npm and quickstart.
  Antigravity's manifest intentionally omits a version, so use its packaged MCP
  version. Do not execute the packaged code.
- Record those client versions in the refreshed observation and bind its
  installer version in the source regression. Add tests for an old client hidden
  behind a current manifest, missing versions, and disagreeing metadata/server
  versions; document the Antigravity exception.

### CICD classification
Docs / scripts / tests only. No installer behavior, consent policy, CI workflow,
publication, runtime release, or deployment changes.

### Verification
- New version regressions failed before implementation and pass after it.
- The live 0.7.0 source comparison passes with every client reporting 3.0.5.
- All 60 tests and `git diff --check` pass locally on Node 24.8.0.

## 2026-09-15 — Share verification with quickstart source checks

### Why
The user requested drift protection in both installer repositories. The main
Cohesivity repository must verify its rendered quickstart and canonical skill
before deployment, using the same comparison logic and observation as init.

### What changed
- Add optional `--quickstart-source` and `--skill-source` inputs to the shared
  verifier. Explicit missing source files fail before any network access;
  immutable plugin and standalone artifacts still undergo their normal checks.
- Expose the artifact downloader as a test dependency and record which inputs
  were source candidates. Add offline tests for missing files and replacement
  of deployed-document requests, without changing installer delivery or CI.
- Document the main repository's pinned vendoring of this verifier and snapshot.

### CICD classification
Docs / scripts / tests only. No release tag, npm publication, deployment,
consent policy, or tenant-facing behavior changes.

### Verification
- New source-override tests failed before implementation, then passed.
- All 63 tests pass locally on Node 24.8.0. No installer or tenant mutations ran.

## 2026-09-16 — Deliver four-tool skill guidance in init 0.7.1

### What changed

Pin plugin 3.0.6 manifest `e157d473a8e60531572fd29ccfd2314bd6e2983a`
(9,400 bytes, SHA-256
`a295d7b318077a935ae9b0469916f8213a8cdf27b8c9bf7ee604d3007ca06495`)
and generated skill mirror `1c65e6d1bf4690d7ee3b046bcd8251387b4f701b`.
Skill `d309e051978d` lists the four supported tools, requires human handoff for
unsupported mutations, removes obsolete tool instructions, and pins this
initializer as the no-MCP fallback. The package and CLI versions advance
together; initializer behavior and client adapters are unchanged.

Regenerate the shared release observation with the existing verifier against
the rendered core candidates and publicly retrievable immutable skill/plugin
artifacts. The observation is not manually edited and the verifier is unchanged.
The core repository must vendor this committed observation in its matching PR.

### CICD classification

Installer release inputs, documentation, and tests under `docs/CICD.md`.
Initializer 0.7.0 has already been published; this 0.7.1 candidate is a separate
coordinated core/plugin/skill release and remains pending review. No release
tag or npm publication is performed by this commit.

### Verification

Version, skill-pin, and manifest-pin regressions failed before implementation.
All 63 tests and CLI syntax checks pass on Node 18.20.8, 22.23.2, and 24.18.0.
The candidate verifier confirms plugin 3.0.6 and all six client skill deliveries
match the generated canonical candidate and quickstart, with artifact size/hash
checks intact. `npm pack` contains the expected four files for 0.7.1, and
`git diff --check` passes. No installer, client setup, or tenant creation ran.

## 2026-09-16 — Clarify coordinated snapshot verification

The `docs/CICD.md` reference in the preceding entry means the sibling
[cohesivity-org/docs release playbook](https://github.com/cohesivity-org/docs/blob/main/CICD.md),
not a file in this repository. This is documentation-only work.

README now shows all three source inputs used to generate the coordinated
observation, explains invocation flags and timestamps, and requires publishing
the pinned fallback before its skill goes live. Repeating that command against
the candidate sources reproduces every observation field except the new
timestamp. The committed observation, verifier, and release pins are unchanged;
all 63 tests and `git diff --check` pass.

## 2026-09-16 — Pin optional MCP account access

### What changed

Initializer 0.8.0 installs plugin 4.0.0 from manifest commit
`a3100ee07ab19168901dd15b58ed5c200dd585a7` and standalone skill commit
`cb3b6be6ad8a0e9ce27fef5a1fb30ead39430981`. The plugin adds full quickstart
bootstrap and optional local account login; its matching hosted flow supports
guest/account access and protected credential downloads. The initializer's own
guest tenant bootstrap is unchanged and does not consume local MCP auth state.
README describes that distinction and the coordinated Worker dependency.

### CICD classification

Installer release inputs, docs, and tests under the sibling
`cohesivity-org/docs` CICD playbook. Version 0.8.0 is an unpublished candidate.
Publish it before serving the skill's matching fallback pin; do not call the
account flow live until the coordinated Worker release completes.

### Verification

All three pin regressions failed before implementation. The shared verifier
downloaded the real immutable manifest, archives, and standalone skill, then
regenerated `tests/fixtures/release-observation.json` against rendered candidate
quickstart and skill sources. All six client deliveries agree on plugin 4.0.0
and the canonical/adapted skill bytes. All 63 tests pass on Node 18.20.8 and
24.18.0. CLI syntax, `git diff --check`, and `npm pack --dry-run` pass; the npm
package contains only the expected four files. No npm publication, real client
setup, account login, or tenant creation ran.

## 2026-09-17 — Pin hosted credential file handoff

Keep initializer 0.8.0 as the unpublished candidate and update it to plugin
4.0.1 manifest commit `3552aff2` and skill mirror `27e41382`. The installed
guidance makes the calling agent save the hosted creation result directly to
`.cohesivity`; browser download is optional. The initializer's own guest flow
is unchanged.

The shared verifier downloaded and checked the immutable artifacts before
regenerating the release observation. All six client deliveries match the
rendered quickstart and canonical candidate. All 63 tests pass on Node
18.20.8 and 24.18.0; CLI syntax and whitespace checks pass. This is an installer
release-input update under sibling CICD guidance, with no npm publication.

## 2026-09-17 — Deliver MCP connection and local reuse fixes

Initializer 0.8.1 pins plugin 4.0.2 manifest `81845011` and generated skill
`ac6c3a29928f` from mirror `dea8889b`. Local project reuse no longer loads
optional saved account tokens, IPv6 loopback callbacks pass validation, and
Connect guidance never asks the user to choose whether to sign in. The
initializer's own bootstrap behavior is unchanged.

The shared release verifier downloaded the immutable manifest, all six client
archives, the repository archive, and skill bytes before refreshing the release
observation against the rendered core candidate. All 63 tests, CLI syntax,
whitespace checks, and npm package dry-run pass. This installer release must
publish before the matching core, plugin, and skill guidance is merged; it
does not itself deploy hosted MCP.
