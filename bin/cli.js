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
 * By default, the command does three things, in order:
 *   1. Detect every installed supported client and install its native or
 *      portable Cohesivity plugin package. Unsupported adapters with a safe,
 *      documented MCP command receive the standalone skill and remote MCP.
 *   2. Create or reuse a project tenant, write ./.cohesivity, gitignore it.
 *   3. If AGENTS.md, CLAUDE.md, or README.md already exists, add a descriptive
 *      pointer to it.
 *
 * With --no-plugin, step 1 installs only the canonical standalone skill. No
 * plugin or MCP configuration is installed. Tenant creation, machine
 * attribution, and project pointers are unchanged.
 *
 * It writes nothing else, and it creates none of those three files. The pointer
 * is descriptive rather than promotional — it states where this project's
 * backend state lives, which is what makes it worth carrying in a repo someone
 * else (or some other agent) opens later.
 *
 * The first line is the shebang. It tells npx to run this file as a program.
 */

import {
  accessSync, appendFileSync, constants as fsConstants, existsSync, lstatSync,
  mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const PKG_VERSION = '0.9.0';

function validateArgs() {
  const switches = new Set(['--dry-run', '--no-plugin', '--no-branding', '--tenant-only', '--help', '-h']);
  const values = new Set(['--runtime', '--base']);
  for (let i = 0; i < argv.length; i++) {
    if (switches.has(argv[i])) continue;
    if (values.has(argv[i])) {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error(`${argv[i]} requires a value`);
      i++; continue;
    }
    throw new Error(`unknown option ${argv[i]}`);
  }
}

if (has('--help') || has('-h')) { help(); process.exit(0); }

// ── config ──────────────────────────────────────────────────────────────────
const BASE = (flag('--base') || process.env.COHESIVITY_BASE || 'https://cohesivity.ai').replace(/\/+$/, '');
const MCP_URL = 'https://cohesivity.ai/mcp';

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
const SKILL_PIN = '8703edc648453b6fa45300e380510dda77452071';
const SKILL_URL = `https://raw.githubusercontent.com/cohesivity-org/cohesivity-skill/${SKILL_PIN}/cohesivity.skill.md`;

// Plugin release pins live in this one block. Bump all three values together
// after publishing a new two-commit artifact manifest from cohesivity-plugin.
// Tests inject a complete pin with COHESIVITY_PLUGIN_MANIFEST_PIN.
const PLUGIN_RELEASE = Object.freeze({
  manifestUrl: 'https://raw.githubusercontent.com/cohesivity-org/cohesivity-plugin/2da59bc6308e3eda461e7fa1b0468f44a2473aa7/artifacts/v5.0.0/install-manifest.v1.json',
  manifestBytes: 9400,
  manifestSha256: '11d44d171299091b061e35b82dcb78e3b1d4ba2bf44ea520239e9862e0e21e58',
});

const ARTIFACT_KEYS = Object.freeze({
  claude: 'claude',
  portable: 'portable',
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'antigravity',
});

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
        argv = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { timeout: 2000 }).toString().trim().split(/\s+/);
        ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 }).toString().trim());
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
const NO_PLUGIN = has('--no-plugin');
const TENANT_ONLY = has('--tenant-only');

const CWD = process.cwd();
const rel = (p) => p.replace(CWD + '/', '');
const log = (m) => console.log(`cohesivity: ${m}`);
const act = (m) => console.log(`cohesivity: ${DRY ? '[dry-run] would ' : ''}${m}`);

