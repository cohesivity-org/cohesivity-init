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
 * The command does three things, in order:
 *   1. Install the Cohesivity agent skill into every known agent skill dir
 *      whose harness is present on this machine. This is the global,
 *      persistent playbook the agent loads later.
 *   2. Create or reuse a project tenant, write ./.cohesivity, gitignore it.
 *   3. If AGENTS.md or CLAUDE.md already exists, add a descriptive pointer to it.
 *
 * It writes nothing else. It does not add anything to your README: an installer
 * putting promotional text in someone's repo is an edit they did not ask for,
 * and it forced every careful agent to stop and request permission mid-setup.
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
const PKG_VERSION = '0.4.1';
const BASE = (flag('--base') || process.env.COHESIVITY_BASE || 'https://cohesivity.ai').replace(/\/+$/, '');

// Machine id: one per machine, stored outside any project. A project's
// .cohesivity is per project, so a machine that runs setup in several projects
// owns several tenants; this is what tells the server they came from one setup
// rather than several unrelated people. Sent on genesis; the server issues one
// whenever it cannot verify what we sent — none at all, or an id gone stale
// because the signing secret rotated or the file was corrupted — and whatever
// it issues replaces what is on disk. Steady state is written once and reused.
const MACHINE_ID_HEADER = 'X-Cohesivity-Machine-Id';
const MACHINE_ID_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cohesivity');
const MACHINE_ID_FILE = join(MACHINE_ID_DIR, 'machine-id');

// The skill is pinned to an immutable commit in the public, auditable repo.
// Bumping the pin is a deliberate release step. See COH-172.
const SKILL_PIN = '6c4c04d94d344590f6732763f0116b155a32753c';
const SKILL_URL = `https://raw.githubusercontent.com/cohesivity-org/cohesivity-skill/${SKILL_PIN}/cohesivity.skill.md`;

// Harness: the nearest ancestor process that is not generic plumbing. Only
// this process's own lineage is read — never the system process list — and only
// the resulting name is sent. The sets below are closed lists of Unix plumbing,
// interpreters, and generic path segments; they never name a harness, so any
// harness, present or future, identifies itself by its own process or script
// name. Nothing inferable -> null, never a guess.
const PLUMBING = new Set('sh bash zsh fish dash ksh csh tcsh env sudo doas timeout timelimit nice setsid nohup xargs script ssh sshd tmux screen login su init systemd launchd docker containerd containerd-shim runc podman npm npx pnpm yarn bunx ps awk grep sed find curl wget gnome-terminal konsole xterm alacritty kitty wezterm tilix terminator iterm2 terminal warp-terminal'.split(' '));
const INTERPRETERS = new Set('node bun deno python python2 python3 ruby perl'.split(' '));
const GENERIC = new Set('cli index main app run dist build bin lib libexec src out node_modules _npx versions current'.split(' '));

function inferHarness() {
  let pid = process.ppid;
  // `pid >= 1`, not `pid > 1`: pid 1 must be EXAMINED, not merely used as the
  // stop condition. On a normal machine pid 1 is init/systemd and the denylist
  // rejects it anyway, but under a microVM or container entrypoint pid 1 IS
  // the supervising process that spawned this command, so skipping it left
  // those environments with no name. Pid 1 reports parent 0, so the walk ends.
  for (let i = 0; i < 20 && pid >= 1; i++) {
    let argv, ppid;
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      // A process that rewrites its title (npm does) has no NUL separators
      // left, so the whole command arrives as one element. Re-split it, or
      // argv[0] is an entire command line rather than a program name.
      if (argv.length === 1 && argv[0].includes(' ')) argv = argv[0].split(/\s+/);
      ppid = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ')[1]);
    } catch {
      try {
        argv = execSync(`ps -o args= -p ${pid}`, { timeout: 2000 }).toString().trim().split(/\s+/);
        ppid = Number(execSync(`ps -o ppid= -p ${pid}`, { timeout: 2000 }).toString().trim());
      } catch { return null; }
    }
    let name = (argv[0] || '').split('/').pop().replace(/^-/, '');
    if (INTERPRETERS.has(name)) {
      const script = argv.slice(1).find((a) => a.includes('/') && !a.includes('='));
      const segs = (script || '').split('/').filter(Boolean);
      while (segs.length && GENERIC.has(segs[segs.length - 1].replace(/\.\w+$/, ''))) segs.pop();
      if (segs.length) name = segs.pop().replace(/\.\w+$/, '');
    }
    if (name && !PLUMBING.has(name)) return name.replace(/[^\w.-]/g, '').slice(0, 40) || null;
    if (!Number.isFinite(ppid)) return null;
    pid = ppid;
  }
  return null;
}

const DRY = has('--dry-run');

const CWD = process.cwd();
const rel = (p) => p.replace(CWD + '/', '');
const log = (m) => console.log(`cohesivity: ${m}`);
const act = (m) => console.log(`cohesivity: ${DRY ? '[dry-run] would ' : ''}${m}`);

// --runtime / COHESIVITY_RUNTIME is an explicit override for the label — user
// intent, not detection. Everything else is measured.
const EXPLICIT = String(flag('--runtime') || process.env.COHESIVITY_RUNTIME || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
const HARNESS = EXPLICIT || inferHarness() || 'none';
const UA = `{npx:${HARNESS}}`;

main().catch((e) => { console.error(`cohesivity: unexpected error: ${e.message}`); process.exit(1); });

async function main() {
  console.log(`\ncohesivity/init v${PKG_VERSION}: setting up (harness: ${HARNESS})${DRY ? '   [dry-run: no changes]' : ''}\n`);
  await installSkill();
  await ensureTenant();
  augmentAgentsFile();
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
    if (machineId) headers[MACHINE_ID_HEADER] = machineId;
    const res = await fetch(`${BASE}/api/genesis`, { method: 'POST', headers });
    body = await res.text();
    // Returned on any request that MINTED an id, which is when we sent none
    // *or* when the id we sent no longer verifies (secret rotated, file
    // corrupted). It is not "non-null exactly when we sent none" — assuming
    // that is what left a machine pinned to a dead id forever.
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
  // Store whatever the server issued. Its presence already means "we minted
  // this for you", so gating on `!machineId` as well dropped every replacement
  // a machine with a stale id was handed: it re-minted on every genesis, kept
  // none of them, and each project became its own machine row.
  if (issuedMachineId) writeMachineId(issuedMachineId);
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
  console.log(`  - Per-service docs: ${BASE}/offerings/<name>   \u00b7   full reference: ${BASE}/llms.txt`);
  console.log('  - The skill is set up for future sessions. Claude Code auto-loads it if ~/.claude/skills already existed, otherwise restart; Cursor and Codex pick it up on reload/restart.');
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
  --dry-run          print what would happen. Make no changes
  --base <url>       API base (default https://cohesivity.ai)
  -h, --help         show this help

What it does:
  1. Installs the Cohesivity agent skill into every known agent skill dir
     whose harness is present on this machine
  2. Creates or reuses a project tenant  ->  ./.cohesivity  (gitignored)
  3. Adds a descriptive pointer to an existing AGENTS.md / CLAUDE.md

Attribution: the tenant-creation call carries a User-Agent of the shape
{npx:<harness>}, where the harness is measured from this process's own
parents. Nothing else about your machine is read or sent, and anything not
inferable is sent as "none".
`);
}
