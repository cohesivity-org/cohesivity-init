#!/usr/bin/env node
/**
 * @cohesivity/init
 *
 * Project setup, run once via `npx @cohesivity/init`.
 *
 * Install does nothing. Every effect happens when you run the command, and you
 * can read this file before you run it. There is no postinstall hook.
 *
 * Zero dependencies. Node 18+ provides global `fetch` and the `node:` builtins,
 * so the registry ships this one file and nothing else.
 *
 * The command does four things, in order:
 *   1. Install the Cohesivity agent skill into every known agent skill dir
 *      whose harness is present on this machine. This is the global,
 *      persistent playbook the agent loads later.
 *   2. Create or reuse a project tenant, write ./.cohesivity, gitignore it.
 *   3. If AGENTS.md or CLAUDE.md already exists, add a descriptive pointer to it.
 *   4. Add one branding line to the README. Pass --no-branding to skip.
 *
 * The first line is the shebang. It tells npx to run this file as a program.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

if (has('--help') || has('-h')) { help(); process.exit(0); }

// ── config ──────────────────────────────────────────────────────────────────
const PKG_VERSION = '0.3.0';
const BASE = (flag('--base') || process.env.COHESIVITY_BASE || 'https://cohesivity.ai').replace(/\/+$/, '');

// Machine id: one per machine, stored outside any project. A project's
// .cohesivity is per project, so a machine that runs setup in several projects
// owns several tenants; this is what tells the server they came from one setup
// rather than several unrelated people. Sent on genesis; the server issues one
// only when we send none, so it is written exactly once and reused thereafter.
const MACHINE_ID_HEADER = 'X-Cohesivity-Machine-Id';
const MACHINE_ID_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cohesivity');
const MACHINE_ID_FILE = join(MACHINE_ID_DIR, 'machine-id');

// The skill is pinned to an immutable commit in the public, auditable repo.
// Bumping the pin is a deliberate release step. See COH-172.
const SKILL_PIN = 'a4c0e90373b2d61501e4fb544a760b4a602fc14e';
const SKILL_URL = `https://raw.githubusercontent.com/cohesivity-org/cohesivity-skill/${SKILL_PIN}/cohesivity.skill.md`;

// ── attribution: measured from the machine, never asked of the model ────────
// The genesis call carries two measured facts:
//   - The raw ancestor-process command chain (innermost first, home folded to
//     ~), sent verbatim as X-Cohesivity-Ancestry. The server stores it
//     untouched, so harness classification stays a query-time lens and a new
//     harness is discovered from data, never shipped in a list here.
//   - UA `{npx:<harness>, <model>}`: the harness is the innermost ancestor
//     that is not generic plumbing (closed sets below — shells, wrappers,
//     interpreters, terminals; never harness names, so any harness names
//     itself), and the model id is read out of that harness's own live
//     session log. Anything not inferable is the literal "none" — no info is
//     better than false info.
const ANCESTRY_HEADER = 'X-Cohesivity-Ancestry';

// Closed sets: the plumbing an ancestor chain routes through, the interpreter
// binaries whose script path carries the real name, and the generic segments
// inside those paths. Harness names never belong in any of these.
const PLUMBING = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'env', 'sudo', 'doas', 'timeout', 'timelimit', 'nice', 'ionice', 'stdbuf', 'setsid', 'nohup', 'xargs', 'script', 'ssh', 'sshd', 'tmux', 'screen', 'login', 'su', 'init', 'systemd', 'launchd', 'docker', 'containerd', 'containerd-shim', 'runc', 'podman', 'npm', 'npx', 'pnpm', 'yarn', 'bunx', 'corepack', 'ps', 'awk', 'grep', 'sed', 'cat', 'tr', 'cut', 'head', 'tail', 'find', 'curl', 'wget', 'gnome-terminal', 'konsole', 'xterm', 'alacritty', 'kitty', 'wezterm', 'tilix', 'terminator', 'iterm2', 'terminal', 'warp-terminal']);
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'python2', 'ruby', 'perl']);
const GENERIC_SEGMENTS = new Set(['dist', 'build', 'bin', '.bin', 'lib', 'libexec', 'src', 'out', 'app', 'node_modules', '_npx', 'versions', 'current', 'cli.js', 'index.js', 'main.js', 'app.js', 'run.py', 'main.py', '__main__.py', 'npm-cli.js', 'npx-cli.js', 'yarn.js', 'pnpm.cjs', 'corepack.js']);

// The raw chain, or null when unreadable (no `ps`, restricted /proc) — null
// sends nothing; it never guesses.
function ancestry() {
  try {
    const out = execSync('ps -eo pid=,ppid=,args=', { timeout: 2000 }).toString();
    const pp = {}; const cmd = {};
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)/);
      if (m) { pp[m[1]] = m[2]; cmd[m[1]] = m[3].split(homedir()).join('~').slice(0, 120); }
    }
    const chain = [];
    // Start at the PARENT: this process is `node .../cli.js` and must never
    // infer itself as the harness.
    for (let p = pp[String(process.pid)], i = 0; i < 20 && cmd[p]; p = pp[p], i++) chain.push(reduceEntry(cmd[p]));
    return chain.filter(Boolean).join(' | ').replace(/[^\w ._:;()/+~@,|-]/g, '').slice(0, 800) || null;
  } catch { return null; }
}

// Keep the program that ran; drop its arguments before anything is sent.
//
// Arguments are pure liability and identify nothing. A real caller's chain
// reached the server carrying live AWS credentials, because its parent was
// `sh -c export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...`; agent
// invocations put the user's prompt on the command line the same way. argv[0]
// names the harness, and for an interpreter the script path does, so one
// path-like argument that is neither a URL nor a k=v assignment survives.
function reduceEntry(entry) {
  const tokens = String(entry).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return '';
  const prog = tokens[0];
  const base = prog.split('/').pop().replace(/^-/, '');
  if (!INTERPRETERS.has(base)) return prog;
  for (const tok of tokens.slice(1)) {
    if (tok.includes('=') || tok.includes('://')) continue;
    if (tok.includes('/')) return `${prog} ${tok}`;
  }
  return prog;
}

function inferHarness(chain) {
  for (const entry of (chain || '').split(' | ')) {
    const tokens = entry.trim().split(' ');
    const first = (tokens[0] || '').split('/').pop().replace(/^-/, '');
    if (INTERPRETERS.has(first)) {
      // Interpreter: the name lives in the script path (…/pi-coding-agent/dist/cli.js).
      for (const tok of tokens.slice(1)) {
        if (!tok.includes('/')) continue;
        const segs = tok.split('/');
        for (let k = segs.length - 1; k >= 0; k--) {
          const s = segs[k].replace(/^@/, '');
          if (s && s !== '~' && !GENERIC_SEGMENTS.has(s) && !PLUMBING.has(s)) {
            return s.replace(/\.(js|mjs|cjs|py|rb|pl)$/, '').slice(0, 40);
          }
        }
      }
    } else if (first && !PLUMBING.has(first)) {
      return first.slice(0, 40);
    }
  }
  return null;
}

const DRY = has('--dry-run');
const NO_BRANDING = has('--no-branding');

const CWD = process.cwd();
const rel = (p) => p.replace(CWD + '/', '');
const log = (m) => console.log(`cohesivity: ${m}`);
const act = (m) => console.log(`cohesivity: ${DRY ? '[dry-run] would ' : ''}${m}`);

const ANCESTRY = ancestry();
// --runtime / COHESIVITY_RUNTIME is an explicit override for the label — user
// intent, not detection. Everything else is measured.
const EXPLICIT = String(flag('--runtime') || process.env.COHESIVITY_RUNTIME || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
const HARNESS = EXPLICIT || inferHarness(ANCESTRY) || 'none';
const UA = `{npx:${HARNESS}}`;

// claude-web's sandbox is non-persistent, so a global skill install cannot
// survive the session; skip it there. IS_SANDBOX is the sandbox's own signal.
const IS_CLAUDE_WEB = HARNESS === 'claude-web' || /^(1|yes|true)$/i.test(process.env.IS_SANDBOX || '');

main().catch((e) => { console.error(`cohesivity: unexpected error: ${e.message}`); process.exit(1); });

async function main() {
  console.log(`\ncohesivity/init v${PKG_VERSION}: setting up (harness: ${HARNESS})${DRY ? '   [dry-run: no changes]' : ''}\n`);
  await installSkill();
  await ensureTenant();
  augmentAgentsFile();
  augmentReadme();
  ground();
}

// ── 1) install the skill into the skill dirs present on this machine ─────────
// Presence on disk is the measurement: each known agent skill dir is written
// only when its harness home already exists. When none exist, the cross-tool
// ~/.agents dir is the fallback so the skill lands somewhere.
function skillDirs() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const gated = [
    [join(homedir(), '.claude'), join(homedir(), '.claude', 'skills', 'cohesivity')],
    [join(homedir(), '.cursor'), join(homedir(), '.cursor', 'skills', 'cohesivity')],
    [codexHome, join(codexHome, 'skills', 'cohesivity')],
    [join(homedir(), '.agents'), join(homedir(), '.agents', 'skills', 'cohesivity')],
  ];
  const dirs = gated.filter(([home]) => existsSync(home)).map(([, dir]) => dir);
  return dirs.length ? dirs : [join(homedir(), '.agents', 'skills', 'cohesivity')];
}

async function installSkill() {
  if (IS_CLAUDE_WEB) {
    log('claude-web sandbox is ephemeral, skipping the global skill install (tenant + .cohesivity only)');
    return;
  }
  let skill;
  try {
    const res = await fetch(SKILL_URL, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    skill = await res.text();
  } catch (e) {
    log(`could not fetch the skill (${e.message}). Continuing. Docs: ${BASE}/llms.txt`);
    return;
  }
  const liveVer = versionOf(skill) || 'unknown';
  let installed = 0; let updated = 0; let current = 0;
  for (const dir of skillDirs()) {
    const shown = dir.replace(homedir(), '~');
    const file = join(dir, 'SKILL.md');
    const cur = existsSync(file) ? versionOf(readFileSync(file, 'utf8')) : null;
    if (cur && cur === liveVer) { current++; continue; }
    if (DRY) { act(`install the skill (version ${liveVer}) -> ${shown}`); continue; }
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, skill);
      if (cur) updated++; else installed++;
    } catch (e) {
      log(`could not write the skill to ${shown} (${e.message}). Continuing.`);
    }
  }
  if (!DRY) log(`skill added=${installed} updated=${updated} current=${current} (version ${liveVer})`);
}

// ── 2) create or reuse the project tenant ─────────────────────────────────────
async function ensureTenant() {
  const dotfile = join(CWD, '.cohesivity');
  if (existsSync(dotfile) && readFileSync(dotfile, 'utf8').includes('coh_management_key=')) {
    log('reusing existing .cohesivity (no new tenant created)');
    return;
  }
  if (DRY) { act(`create a tenant: POST ${BASE}/api/genesis  ->  ./.cohesivity  (+ .gitignore)`); return; }
  const machineId = readMachineId();
  let body;
  let issuedMachineId = null;
  try {
    const headers = { 'User-Agent': UA };
    if (ANCESTRY) headers[ANCESTRY_HEADER] = ANCESTRY;
    if (machineId) headers[MACHINE_ID_HEADER] = machineId;
    const res = await fetch(`${BASE}/api/genesis`, { method: 'POST', headers });
    body = await res.text();
    // Only ever returned on the request that minted it, so this is non-null
    // exactly when we sent none.
    issuedMachineId = res.headers.get(MACHINE_ID_HEADER);
  } catch (e) {
    log(`no tenant created (network: ${e.message}). Re-run to retry. The command is idempotent.`);
    return;
  }
  if (!body.includes('coh_management_key=')) {
    log('no tenant created (likely the 10/60s rate limit). Re-run shortly. The command is idempotent.');
    return;
  }
  writeFileSync(dotfile, body);
  ensureGitignore();
  if (!machineId && issuedMachineId) writeMachineId(issuedMachineId);
  log('created an ephemeral tenant -> ./.cohesivity');
}

// Read the machine id, or null when this machine has none. Every failure —
// missing file, unreadable dir, garbage contents — reads as "none", which just
// means the next genesis call is issued a fresh id.
function readMachineId() {
  try {
    const raw = readFileSync(MACHINE_ID_FILE, 'utf8').trim();
    return /^mach_[a-z0-9]+\.[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
  } catch (_) {
    return null;
  }
}

// Persist a newly issued id. Best-effort by design: a read-only or unwritable
// config dir must not fail setup — the tenant already exists by this point, and
// the only cost of not writing is that the next project is issued another id.
function writeMachineId(value) {
  try {
    mkdirSync(MACHINE_ID_DIR, { recursive: true });
    writeFileSync(MACHINE_ID_FILE, `${value}\n`);
  } catch (_) { /* not worth failing or mentioning */ }
}

