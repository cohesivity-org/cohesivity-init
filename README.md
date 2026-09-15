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
| Gemini | first run: `gemini extensions install <verified-local-gemini-root> --consent`; rerun: `gemini extensions update cohesivity` |
| Antigravity | `agy plugin install <verified-local-root>`; if `agy` is absent, atomically copy to `~/.gemini/config/plugins/cohesivity` only when an Antigravity-specific home is present |
| OpenClaw | install `cohesivity` through the verified Claude marketplace root, enable it, then save the remote Streamable HTTP OAuth MCP |
| Hermes | install the canonical skill and local server in Hermes-owned paths, import both MCP entries through `hermes import-agent ... --overwrite --yes`, then set the two enabled flags and dormant OAuth metadata with `hermes config set` |
| OpenCode | preserve the verified portable package, install its skill to `~/.agents/skills/cohesivity`, then use `opencode mcp add` for the local four-tool server and remote management server |

Detection is additive rather than first-match-wins. A Claude home does not stop
Cursor, Codex, Gemini, Antigravity, OpenClaw, Hermes, or OpenCode from also being
configured. A shared `~/.gemini` directory alone is not treated as positive
Antigravity detection. Claude, Codex, Gemini, OpenClaw, Hermes, OpenCode, and
fallback adapters require their executable; stale configuration homes are not
installation evidence. Cursor's client-owned home and Antigravity's documented
product-specific homes remain positive contracts for their desktop surfaces.
The measured harness label is attribution only and never selects a delivery
adapter.

Known adapters without a Cohesivity plugin package receive the canonical
standalone skill plus the remote MCP endpoint
`https://cohesivity.ai/mcp/manage`, configured through the adapter's documented
native command. The installer currently supports this fallback for GitHub
Copilot CLI, VS Code, Cline CLI, and Grok. It does not modify JSON, TOML, or YAML
configuration with regular expressions.

