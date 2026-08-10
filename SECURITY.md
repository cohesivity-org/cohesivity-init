# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to
[accounts@cohesivity.ai](mailto:accounts@cohesivity.ai). Include:

- the affected package version (`npx @cohesivity/init --help` prints it) or commit;
- the behavior you observed and its security impact;
- minimal reproduction steps; and
- any suggested mitigation.

Do not open a public issue for an unpatched vulnerability. Do not include live
`coh_management_key`, `coh_application_key`, wait tokens, tenant data, or other
secrets in a report. If a credential may have been exposed, stop using it and
include only a redacted prefix or tenant identifier in the report.

## Verifying what you run

This package installs nothing and runs no `postinstall` hook. Every effect
happens when you invoke the command, and `bin/cli.js` is the only file that
ships.

Releases publish from `.github/workflows/release.yml` through npm Trusted
Publishing, so each version carries a signed provenance attestation linking the
tarball to the commit and workflow that built it:

```bash
npm view @cohesivity/init dist.attestations
npm audit signatures
```

If a published version has no provenance, or its provenance points at a
repository other than `cohesivity-org/cohesivity-init`, treat it as
untrusted and report it.

Client plugins are fetched only through the immutable manifest pin in
`bin/cli.js`. The command verifies the pinned manifest byte size and SHA-256,
then verifies each selected artifact's manifest-pinned byte size and SHA-256
before extraction. Size verification uses the decoded response body rather than
the HTTP transfer `Content-Length`, which can describe compressed bytes, and the
bounded reader stops when decoded content exceeds its pin. Extraction rejects
traversal, absolute paths, links, special files, duplicate paths, malformed
headers, and oversized content. Portable installs are staged and atomically
replaced; native client commands run without a shell.

`COHESIVITY_PLUGIN_MANIFEST_PIN` is a test injection hook and a trust-boundary
override. Do not set it when running a published release. Repository tests use
it only with local deterministic fixtures whose manifest and artifacts are
fully pinned.

## Supported version

Security fixes target the latest published version. Older versions are not
patched in place.
