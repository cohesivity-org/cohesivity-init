# @cohesivity/init

Set up [Cohesivity](https://cohesivity.ai) in a project with one command.

```bash
npx @cohesivity/init
```

The command runs once and does four things:

1. **Installs the Cohesivity agent skill** into the detected agent's skill dir (Claude Code, Cursor, Codex, or the cross-tool `~/.agents`). The skill comes from a public, version-pinned commit, so you can audit the exact bytes.
2. **Creates or reuses a project tenant** and writes the credentials to `.cohesivity`, which it adds to `.gitignore`.
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
| `--runtime <name>` | your agent runtime (`claude-code`, `cursor`, `codex`, ...) for attribution |
| `--no-branding` | leave the README untouched |
| `--dry-run` | print what would happen. Change nothing |
| `--base <url>` | API base (default `https://cohesivity.ai`) |

The tool detects your runtime from the environment, so `--runtime` is an override, not a requirement.

## Requirements

Node.js 18+ for the built-in `fetch`. Zero dependencies.

## Docs

<https://cohesivity.ai/llms.txt>