// --runtime / COHESIVITY_RUNTIME is an explicit override for the label — user
// intent, not detection. Everything else is measured.
const EXPLICIT = String(flag('--runtime') || process.env.COHESIVITY_RUNTIME || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
const HARNESS = EXPLICIT || inferHarness() || 'none';
const UA = `{npx:${HARNESS}}`;

async function main() {
  validateArgs();
  console.log(`\ncohesivity/init v${PKG_VERSION}: setting up (harness: ${HARNESS})${DRY ? '   [dry-run: no changes]' : ''}\n`);
  const deliveryFailures = TENANT_ONLY
    ? []
    : NO_PLUGIN
      ? await installStandaloneSkill()
      : await installClientIntegrations();
  await ensureTenant();
  augmentProjectFiles();
  if (deliveryFailures.length) {
    for (const failure of deliveryFailures) console.error(`cohesivity: delivery failed for ${failure.client}: ${failure.message}`);
  }
  ground(deliveryFailures);
  if (deliveryFailures.length) process.exitCode = 1;
}

// ── 1) detect clients and deliver verified integrations ──────────────────────
const HOME = homedir();
const CODEX_HOME = process.env.CODEX_HOME || join(HOME, '.codex');
const HERMES_HOME = process.env.HERMES_HOME || join(HOME, '.hermes');
const DATA_HOME = process.env.XDG_DATA_HOME || join(HOME, '.local', 'share');
const DURABLE_PLUGIN_ROOT = join(DATA_HOME, 'cohesivity', 'plugin-packages');
const CANONICAL_SKILL_DIR = join(HOME, '.agents', 'skills', 'cohesivity');
const POSITIVE_ANTIGRAVITY_HOMES = [
  join(HOME, '.gemini', 'antigravity'),
  join(HOME, '.gemini', 'antigravity-cli'),
  join(HOME, '.gemini', 'antigravity-ide'),
];

function executable(names) {
  for (const name of names) {
    if (name.includes('/') || name.includes('\\')) {
      try { accessSync(name, fsConstants.X_OK); return name; } catch { continue; }
    }
    for (const dir of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
      const candidates = process.platform === 'win32'
        ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((ext) => join(dir, name + ext.toLowerCase()))
        : [join(dir, name)];
      for (const candidate of candidates) {
        try { accessSync(candidate, fsConstants.X_OK); return candidate; } catch { /* keep looking */ }
      }
    }
  }
  return null;
}

function hasAny(paths) { return paths.some((path) => existsSync(path)); }

function detectClients() {
  const bins = {
    claude: executable(['claude']),
    cursor: executable(['cursor', 'cursor-agent']),
    codex: executable(['codex']),
    gemini: executable(['gemini']),
    antigravity: executable(['agy']),
    openclaw: executable(['openclaw']),
    hermes: executable(['hermes']),
    opencode: executable(['opencode']),
  };
  return [
    { id: 'claude', name: 'Claude', bin: bins.claude, detected: Boolean(bins.claude), artifact: ARTIFACT_KEYS.claude },
    { id: 'cursor', name: 'Cursor', bin: bins.cursor, detected: Boolean(bins.cursor || existsSync(join(HOME, '.cursor'))), artifact: ARTIFACT_KEYS.portable },
    { id: 'codex', name: 'Codex', bin: bins.codex, detected: Boolean(bins.codex), artifact: ARTIFACT_KEYS.codex },
    {
      id: 'gemini', name: 'Gemini', bin: bins.gemini,
      detected: Boolean(bins.gemini),
      artifact: ARTIFACT_KEYS.gemini,
    },
    {
      id: 'antigravity', name: 'Antigravity', bin: bins.antigravity,
      detected: Boolean(bins.antigravity || hasAny(POSITIVE_ANTIGRAVITY_HOMES)), artifact: ARTIFACT_KEYS.antigravity,
    },
    { id: 'openclaw', name: 'OpenClaw', bin: bins.openclaw, detected: Boolean(bins.openclaw), artifact: ARTIFACT_KEYS.claude },
    { id: 'hermes', name: 'Hermes', bin: bins.hermes, detected: Boolean(bins.hermes), artifact: ARTIFACT_KEYS.portable },
    { id: 'opencode', name: 'OpenCode', bin: bins.opencode, detected: Boolean(bins.opencode), artifact: ARTIFACT_KEYS.portable },
  ].filter((client) => client.detected);
}

const FALLBACK_ADAPTERS = [
  { id: 'copilot', name: 'GitHub Copilot CLI', bins: ['copilot'], args: [
    'mcp', 'add', '--transport', 'http', 'cohesivity', MCP_URL,
  ] },
  { id: 'vscode', name: 'VS Code', bins: ['code'], args: [
    '--add-mcp', JSON.stringify({ name: 'cohesivity', type: 'http', url: MCP_URL }),
  ] },
  { id: 'cline', name: 'Cline CLI', bins: ['cline'], args: [
    'mcp', 'add', 'cohesivity', MCP_URL, '--type', 'http',
  ] },
  { id: 'grok', name: 'Grok', bins: ['grok'], args: [
    'mcp', 'add', '--transport', 'http', 'cohesivity', MCP_URL,
  ] },
];

function detectFallbackAdapters() {
  return FALLBACK_ADAPTERS.map((adapter) => {
    const bin = executable(adapter.bins);
    return { ...adapter, bin, detected: Boolean(bin) };
  }).filter((adapter) => adapter.detected);
}

async function installStandaloneSkill() {
  log('plugin and MCP installation disabled (--no-plugin)');
  const error = await writeStandaloneSkill();
  return error ? [{ client: 'standalone skill', message: error.message }] : [];
}

async function writeStandaloneSkill() {
  const shown = displayPath(CANONICAL_SKILL_DIR);
  if (DRY) { act(`fetch ${SKILL_URL} and atomically install the standalone skill -> ${shown}`); return null; }
  try {
    const res = await fetch(SKILL_URL, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`skill returned HTTP ${res.status}`);
    const skill = await res.text();
    if (!versionOf(skill)) throw new Error('skill has no version field');
    const file = join(CANONICAL_SKILL_DIR, 'SKILL.md');
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current === skill) { log(`standalone skill current -> ${shown}`); return null; }
    installFileAtomically(file, skill);
    log(`standalone skill ${current === null ? 'installed' : 'updated'} -> ${shown}`);
    return null;
  } catch (error) {
    return error;
  }
}

