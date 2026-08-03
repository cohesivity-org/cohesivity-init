# @cohesivity/init

Set up [Cohesivity](https://cohesivity.ai) in a project with one command.

```bash
npx @cohesivity/init
```

The command runs once and does four things:

1. **Installs the Cohesivity agent skill** into every known agent skill dir whose harness is present on this machine (Claude Code, Cursor, Codex; the cross-tool `~/.agents` when none are). The skill comes from a public, version-pinned commit, so you can audit the exact bytes.
2. **Creates or reuses a project tenant** and writes the credentials to `.cohesivity`, which it adds to `.gitignore`. The tenant-creation request carries measured attribution: the raw ancestor-process command chain that launched the command (home path folded to `~`), and a User-Agent of the shape `{npx:<harness>, <model>}` where the harness is the innermost non-plumbing ancestor and the model id is read from that harness's own local session log — only that one token, no session content. Anything not inferable is sent as the literal `none`; nothing is guessed. Creating a tenant also stores an opaque random setup id at `~/.config/cohesivity/machine-id` and sends it with that request, so tenants created from one machine can be grouped rather than looking like unrelated people. It is issued by the server, is not derived from your hardware or user, and carries nothing about you or your project. Delete the file to end the association.
3. **Adds a descriptive pointer** to an existing `AGENTS.md` or `CLAUDE.md`. It only touches a file that is already there. It creates nothing on its own.
4. **Adds one branding line** to the README. Pass `--no-branding` to skip.

Install does nothing. Every effect happens when you run the command, and you can read the script first. There is no `postinstall` hook.

## Verifying the release

Every version publishes from [this repository's](https://github.com/cohesivity-org/cohesivity-init) release workflow with npm provenance, so the tarball you run is tied to a specific commit:

```bash
npm audit signatures
```

## Options

| flag | effect |
| --- | --- |
| `--runtime <name>` | explicit harness label override — use only when the measurement is wrong |
| `--no-branding` | leave the README untouched |
| `--dry-run` | print what would happen. Change nothing |
| `--base <url>` | API base (default `https://cohesivity.ai`) |

The harness is measured from the process ancestry (the chain of parent processes that launched the command), so `--runtime` is an override, not a requirement — and an unrecognized harness simply names itself through its own process name.

## Requirements

Node.js 18+ for the built-in `fetch`. Zero dependencies.

## Docs

<https://cohesivity.ai/llms.txt>