The installer never starts OAuth or opens a browser. It prints the relevant
restart and authentication steps after delivery. Three MCP surfaces have
different boundaries: the public documentation server at
`https://cohesivity.ai/mcp` needs no login, the installed local project-bootstrap
server needs no login, and `https://cohesivity.ai/mcp/manage` requires OAuth for
account-scoped management. OpenCode users start that last flow explicitly with
`opencode mcp auth cohesivity`. Hermes uses the exact native server name
`cohesivity`; `hermes mcp login cohesivity` starts its management OAuth flow.
The Cohesivity endpoint advertises Dynamic Client Registration, so Hermes does
not need a pre-registered OAuth client.

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
  "version": "3.0.5",
  "packages": [
    {
      "client": "portable",
      "immutable_url": "https://immutable.example/portable.tar.gz",
      "size": 1234,
      "sha256": "64 lowercase hexadecimal characters",
      "archive": "cohesivity-portable-3.0.5.tar.gz"
    }
  ]
}
```

The installer maps Claude and OpenClaw to `claude`; Cursor and Hermes to
`portable`; Codex to `codex`; Gemini to `gemini`; and Antigravity to
`antigravity`. The 3.0.5 manifest also carries the direct `openai` package,
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

## 0.7.0 four-tool bootstrap interface

Version 0.7.0 pins the published Cohesivity plugin 3.0.5. This is a breaking
change from 0.6.7's six-tool local interface: the installed server exposes only
`create_tenant`, `claim_tenant`, `tenant_status`, and `provision_resource`.
Single and bulk provisioning share `provision_resource`, replacing the separate
`bulk_provision_resources` tool. Deprovisioning is outside the four-tool MCP
interface; do not bypass the skill's MCP-only control-plane mutation policy
with direct HTTP requests.

Mutating local tool calls now require literal `confirmed: true`, an argument
that plugin 2.1.5 did not accept. Pass it only when the current user request
explicitly authorizes the exact action; otherwise ask first. Client adapters,
initializer tenant bootstrap, and OAuth handling are unchanged. The remote
management connection keeps its existing URL; this npm release does not deploy
the hosted server.

Standalone and fallback skill installs now pin
`cohesivity-org/cohesivity-skill@78d6d26c09ea955e2ab2392a62d980817bcabb39`
(metadata version `2923f0623a63`), matching the canonical skill in plugin 3.0.5.
Those published skill bytes still name `@cohesivity/init@0.6.6` as their
no-MCP fallback; this release does not rewrite upstream skill content.

## 0.6.7 local MCP metadata compatibility

Version 0.6.7 pins Cohesivity plugin 2.1.5. Its local MCP accepts optional
object-valued `params._meta` on tool calls without forwarding or reflecting it.
The six-tool v2 interface, confirmation behavior, client adapters, and canonical
skill pin are unchanged. Tool arguments remain strictly validated.

## 0.6.6 released Hermes adapter

Version 0.6.6 replaces portable-plugin enablement with surfaces shipped by the
immutable Hermes 0.20.0 release. It keeps plugin 2.1.4's verified local server in
Hermes's native MCP directory, installs the canonical skill in its skill directory,
and feeds the local and remote entries through Hermes's own noninteractive
Claude import and structural config commands. Reruns overwrite only the two
Cohesivity MCP names, preserve unrelated Hermes settings, verify the exact
persisted command/URL/auth values, and never start OAuth.

## 0.6.5 OpenCode and repeat-safe Gemini delivery

Version 0.6.5 recognizes OpenCode only from its executable, preserves the
verified portable package under the Cohesivity data directory, installs the
canonical skill in OpenCode's documented global `~/.agents/skills` surface, and
uses OpenCode's native noninteractive `mcp add` commands for both the local
six-tool server and exact remote management endpoint. Reruns replace those
entries structurally through OpenCode's own JSONC-aware config writer and never
start OAuth.

Gemini now installs the extension on the first run and uses
`gemini extensions update cohesivity` once the native installed-extension
directory exists. Both child commands scope `GEMINI_CLI_TRUST_WORKSPACE=true`
to that process, so a repeat run succeeds without writing a persistent broad
workspace-trust setting. Stale client configuration homes no longer count as
installed executable-backed clients.

## 0.6.4 durable native marketplaces

Version 0.6.4 copies each verified native-client package to
`${XDG_DATA_HOME:-~/.local/share}/cohesivity/plugin-packages/<client>` before
invoking Claude, Codex, Gemini, Antigravity, or OpenClaw. Those clients may
retain the source path in their marketplace or extension configuration, so the
installer never points them at extraction directories it deletes on exit.
It pins Cohesivity plugin 2.1.4 and accepts Gemini's native workspace trust
prompt only for the extension-install child process without writing a global
trust override.

OpenClaw receives the verified Claude marketplace bundle through its documented
marketplace adapter, which preserves the `cohesivity` identity and projects the
skill and local MCP server. The installer also saves the remote server through
`openclaw mcp set` with Streamable HTTP and OAuth, without starting login.

Hermes qualifies portable MCP server names from the discovered install
identity. On restart, copy the exact qualified remote name Hermes reports into
a native `mcp_servers` owner override that repeats the Cohesivity URL and sets
`auth: oauth`, then run `hermes mcp login <qualified-server-name>`. Do not use
the unqualified package name; Hermes owner config replaces rather than augments
the portable entry.

## 0.6.3 MCP release metadata

Version 0.6.3 pins Cohesivity plugin 2.1.3. Its local MCP initialization,
User-Agent, generated client manifests, archive names, and package metadata all
derive from one release version and report `2.1.3` consistently.

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

### Check installer delivery drift

Before tagging an initializer release, compare its source candidate with the
published shell installer and canonical skill:

```bash
node scripts/verify-release.mjs --source bin/cli.js
```

After npm publication, run the same check against the actual npm `latest`
tarball, rather than the checkout:

```bash
node scripts/verify-release.mjs
```

Both commands are read-only: they download public artifacts without running an
installer, configuring clients, creating tenants, or starting OAuth. They verify
npm tarball integrity and plugin size/hash pins, then compare plugin versions,
standalone skill URLs and bytes, and the six packaged client skills across npm
and quickstart. Claude has an intentional skill adapter, so its two deliveries
must match each other; the other five client skills must also match the live
`https://cohesivity.ai/skill.md`. Different archive commits are allowed when the
release version and delivered skill bytes agree.

`node --test` includes offline comparison regressions and a recorded delivery
snapshot. When changing release pins, refresh that snapshot only after the
candidate passes the live check, then review its immutable URLs and hashes:

```bash
node scripts/verify-release.mjs --source bin/cli.js \
  --snapshot tests/fixtures/release-observation.json
node --test
```

The snapshot catches source pin changes that have not been checked against the
other delivery path. Offline unit tests cannot detect a later independent npm,
quickstart, or canonical-skill publication; the live checks above are required
release verification. They are not automatically added to CI by this change.
A mismatch exits nonzero and does not rewrite any release pin. Publication of
0.7.0 remains a separate release step; an unmerged PR does not update npm.

This comparison covers the skill bytes delivered by each installer. It does not
rewrite package versions mentioned inside the canonical skill (currently its
older no-MCP fallback), test native client behavior, or change mutation consent.

Node.js 18+ is required for built-in `fetch`. The package has zero dependencies
and no `postinstall` hook.

Full product documentation: <https://cohesivity.ai/llms.txt>