async function installClientIntegrations() {
  const clients = detectClients();
  const adapters = detectFallbackAdapters();
  if (!clients.length && !adapters.length) {
    log('no supported client detected; installing the canonical standalone skill');
    const error = await writeStandaloneSkill();
    return error ? [{ client: 'standalone skill', message: error.message }] : [];
  }

  log(`detected clients: ${[...clients, ...adapters].map((client) => client.name).join(', ')}`);
  const failures = [];
  let artifacts = null;
  if (clients.length) {
    if (DRY) describeDryRunPluginDelivery(clients);
    else {
      try { artifacts = await fetchPluginArtifacts(new Set(clients.map((client) => client.artifact))); }
      catch (error) {
        for (const client of clients) failures.push({ client: client.name, message: error.message });
      }
    }
  }

  if (artifacts) {
    for (const client of clients) {
      try {
        await installForClient(client, artifacts.get(client.artifact));
        log(`${client.name} integration installed or reconciled`);
      } catch (error) {
        failures.push({ client: client.name, message: error.message });
      }
    }
    for (const artifact of artifacts.values()) {
      try { rmSync(artifact.temporary, { recursive: true, force: true }); }
      catch (error) { failures.push({ client: 'plugin staging cleanup', message: error.message }); }
    }
  }

  if (adapters.length) {
    const skillError = await writeStandaloneSkill();
    if (skillError) failures.push({ client: 'standalone skill', message: skillError.message });
    for (const adapter of adapters) {
      if (DRY) {
        act(`run ${formatCommand(adapter.bin || adapter.bins[0], adapter.args)}`);
        continue;
      }
      if (!adapter.bin) {
        failures.push({ client: adapter.name, message: 'client state exists but its native CLI is not on PATH' });
        continue;
      }
      try { runNative(adapter.bin, adapter.args); }
      catch (error) { failures.push({ client: adapter.name, message: error.message }); }
    }
  }

  printClientInstructions(clients, adapters);
  return failures;
}

function manifestPin() {
  if (!process.env.COHESIVITY_PLUGIN_MANIFEST_PIN) return { ...PLUGIN_RELEASE, injected: false };
  let pin;
  try { pin = JSON.parse(process.env.COHESIVITY_PLUGIN_MANIFEST_PIN); }
  catch { throw new Error('COHESIVITY_PLUGIN_MANIFEST_PIN is not valid JSON'); }
  return { manifestUrl: pin.url, manifestBytes: pin.bytes, manifestSha256: pin.sha256, injected: true };
}

async function fetchPluginArtifacts(keys) {
  const pin = manifestPin();
  validatePin(pin.manifestUrl, pin.manifestBytes, pin.manifestSha256, 'plugin manifest', pin.injected, 1024 * 1024);
  const manifestBytes = await fetchVerified(pin.manifestUrl, pin.manifestBytes, pin.manifestSha256, 'plugin manifest');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new Error('verified plugin manifest is not valid JSON'); }
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.packages)) {
    throw new Error('verified plugin manifest has an unsupported schema');
  }
  const entries = new Map(manifest.packages.map((entry) => [entry?.client, entry]));

  const result = new Map();
  try {
    for (const key of keys) {
      const entry = entries.get(key);
      if (!entry || typeof entry !== 'object') throw new Error(`plugin manifest has no ${key} artifact`);
      validatePin(entry.immutable_url, entry.size, entry.sha256, `${key} artifact`, pin.injected, 32 * 1024 * 1024);
      if (typeof entry.archive !== 'string' || !entry.archive.endsWith('.tar.gz')) {
        throw new Error(`${key} artifact format must be tar.gz`);
      }
      const archive = await fetchVerified(entry.immutable_url, entry.size, entry.sha256, `${key} artifact`);
      const temporary = mkdtempSync(join(tmpdir(), 'cohesivity-plugin-'));
      try {
        const extracted = join(temporary, 'extracted');
        mkdirSync(extracted, { mode: 0o700 });
        extractTarGzSafely(archive, extracted);
        result.set(key, { root: extracted, temporary });
      } catch (error) {
        rmSync(temporary, { recursive: true, force: true });
        throw error;
      }
    }
    return result;
  } catch (error) {
    for (const artifact of result.values()) rmSync(artifact.temporary, { recursive: true, force: true });
    throw error;
  }
}

function validatePin(url, bytes, sha256, label, injected, maximumBytes) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`${label} URL is invalid`); }
  if ((!injected && parsed.protocol !== 'https:') || (injected && !['http:', 'https:'].includes(parsed.protocol))) {
    throw new Error(`${label} URL must use HTTPS`);
  }
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maximumBytes) throw new Error(`${label} byte-size pin is invalid`);
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new Error(`${label} SHA-256 pin is invalid`);
}

