# @cohesivity/init

Set up [Cohesivity](https://cohesivity.ai) in a project with one command:

```bash
npx @cohesivity/init
```

The installer detects every supported client independently, so one run can
configure several clients. It then creates or reuses the project's Cohesivity
tenant and updates existing project pointers. Installation has no side effects;
every effect happens only when this command runs.

## Client delivery

Plain `npx @cohesivity/init` uses each detected client's supported installation
surface. Native commands are executed as argument arrays without a shell.
Portable directories are staged and atomically replaced.

| detected client | delivery |
| --- | --- |
| Claude | `claude plugin marketplace add <verified-local-root> --scope user`, then `claude plugin install cohesivity@cohesivity --scope user` |
| Cursor | atomically copy the portable plugin to `~/.cursor/plugins/local/cohesivity` |
| Codex | `codex plugin marketplace add <verified-local-marketplace>`, then `codex plugin add cohesivity@cohesivity` |
| Gemini | `gemini extensions install <verified-local-gemini-root> --consent` |
| Antigravity | `agy plugin install <verified-local-root>`; if `agy` is absent, atomically copy to `~/.gemini/config/plugins/cohesivity` only when an Antigravity-specific home is present |
| OpenClaw | `openclaw plugins install <verified-local-portable-root> --force`, then enable `cohesivity` |
| Hermes | atomically copy to `~/.hermes/plugins/cohesivity`, then `hermes plugins enable cohesivity` |

Detection is additive rather than first-match-wins. A Claude home does not stop
Cursor, Codex, Gemini, Antigravity, OpenClaw, or Hermes from also being
configured. A shared `~/.gemini` directory alone is not treated as positive
Antigravity detection.

Known adapters without a Cohesivity plugin package receive the canonical
standalone skill plus the remote MCP endpoint
`https://cohesivity.ai/mcp/manage`, configured through the adapter's documented
native command. The installer currently supports this fallback for GitHub
Copilot CLI, VS Code, Cline CLI, and Grok. It does not modify JSON, TOML, or YAML
configuration with regular expressions.

The installer never starts OAuth or opens a browser. It prints the relevant
restart and authentication steps after delivery. Hermes remote MCP OAuth is
qualified: automatic login works only when the endpoint supports Dynamic Client
Registration; otherwise Hermes needs a pre-registered OAuth client.

## Standalone skill only

Use `--no-plugin` when plugins and MCP configuration are unwanted:

```bash
npx @cohesivity/init --no-plugin
```

This installs only the canonical skill at
`~/.agents/skills/cohesivity/SKILL.md`. It installs no client plugin and adds no
MCP server. Tenant creation, machine attribution, `.gitignore`, `.cohesivity`,
and existing project pointers follow the same flow as plain init.

## Verified plugin artifacts

Plugin delivery begins with one immutable, pinned manifest. The installer
checks the manifest's exact byte size and SHA-256 before parsing it, then checks
the exact byte size and SHA-256 of every selected artifact before extraction.
These checks apply to the decoded response bytes: HTTP transfer `Content-Length`
can describe compressed bytes and is not used as a decoded-size claim. Reads
stop as soon as decoded content exceeds its pin, before hashing or parsing.
The manifest schema is:

```json
{
  "schema_version": 1,
  "version": "2.1.2",
  "packages": [
    {
      "client": "portable",
      "immutable_url": "https://immutable.example/portable.tar.gz",
      "size": 1234,
      "sha256": "64 lowercase hexadecimal characters",
      "archive": "cohesivity-portable-2.1.2.tar.gz"
    }
  ]
}
```

The installer maps Claude to `claude`; Cursor, OpenClaw, and Hermes to
`portable`; Codex to `codex`; Gemini to `gemini`; and Antigravity to
`antigravity`. The 2.1.2 manifest also carries the direct `openai` package,
which this marketplace-based Codex installer does not select. Extraction
rejects absolute paths, traversal, links, duplicate paths, special files,
malformed headers, oversized content, and archives without an end marker.
Staged portable installs replace the previous directory atomically, with
rollback if the commit fails.

The immutable manifest commit, byte size, and SHA-256 are isolated in the
`PLUGIN_RELEASE` block in `bin/cli.js`. Tests use the
`COHESIVITY_PLUGIN_MANIFEST_PIN` injection hook with local, fully pinned
fixtures; normal users should not set it.

## Tenant bootstrap and failure behavior

After client delivery, the command:

1. Ensures `.cohesivity` is ignored before requesting credentials.
2. Creates a tenant with `POST /api/genesis`, or validates and reuses an
   existing `.cohesivity`.
3. Atomically installs complete credentials only after validating the tenant,
   management key, application key, expiry, lifecycle, and runtime profile.
4. Stores a server-issued opaque setup identifier at
   `~/.config/cohesivity/machine-id` so tenants created by one setup can be
   grouped.
5. Adds or updates a managed Cohesivity block in existing `AGENTS.md`,
   `CLAUDE.md`, and `README.md` files. It never creates those files.

A plugin download, verification, extraction, copy, or native-command failure
does not skip tenant bootstrap. The command still completes the idempotent
tenant flow and project pointers, then exits nonzero, identifies every failed
delivery, and says installation is incomplete. It never prints the normal
complete-installation message in that state.

Tenant failures remain fail-closed. Network, HTTP, incomplete-response,
credential-validation, and ignore-write failures exit nonzero without project
pointers or a false success message. Existing incomplete credentials are never
overwritten.

## Dry run

`--dry-run` has zero side effects. It performs no fetch, tenant request, native
command, directory creation, file write, OAuth, or browser action. It detects
clients using filesystem/PATH reads and prints the exact manifest checks,
artifact checks, native argument-vector commands, atomic destinations, tenant
request, and project-pointer changes it would perform.

## Attribution and privacy

The tenant request identifies the coding agent that launched the command. The
installer walks only its own parent-process lineage and sends one sanitized name
as `{npx:<name>}`. If it cannot infer a name, it sends `{npx:none}`. `--runtime`
overrides that label when measurement is wrong.

It never enumerates the system process table: no session logs, conversations,
or model settings are read, nor files outside the documented client homes,
project bootstrap files, and machine-id path. The machine id is opaque,
server-issued, and not derived from hardware or user data. Delete
`~/.config/cohesivity/machine-id` to end that association.

## Options

| flag | effect |
| --- | --- |
| `--runtime <name>` | override the measured harness label |
| `--no-plugin` | install only the canonical standalone skill; add no plugin or MCP |
| `--dry-run` | print exact actions with zero side effects |
| `--base <url>` | API base for tenant bootstrap (default `https://cohesivity.ai`) |
| `-h`, `--help` | show command help and the exact package version |

## 0.6.2 status projection pin

Version 0.6.2 pins Cohesivity plugin 2.1.2. Its local `tenant_status` tool
preserves the Management API's bounded `resource_name` and scalar `status`
while continuing to exclude credentials, connection details, provider
metadata, URLs, and arbitrary nested input.

## 0.6.1 verification fixes

Version 0.6.1 accepts an immutable manifest when Node has transparently decoded
its gzip transfer and the decoded bytes match the size and SHA-256 pins. It
still rejects decoded oversize, size mismatch, and hash mismatch, pins the final
Cohesivity plugin 2.1.1 manifest, and makes `--help` identify the exact
CLI/package version.

## Verifying the release

Every npm version publishes from this repository through npm Trusted Publishing
with provenance:

```bash
npm audit signatures
```

Node.js 18+ is required for built-in `fetch`. The package has zero dependencies
and no `postinstall` hook.

Full product documentation: <https://cohesivity.ai/llms.txt>
