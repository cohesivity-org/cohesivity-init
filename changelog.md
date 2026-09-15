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