async function fetchVerified(url, expectedBytes, expectedSha256, label) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${label} returned HTTP ${res.status}`);
  const chunks = [];
  let length = 0;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > expectedBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(`${label} byte size ${length} exceeds pinned ${expectedBytes}`);
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks, length);
  if (bytes.length !== expectedBytes) throw new Error(`${label} byte size ${bytes.length} does not match pinned ${expectedBytes}`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expectedSha256) throw new Error(`${label} SHA-256 does not match its pin`);
  return bytes;
}

function extractTarGzSafely(archive, destination) {
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 }); }
  catch (error) { throw new Error(`artifact is not a safe gzip archive (${error.message})`); }
  let offset = 0; let entries = 0; let ended = false;
  const seenPaths = new Set();
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) { ended = true; break; }
    if (++entries > 2048) throw new Error('artifact contains too many entries');
    validateTarChecksum(header);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = validateArchivePath(prefix ? `${prefix}/${name}` : name, true);
    const type = String.fromCharCode(header[156] || 48);
    const size = tarOctal(header, 124, 12, 'size');
    if (size > 32 * 1024 * 1024 || offset + size > tar.length) throw new Error(`artifact entry ${path} has an invalid size`);
    if (path === '.') {
      if (type !== '5' || size !== 0) throw new Error('artifact root entry is not a directory');
      if (seenPaths.has(path)) throw new Error(`artifact path ${path} is duplicated`);
      seenPaths.add(path);
      continue;
    }
    if (seenPaths.has(path)) throw new Error(`artifact path ${path} is duplicated`);
    seenPaths.add(path);
    const target = resolveInside(destination, path);
    if (type === '5') {
      if (size !== 0) throw new Error(`artifact directory ${path} has data`);
      if (existsSync(target) && !lstatSync(target).isDirectory()) throw new Error(`artifact path ${path} is duplicated`);
      mkdirSync(target, { recursive: true, mode: 0o700 });
    } else if (type === '0') {
      if (existsSync(target)) throw new Error(`artifact path ${path} is duplicated`);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const mode = tarOctal(header, 100, 8, 'mode');
      writeFileSync(target, tar.subarray(offset, offset + size), { flag: 'wx', mode: 0o600 | (mode & 0o111) });
    } else if (type === '1' || type === '2') {
      throw new Error(`artifact link ${path} is not allowed`);
    } else {
      throw new Error(`artifact special entry ${path} (type ${JSON.stringify(type)}) is not allowed`);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended) throw new Error('artifact tar is truncated or has no end marker');
}

function tarString(header, start, length) {
  const end = header.indexOf(0, start);
  return header.toString('utf8', start, end >= start && end < start + length ? end : start + length);
}

function tarOctal(header, start, length, field) {
  const value = tarString(header, start, length).trim().replace(/\0/g, '');
  if (!/^[0-7]*$/.test(value)) throw new Error(`artifact tar ${field} is invalid`);
  const parsed = value ? Number.parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`artifact tar ${field} is invalid`);
  return parsed;
}

function validateTarChecksum(header) {
  const expected = tarOctal(header, 148, 8, 'checksum');
  let actual = 0;
  for (let i = 0; i < header.length; i++) actual += i >= 148 && i < 156 ? 32 : header[i];
  if (actual !== expected) throw new Error('artifact tar header checksum is invalid');
}

function validateArchivePath(value, allowDot) {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\\') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error(`artifact path ${JSON.stringify(value)} is unsafe`);
  }
  const rawParts = value.split('/').filter((part) => part !== '');
  if (rawParts.some((part) => part === '..')) throw new Error(`artifact path ${JSON.stringify(value)} is unsafe`);
  const parts = rawParts.filter((part) => part !== '.');
  if (!parts.length) {
    if (allowDot && rawParts.every((part) => part === '.')) return '.';
    throw new Error(`artifact path ${JSON.stringify(value)} is unsafe`);
  }
  return parts.join('/');
}

function resolveInside(root, path) {
  const target = resolve(root, ...path.split('/'));
  const rel = relative(resolve(root), target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`artifact path ${JSON.stringify(path)} escapes extraction root`);
  return target;
}

async function installForClient(client, artifact) {
  if (!artifact) throw new Error(`verified ${client.artifact} artifact is unavailable`);
  const root = artifact.root;
  const nativeSource = ['claude', 'codex', 'gemini', 'openclaw', 'opencode'].includes(client.id)
    || (client.id === 'antigravity' && client.bin)
    ? join(DURABLE_PLUGIN_ROOT, client.id)
    : root;
  if (nativeSource !== root) installDirectoryAtomically(root, nativeSource);
  switch (client.id) {
    case 'claude':
      requireClientCli(client);
      runNative(client.bin, ['plugin', 'marketplace', 'add', nativeSource, '--scope', 'user']);
      runNative(client.bin, ['plugin', 'install', 'cohesivity@cohesivity', '--scope', 'user']);
      break;
    case 'cursor':
      installDirectoryAtomically(root, join(HOME, '.cursor', 'plugins', 'local', 'cohesivity'));
      break;
    case 'codex':
      requireClientCli(client);
      runNative(client.bin, ['plugin', 'marketplace', 'add', nativeSource]);
      runNative(client.bin, ['plugin', 'add', 'cohesivity@cohesivity']);
      break;
    case 'gemini':
      requireClientCli(client);
      runNative(client.bin, existsSync(join(HOME, '.gemini', 'extensions', 'cohesivity'))
        ? ['extensions', 'update', 'cohesivity']
        : ['extensions', 'install', nativeSource, '--consent'], {
        ...process.env,
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
      });
      break;
    case 'antigravity':
      if (client.bin) runNative(client.bin, ['plugin', 'install', nativeSource]);
      else if (hasAny(POSITIVE_ANTIGRAVITY_HOMES)) {
        installDirectoryAtomically(root, join(HOME, '.gemini', 'config', 'plugins', 'cohesivity'));
      } else throw new Error('Antigravity CLI is not on PATH and no positive Antigravity home was found');
      break;
    case 'openclaw':
      requireClientCli(client);
      runNative(client.bin, ['plugins', 'install', 'cohesivity', '--marketplace', nativeSource, '--force']);
      runNative(client.bin, ['plugins', 'enable', 'cohesivity']);
      runNative(client.bin, ['mcp', 'set', 'cohesivity', JSON.stringify({
        url: MCP_URL,
        transport: 'streamable-http',
        auth: 'oauth',
      })]);
      break;
    case 'hermes': {
      requireClientCli(client);
      const skill = join(nativeSource, 'skills', 'cohesivity');
      const packagedServer = join(nativeSource, 'mcp', 'project-bootstrap.mjs');
      const localServer = join(HERMES_HOME, 'mcp', 'cohesivity', 'project-bootstrap.mjs');
      if (!existsSync(join(skill, 'SKILL.md')) || !existsSync(packagedServer)) throw new Error('verified portable artifact is missing its Hermes skill or local MCP server');
      installDirectoryAtomically(skill, join(HERMES_HOME, 'skills', 'cohesivity'));
      installFileAtomically(localServer, readFileSync(packagedServer, 'utf8'));
      const importRoot = mkdtempSync(join(tmpdir(), 'cohesivity-hermes-import-'));
      try {
        mkdirSync(join(importRoot, '.claude'), { mode: 0o700 });
        writeFileSync(join(importRoot, '.claude.json'), JSON.stringify({
          mcpServers: {
            'cohesivity-local': { command: process.execPath, args: [localServer] },
            cohesivity: { url: MCP_URL },
          },
        }), { mode: 0o600 });
        runNative(client.bin, ['import-agent', 'claude-code', '--source', join(importRoot, '.claude'), '--overwrite', '--yes']);
        runNative(client.bin, ['config', 'set', 'mcp_servers.cohesivity-local.enabled', 'true']);
        runNative(client.bin, ['config', 'set', 'mcp_servers.cohesivity.auth', 'oauth']);
        runNative(client.bin, ['config', 'set', 'mcp_servers.cohesivity.enabled', 'true']);
        const local = runNativeJson(client.bin, ['config', 'get', 'mcp_servers.cohesivity-local', '--json']);
        const remote = runNativeJson(client.bin, ['config', 'get', 'mcp_servers.cohesivity', '--json']);
        if (local?.command !== process.execPath || JSON.stringify(local.args) !== JSON.stringify([localServer]) || local?.enabled !== true
          || remote?.url !== MCP_URL || remote?.auth !== 'oauth' || remote?.enabled !== true) {
          throw new Error('Hermes native MCP reconciliation did not persist the exact Cohesivity entries');
        }
      } finally {
        rmSync(importRoot, { recursive: true, force: true });
      }
      break;
    }
    case 'opencode': {
      requireClientCli(client);
      const skill = join(nativeSource, 'skills', 'cohesivity', 'SKILL.md');
      const localServer = join(nativeSource, 'mcp', 'project-bootstrap.mjs');
      if (!existsSync(skill) || !existsSync(localServer)) throw new Error('verified portable artifact is missing its OpenCode skill or local MCP server');
      installFileAtomically(join(CANONICAL_SKILL_DIR, 'SKILL.md'), readFileSync(skill, 'utf8'));
      runNative(client.bin, ['mcp', 'add', 'cohesivity-local', '--', 'node', localServer]);
      runNative(client.bin, ['mcp', 'add', 'cohesivity', '--url', MCP_URL]);
      break;
    }
    default:
      throw new Error(`unknown client ${client.id}`);
  }
}

function requireClientCli(client) {
  if (!client.bin) throw new Error('client state exists but its native CLI is not on PATH');
}

function runNative(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: CWD, encoding: 'utf8', env, shell: false, timeout: 120000 });
  if (result.error) throw new Error(`${formatCommand(command, args)} failed (${result.error.message})`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`${formatCommand(command, args)} exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function runNativeJson(command, args) {
  const result = runNative(command, args);
  try { return JSON.parse(String(result.stdout || '').trim()); }
  catch { throw new Error(`${formatCommand(command, args)} returned invalid JSON`); }
}