function ensureGitignore() {
  const gi = join(CWD, '.gitignore');
  const line = '.cohesivity';
  if (existsSync(gi)) {
    const cur = readFileSync(gi, 'utf8');
    if (!cur.split(/\r?\n/).includes(line)) appendFileSync(gi, (cur.endsWith('\n') ? '' : '\n') + line + '\n');
  } else {
    writeFileSync(gi, line + '\n');
  }
}

// ── 3) add a descriptive pointer to an existing AGENTS.md / CLAUDE.md ──────────
// Describe the platform. Never command the agent. The line states a fact: this
// project uses Cohesivity, and the state lives here. Auth stays in .cohesivity
// and the skill. An agent without the skill still learns the project uses
// Cohesivity from this consented, in-repo signal.
const AGENTS_LINE =
  `This project uses [Cohesivity](https://cohesivity.ai) for its managed backend. ` +
  `Credentials and tenant state live in \`.cohesivity\`. Live status is at \`GET ${BASE}/api/status\`.`;

function augmentAgentsFile() {
  // Only touch files that already exist. Never create an agent file unprompted.
  const targets = ['AGENTS.md', 'CLAUDE.md'].map((f) => join(CWD, f)).filter(existsSync);
  if (!targets.length) { log('no AGENTS.md / CLAUDE.md present. Skipping (nothing created)'); return; }
  for (const file of targets) {
    if (DRY) { act(`add a Cohesivity managed block to ${rel(file)}`); continue; }
    upsertManagedBlock(file, AGENTS_LINE);
    log(`updated ${rel(file)}`);
  }
}

