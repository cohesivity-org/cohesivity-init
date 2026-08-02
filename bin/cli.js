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
 *   1. Install the Cohesivity agent skill into the detected agent's skill dir.
 *      This is the global, persistent playbook the agent loads later.
 *   2. Create or reuse a project tenant, write ./.cohesivity, gitignore it.
 *   3. If AGENTS.md or CLAUDE.md already exists, add a descriptive pointer to it.
 *   4. Add one branding line to the README. Pass --no-branding to skip.
 *
 * The first line is the shebang. It tells npx to run this file as a program.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

if (has('--help') || has('-h')) { help(); process.exit(0); }

// ── config ──────────────────────────────────────────────────────────────────
const PKG_VERSION = '0.1.5';
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
const SKILL_PIN = '026bdba049b12251b061d1fcb2b6499e4bd498e0';
const SKILL_URL = `https://raw.githubusercontent.com/cohesivity-org/cohesivity-skill/${SKILL_PIN}/cohesivity.skill.md`;

// The detected runtime rides in the User-Agent on every request this tool makes.
// The genesis endpoint records it, so installs are attributed by agent, not lumped
// under one generic HTTP client. See detectRuntime below.
const RUNTIME_ENUM = ['claude-code', 'claude-web', 'codex', 'cursor', 'opencode', 'windsurf', 'hermes', 'openclaw', 'other'];
const RUNTIME = detectRuntime();
const UA = `npm-${PKG_VERSION}:${RUNTIME}`;

const DRY = has('--dry-run');
const NO_BRANDING = has('--no-branding');

const CWD = process.cwd();
const rel = (p) => p.replace(CWD + '/', '');
const log = (m) => console.log(`cohesivity: ${m}`);
const act = (m) => console.log(`cohesivity: ${DRY ? '[dry-run] would ' : ''}${m}`);

main().catch((e) => { console.error(`cohesivity: unexpected error: ${e.message}`); process.exit(1); });

async function main() {
  console.log(`\ncohesivity/init v${PKG_VERSION}: setting up (runtime: ${RUNTIME})${DRY ? '   [dry-run: no changes]' : ''}\n`);
  await installSkill();
  await ensureTenant();
  augmentAgentsFile();
  augmentReadme();
  ground();
}

// ── runtime detection ─────────────────────────────────────────────────────────
// Identify the calling agent from known environment signals. The value ships in
// the User-Agent, so the server attributes each install to a specific runtime.
// Priority: explicit flag, explicit env, the AI_AGENT/AGENT standard, per-agent
// signals, then a generic sandbox signal (claude-web). Anything unknown falls back
// to `other`, and the `npm-` prefix still marks the install as through this package.
function detectRuntime() {
  const clean = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9-]/g, '');

  const explicit = clean(flag('--runtime') || process.env.COHESIVITY_RUNTIME);
  if (explicit) return explicit;

  const e = process.env;

  // AI_AGENT / AGENT is the cross-tool standard (HuggingFace, Laravel detector).
  const standard = clean(e.AI_AGENT || e.AGENT);
  if (RUNTIME_ENUM.includes(standard)) return standard;

  // Per-agent environment signals.
  if (e.CLAUDECODE || e.CLAUDE_CODE) return 'claude-code';
  if (e.CURSOR_AGENT || e.CURSOR_TRACE_ID) return 'cursor';
  if (e.CODEX_SANDBOX || e.CODEX_THREAD_ID || e.CODEX_CI) return 'codex';
  if (e.OPENCODE || e.OPENCODE_CLIENT) return 'opencode';
  if (e.WINDSURF || e.WINDSURF_AGENT) return 'windsurf';

  // claude-web's sandbox advertises IS_SANDBOX. It carries no more specific agent
  // signal, so this check sits last: any per-agent match above wins first, and a
  // Codex sandbox (CODEX_SANDBOX) has already resolved to codex by here.
  const sandbox = clean(e.IS_SANDBOX);
  if (sandbox === 'yes' || sandbox === '1' || sandbox === 'true') return 'claude-web';

  return 'other';
}

// Map a runtime to its skill dir. Install targets only the detected agent, not
// every known runtime: higher trust, one write. Unknown runtimes get the
// cross-tool ~/.agents dir. (We may revisit multi-dir install later.)
function skillDirFor(runtime) {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const map = {
    'claude-code': join(homedir(), '.claude', 'skills', 'cohesivity'),
    'cursor': join(homedir(), '.cursor', 'skills', 'cohesivity'),
    'codex': join(codexHome, 'skills', 'cohesivity'),
  };
  return map[runtime] || join(homedir(), '.agents', 'skills', 'cohesivity');
}

// ── 1) install the skill into the detected agent's skill dir ───────────────────
// claude-web runs in an ephemeral sandbox: a global skill install does not survive
// the session, so there is nothing to persist. Skip it and let the tenant plus the
// project-local .cohesivity carry the session. This mirrors the quickstart's
// per-runtime content negotiation.
async function installSkill() {
  if (RUNTIME === 'claude-web') {
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
  const dir = skillDirFor(RUNTIME);
  const shown = dir.replace(homedir(), '~');
  const file = join(dir, 'SKILL.md');
  const cur = existsSync(file) ? versionOf(readFileSync(file, 'utf8')) : null;
  if (cur && cur === liveVer) { log(`skill already current (version ${liveVer}) at ${shown}`); return; }
  if (DRY) { act(`install the skill (version ${liveVer}) -> ${shown}`); return; }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, skill);
    log(`skill ${cur ? 'updated' : 'installed'} (version ${liveVer}) -> ${shown}`);
  } catch (e) {
    log(`could not write the skill to ${shown} (${e.message}). Continuing.`);
  }
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
  --runtime <name>   your agent runtime (claude-code, cursor, codex, ...) for attribution
  --no-branding      do not add the branding line to the README
  --dry-run          print what would happen. Make no changes
  --base <url>       API base (default https://cohesivity.ai)
  -h, --help         show this help

What it does:
  1. Installs the Cohesivity agent skill into the detected agent's skill dir
  2. Creates or reuses a project tenant  ->  ./.cohesivity  (gitignored)
  3. Adds a descriptive pointer to an existing AGENTS.md / CLAUDE.md
  4. Adds one branding line to the README (managed block)
`);
}