function installDirectoryAtomically(source, destination) {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = join(parent, `.${destination.split(/[\\/]/).pop()}.stage-${process.pid}-${Date.now()}`);
  const backup = join(parent, `.${destination.split(/[\\/]/).pop()}.backup-${process.pid}-${Date.now()}`);
  let backedUp = false;
  try {
    copyVerifiedDirectory(source, stage);
    if (existsSync(destination)) { renameSync(destination, backup); backedUp = true; }
    renameSync(stage, destination);
    if (backedUp) { rmSync(backup, { recursive: true, force: true }); backedUp = false; }
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (backedUp && !existsSync(destination)) { renameSync(backup, destination); backedUp = false; }
    throw error;
  } finally {
    if (!backedUp) rmSync(backup, { recursive: true, force: true });
  }
}

function copyVerifiedDirectory(source, destination) {
  const stat = lstatSync(source);
  if (!stat.isDirectory()) throw new Error(`verified plugin root ${source} is not a directory`);
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry); const to = join(destination, entry);
    const child = lstatSync(from);
    if (child.isSymbolicLink()) throw new Error(`verified plugin contains a link at ${from}`);
    if (child.isDirectory()) copyVerifiedDirectory(from, to);
    else if (child.isFile()) writeFileSync(to, readFileSync(from), { flag: 'wx', mode: 0o600 | (child.mode & 0o111) });
    else throw new Error(`verified plugin contains a special file at ${from}`);
  }
}

