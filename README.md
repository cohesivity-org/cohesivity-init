# @cohesivity/init

Set up [Cohesivity](https://cohesivity.ai) in a project with one command.

```bash
npx @cohesivity/init
```

The command runs once and does three things:

1. **Installs the Cohesivity agent skill** into every known agent skill dir whose harness is present on this machine (Claude Code, Cursor, Codex; the cross-tool `~/.agents` when none are). The skill is a markdown file your agent loads in later sessions, fetched from a public commit pinned in this file — so you can read the exact bytes it will install before running anything.
2. **Creates or reuses a project tenant** and writes the credentials to `.cohesivity`, which it adds to `.gitignore`. The tenant-creation request identifies the coding agent that ran the command: the tool walks its own parent processes and sends **that one name** — `claude`, `opencode`, or whatever the program calls itself — as its User-Agent, in the form `{npx:<name>}`. If it cannot tell, it sends `none`. It reads nothing else about your machine: no list of your running processes, no session logs, no conversations, no model settings, no files outside the project. Creating a tenant also stores an opaque random setup id at `~/.config/cohesivity/machine-id` and sends it with that request, so tenants created from one machine can be grouped rather than looking like unrelated people. It is issued by the server, is not derived from your hardware or user, and carries nothing about you or your project. Delete the file to end the association.
3. **Adds a descriptive pointer** to an existing `AGENTS.md`, `CLAUDE.md`, or `README.md`, so whoever opens this project later — a person or another agent — knows it uses Cohesivity and where to check its backend. It only touches a file that is already there, and creates nothing on its own. The pointer sits between `<!-- BEGIN:cohesivity -->` and `<!-- END:cohesivity -->` markers; delete the block and it will be written again on the next run.

It writes nothing else.

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
| `--dry-run` | print what would happen. Change nothing |
| `--base <url>` | API base (default `https://cohesivity.ai`) |

The name comes from the process that launched the command, so `--runtime` is an override, not a requirement — and an agent this package has never heard of simply names itself. Nothing about the detection is specific to any vendor.

## Requirements

Node.js 18+ for the built-in `fetch`. Zero dependencies.

## Docs

<https://cohesivity.ai/llms.txt>
