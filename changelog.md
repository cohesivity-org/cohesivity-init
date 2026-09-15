# Changelog

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