function installFileAtomically(file, body) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.${file.split(/[\\/]/).pop()}.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function describeDryRunPluginDelivery(clients) {
  const pin = manifestPin();
  act(`fetch and validate plugin manifest ${pin.manifestUrl} (bytes=${pin.manifestBytes}, sha256=${pin.manifestSha256})`);
  for (const key of new Set(clients.map((client) => client.artifact))) {
    act(`fetch, byte-size/SHA-256 validate, and safely extract artifact ${key} from the verified manifest`);
  }
  for (const client of clients) {
    const root = `<verified:${client.artifact}>`;
    const nativeRoot = displayPath(join(DURABLE_PLUGIN_ROOT, client.id));
    if (client.id === 'claude') {
      act(`atomically replace ${nativeRoot} from ${root}`);
      act(`run ${formatCommand(client.bin || 'claude', ['plugin', 'marketplace', 'add', nativeRoot, '--scope', 'user'])}`);
      act(`run ${formatCommand(client.bin || 'claude', ['plugin', 'install', 'cohesivity@cohesivity', '--scope', 'user'])}`);
    } else if (client.id === 'cursor') {
      act(`atomically replace ${displayPath(join(HOME, '.cursor', 'plugins', 'local', 'cohesivity'))} from ${root}`);
    } else if (client.id === 'codex') {
      act(`atomically replace ${nativeRoot} from ${root}`);
      act(`run ${formatCommand(client.bin || 'codex', ['plugin', 'marketplace', 'add', nativeRoot])}`);
      act(`run ${formatCommand(client.bin || 'codex', ['plugin', 'add', 'cohesivity@cohesivity'])}`);
    } else if (client.id === 'gemini') {
      act(`atomically replace ${nativeRoot} from ${root}`);
      act(`run ${formatCommand(client.bin || 'gemini', existsSync(join(HOME, '.gemini', 'extensions', 'cohesivity'))
        ? ['extensions', 'update', 'cohesivity']
        : ['extensions', 'install', nativeRoot, '--consent'])}`);
    } else if (client.id === 'antigravity' && client.bin) {
      act(`atomically replace ${nativeRoot} from ${root}`);
      act(`run ${formatCommand(client.bin, ['plugin', 'install', nativeRoot])}`);
    } else if (client.id === 'antigravity') {
      act(`atomically replace ${displayPath(join(HOME, '.gemini', 'config', 'plugins', 'cohesivity'))} from ${root}`);
    } else if (client.id === 'openclaw') {
      act(`atomically replace ${nativeRoot} from ${root}`);
      act(`run ${formatCommand(client.bin || 'openclaw', ['plugins', 'install', 'cohesivity', '--marketplace', nativeRoot, '--force'])}`);
      act(`run ${formatCommand(client.bin || 'openclaw', ['plugins', 'enable', 'cohesivity'])}`);
      act(`run ${formatCommand(client.bin || 'openclaw', ['mcp', 'set', 'cohesivity', JSON.stringify({ url: MCP_URL, transport: 'streamable-http', auth: 'oauth' })])}`);
    } else if (client.id === 'hermes') {
      act(`atomically replace ${displayPath(join(HERMES_HOME, 'skills', 'cohesivity'))} from ${root}/skills/cohesivity`);
      act(`atomically replace ${displayPath(join(HERMES_HOME, 'mcp', 'cohesivity', 'project-bootstrap.mjs'))} from ${root}/mcp/project-bootstrap.mjs`);
      act(`run ${formatCommand(client.bin || 'hermes', ['import-agent', 'claude-code', '--source', '<generated-cohesivity-import>/.claude', '--overwrite', '--yes'])}`);
      act(`run ${formatCommand(client.bin || 'hermes', ['config', 'set', 'mcp_servers.cohesivity-local.enabled', 'true'])}`);
      act(`run ${formatCommand(client.bin || 'hermes', ['config', 'set', 'mcp_servers.cohesivity.auth', 'oauth'])}`);
      act(`run ${formatCommand(client.bin || 'hermes', ['config', 'set', 'mcp_servers.cohesivity.enabled', 'true'])}`);
    } else if (client.id === 'opencode') {
      act(`atomically replace ${nativeRoot} from ${root}`);
      act(`atomically install ${displayPath(join(CANONICAL_SKILL_DIR, 'SKILL.md'))} from ${nativeRoot}`);
      act(`run ${formatCommand(client.bin || 'opencode', ['mcp', 'add', 'cohesivity-local', '--', 'node', join(DURABLE_PLUGIN_ROOT, 'opencode', 'mcp', 'project-bootstrap.mjs')])}`);
      act(`run ${formatCommand(client.bin || 'opencode', ['mcp', 'add', 'cohesivity', '--url', MCP_URL])}`);
    }
  }
}