// ── 4) one branding line at the end of the README (the human-facing channel) ──
function augmentReadme() {
  if (NO_BRANDING) return;
  const readme = ['README.md', 'readme.md', 'Readme.md'].map((f) => join(CWD, f)).find(existsSync);
  if (!readme) return;
  const line = 'Backend powered by [Cohesivity](https://cohesivity.ai).';
  if (DRY) { act(`add a branding line to ${rel(readme)}`); return; }
  upsertManagedBlock(readme, line);
  log(`updated ${rel(readme)}`);
}

// Idempotent managed block: update in place if present, else append. This copies
// the Vercel `<!-- BEGIN:... -->` convention, so re-runs never duplicate content.
const BEGIN = '<!-- BEGIN:cohesivity -->';
const END = '<!-- END:cohesivity -->';
function upsertManagedBlock(file, inner) {
  const block = `${BEGIN}\n${inner}\n${END}`;
  let text = readFileSync(file, 'utf8');
  const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
  text = re.test(text) ? text.replace(re, block) : text.replace(/\s*$/, '\n') + '\n' + block + '\n';
  writeFileSync(file, text);
}

// ── ground the session with the result and next steps ─────────────────────────
function ground() {
  const dotfile = join(CWD, '.cohesivity');
  const tid = existsSync(dotfile) ? (readFileSync(dotfile, 'utf8').match(/^tenant_id=(.+)$/m) || [])[1] || '' : '';
  console.log('');
  log(tid ? `ready. tenant ${tid}` : 'ready');
  console.log(`  - Keys are in .cohesivity (gitignored, do not commit).`);
  console.log(`  - Provision a service: POST ${BASE}/api/resources/<name>  (Authorization: Bearer <coh_management_key>)`);
  console.log(`  - Docs: ${BASE}/llms.txt`);
}

function versionOf(md) { return (md.match(/^version:\s*(.+)$/m) || [])[1]?.trim() || null; }

function help() {
  console.log(`
@cohesivity/init: set up Cohesivity in this project.

Usage:
  npx @cohesivity/init [options]

Options:
  --runtime <name>   explicit harness label override (normally measured from
                     the process ancestry; use only when the measurement is wrong)
  --no-branding      do not add the branding line to the README
  --dry-run          print what would happen. Make no changes
  --base <url>       API base (default https://cohesivity.ai)
  -h, --help         show this help

What it does:
  1. Installs the Cohesivity agent skill into every known agent skill dir
     whose harness is present on this machine
  2. Creates or reuses a project tenant  ->  ./.cohesivity  (gitignored)
  3. Adds a descriptive pointer to an existing AGENTS.md / CLAUDE.md
  4. Adds one branding line to the README (managed block)

Attribution: the tenant-creation call carries the raw ancestor-process chain
(X-Cohesivity-Ancestry) and a measured User-Agent {npx:<harness>, <model>}.
Nothing is guessed: anything not inferable is sent as "none".
`);
}