function printClientInstructions(clients, adapters) {
  if (!clients.length && !adapters.length) return;
  console.log('');
  log('restart/authentication steps (the installer does not open a browser or start OAuth):');
  for (const client of clients) {
    const instruction = {
      claude: 'Claude: start a new session (or /reload-plugins), then authenticate Cohesivity from /mcp if prompted.',
      cursor: 'Cursor: run Developer: Reload Window, then authenticate Cohesivity in Customize > MCP if prompted.',
      codex: 'Codex: start a new session, open /plugins, and complete Cohesivity authentication if prompted.',
      gemini: 'Gemini: restart the CLI, then run /mcp auth cohesivity if authentication is required.',
      antigravity: 'Antigravity: restart, open /mcp (or Installed MCP Servers), and authenticate Cohesivity.',
      openclaw: 'OpenClaw: restart the Gateway if it did not auto-restart, then run openclaw mcp login cohesivity.',
      hermes: 'Hermes: restart the client; the local bootstrap tools need no login, and hermes mcp login cohesivity starts OAuth through Dynamic Client Registration only when management tools are needed.',
      opencode: 'OpenCode: restart the client; the local bootstrap tools need no login, and opencode mcp auth cohesivity starts OAuth only when management tools are needed.',
    }[client.id];
    console.log(`  - ${instruction}`);
  }
  for (const adapter of adapters) console.log(`  - ${adapter.name}: restart the client and authenticate the Cohesivity MCP server when prompted.`);
}

function displayPath(path) { return path.startsWith(HOME + sep) ? `~${path.slice(HOME.length)}` : path; }
function formatCommand(command, args) { return [command, ...args].map((arg) => /^[A-Za-z0-9_@%+=:,./~<>-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' '); }

// ── 2) create or reuse the project tenant ─────────────────────────────────────
async function ensureTenant() {
  const dotfile = join(CWD, '.cohesivity');
  if (existsSync(dotfile)) {
    const existing = readFileSync(dotfile, 'utf8');
    if (!DRY) ensureGitignore();
    if (!validTenantCredentials(existing, false)) {
      throw new Error('existing .cohesivity is incomplete; repair or remove it before retrying');
    }
    if (DRY) act('ensure .cohesivity is listed in .gitignore');
    log('reusing existing .cohesivity (no new tenant created)');
    return;
  }
  if (DRY) { act(`create a tenant: POST ${BASE}/api/genesis  ->  ./.cohesivity  (+ .gitignore)`); return; }
  ensureGitignore();
  const machineId = readMachineId();
  let body;
  let issuedMachineId = null;
  try {
    const headers = { 'User-Agent': UA };
    if (machineId) headers[MACHINE_ID_HEADER] = machineId;
    const res = await fetch(`${BASE}/api/genesis`, { method: 'POST', headers });
    body = await res.text();
    if (!res.ok) throw new Error(`genesis returned HTTP ${res.status}`);
    // Returned on any request that MINTED an id, which is when we sent none
    // *or* when the id we sent no longer verifies (secret rotated, file
    // corrupted). It is not "non-null exactly when we sent none" — assuming
    // that is what left a machine pinned to a dead id forever.
    issuedMachineId = res.headers.get(MACHINE_ID_HEADER);
  } catch (e) {
    throw new Error(`no tenant created (${e.message}). Re-run to retry; the command is idempotent`);
  }
  if (!validTenantCredentials(body, true)) {
    throw new Error('genesis returned an incomplete credential response; no project credentials were installed');
  }
  installCredentialsAtomically(dotfile, body);
  // Store whatever the server issued. Its presence already means "we minted
  // this for you", so gating on `!machineId` as well dropped every replacement
  // a machine with a stale id was handed: it re-minted on every genesis, kept
  // none of them, and each project became its own machine row.
  if (issuedMachineId) writeMachineId(issuedMachineId);
  log('created an ephemeral tenant -> ./.cohesivity');
}

function credentialValue(body, name) {
  const match = String(body).match(new RegExp(`^${name}=([^\\r\\n]+)$`, 'm'));
  return match?.[1]?.trim() || null;
}

function validTenantCredentials(body, requireBootstrapMetadata) {
  const tenantId = credentialValue(body, 'tenant_id');
  const managementKey = credentialValue(body, 'coh_management_key');
  const applicationKey = credentialValue(body, 'coh_application_key');
  if (!tenantId || !managementKey?.startsWith('coh_man_') || !applicationKey?.startsWith('coh_app_')) return false;
  if (!requireBootstrapMetadata) return true;
  const expiresAt = credentialValue(body, 'expires_at');
  const lifecycle = credentialValue(body, 'tenant_lifecycle');
  const runtimeProfile = credentialValue(body, 'runtime_profile');
  return Boolean(expiresAt && Number.isFinite(Date.parse(expiresAt))
    && (lifecycle === 'ephemeral' || lifecycle === 'claimed')
    && /^v1-[0-9]+$/.test(runtimeProfile || ''));
}

function installCredentialsAtomically(dotfile, body) {
  const temporary = join(CWD, `.cohesivity.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, dotfile);
  } finally {
    rmSync(temporary, { force: true });
  }
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

// ── 3) add a descriptive pointer to an existing AGENTS.md / CLAUDE.md / README ─
// Describe the platform. Never command the agent. The line states a fact: this
// project uses Cohesivity, and the state lives here. Auth stays in .cohesivity
// and the skill. An agent without the skill still learns the project uses
// Cohesivity from this consented, in-repo signal.
const AGENTS_LINE =
  `This project uses [Cohesivity](https://cohesivity.ai) for its managed backend. ` +
  `Credentials and tenant state live in \`.cohesivity\`. Live status is at \`GET ${BASE}/api/status\`.`;

// The README is read by whoever opens the repo cold, which is a different
// audience from an agent already working here: it has no skill installed and no
// reason yet to trust a dotfile it does not recognise. So this line points at
// the status endpoint and the docs rather than at .cohesivity. The URL is the
// public docs page and stays absolute — unlike the API base, it is not
// something a --base override should repoint.
const README_LINE =
  `If you are another agent who just picked up this project, you can get the status of its backend ` +
  `using the status endpoint, read more at https://cohesivity.ai/backend-for-ai-agents`;

const POINTER_FILES = [
  ['AGENTS.md', AGENTS_LINE],
  ['CLAUDE.md', AGENTS_LINE],
  ['README.md', README_LINE],
];

function augmentProjectFiles() {
  // Only touch files that already exist. Never create one unprompted.
  const targets = POINTER_FILES
    .map(([name, line]) => [join(CWD, name), line])
    .filter(([file]) => existsSync(file));
  if (!targets.length) { log('no AGENTS.md / CLAUDE.md / README.md present. Skipping (nothing created)'); return; }
  for (const [file, line] of targets) {
    if (DRY) { act(`add a Cohesivity managed block to ${rel(file)}`); continue; }
    upsertManagedBlock(file, line);
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
function ground(deliveryFailures) {
  const dotfile = join(CWD, '.cohesivity');
  const tid = existsSync(dotfile) ? (readFileSync(dotfile, 'utf8').match(/^tenant_id=(.+)$/m) || [])[1] || '' : '';
  console.log('');
  if (deliveryFailures.length) log(tid ? `tenant ${tid} is ready, but client delivery is incomplete` : 'tenant bootstrap is ready, but client delivery is incomplete');
  else log(tid ? `ready. tenant ${tid}` : 'ready');
  console.log(`  - Keys are in .cohesivity (gitignored, do not commit).`);
  console.log(`  - Provision a service: POST ${BASE}/api/resources/<name>  (Authorization: Bearer <coh_management_key>)`);
  console.log(`  - Per-service docs: ${BASE}/offerings/<name>   \u00b7   full reference: ${BASE}/llms.txt`);
  if (TENANT_ONLY) {
    // No delivery message — tenant-only mode is silent about what it skipped.
  } else if (NO_PLUGIN) {
    console.log(`  - Only the standalone skill was installed at ${displayPath(CANONICAL_SKILL_DIR)}; no plugin or MCP configuration was added.`);
  } else if (deliveryFailures.length) {
    console.log('  - Retry after correcting the delivery errors above; tenant bootstrap is idempotent.');
  } else {
    console.log('  - Detected client integrations are installed. Follow the restart/authentication steps above.');
  }
}

function versionOf(md) {
  return (md.match(/^metadata:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+version:\s*["']?([0-9a-f]{12})["']?\s*$/m) || [])[1] || null;
}

function help() {
  console.log(`
@cohesivity/init v${PKG_VERSION}: set up Cohesivity in this project.

Usage:
  npx @cohesivity/init [options]

Options:
  --runtime <name>    explicit harness label override (normally measured from
                      the process ancestry; use only when the measurement is wrong)
  --no-plugin         install only the canonical standalone skill; add no plugin or MCP
  --dry-run           print what would happen. Make no changes
  --base <url>        API base (default https://cohesivity.ai)
  -h, --help          show this help

What it does:
  1. Detects Claude, Cursor, Codex, Gemini, Antigravity, OpenClaw, Hermes, and OpenCode
     independently and installs each client's native or portable plugin package
     (known adapters without a plugin receive the standalone skill plus MCP)
  2. Creates or reuses a project tenant  ->  ./.cohesivity  (gitignored)
  3. Adds a descriptive pointer to an existing AGENTS.md / CLAUDE.md / README.md
     (never creates any of them)

With --no-plugin, step 1 installs only ~/.agents/skills/cohesivity/SKILL.md.
It adds no plugin or MCP. Steps 2 and 3, including machine attribution and
existing project-pointer behavior, are unchanged.

Plugin supply chain: a pinned immutable manifest supplies every artifact URL,
byte size, SHA-256, archive format, and package root. Archives are verified,
safely extracted without links/traversal/special files, and portable installs
are replaced atomically. Native client commands are invoked without a shell.

Attribution: the tenant-creation call carries a User-Agent of the shape
{npx:<harness>}, where the harness is measured from this process's own
parents. Nothing else about your machine is read or sent, and anything not
inferable is sent as "none".
`);
}

main().catch((e) => { console.error(`cohesivity: setup failed: ${e.message}`); process.exit(1); });
