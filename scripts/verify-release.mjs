#!/usr/bin/env node
// Read-only release comparison. Importing this module never fetches or runs init.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const CLIENTS = ['portable', 'claude', 'codex', 'gemini', 'antigravity', 'openai'];
const RAW = 'https://raw.githubusercontent.com/cohesivity-org/';
const MAX_BYTES = 64 * 1024 * 1024;
export const fingerprint = (bytes) => ({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const same = (a, b) => a && b && a.size === b.size && a.sha256 === b.sha256;
function capture(source, pattern, label) {
  const value = source.match(pattern)?.[1];
  if (!value) throw new Error(`missing or unsupported ${label}`);
  return value;
}
export function inspectInstaller(source) {
  const skillCommit = capture(source, /^const SKILL_PIN = '([a-f0-9]{40})';$/m, 'immutable installer skill pin');
  return {
    version: capture(source, /^const PKG_VERSION = '([^']+)';$/m, 'installer version'),
    skillUrl: `${RAW}cohesivity-skill/${skillCommit}/cohesivity.skill.md`,
    manifest: {
      url: capture(source, /manifestUrl: '(https:\/\/raw\.githubusercontent\.com\/cohesivity-org\/cohesivity-plugin\/[a-f0-9]{40}\/artifacts\/v[^/]+\/install-manifest\.v1\.json)'/, 'immutable manifest URL'),
      size: Number(capture(source, /manifestBytes: (\d+)/, 'manifest size')),
      sha256: capture(source, /manifestSha256: '([a-f0-9]{64})'/, 'manifest hash'),
    },
  };
}
export function inspectQuickstart(source) {
  return {
    skillUrl: capture(source, /^STANDALONE_SKILL_URL='(https:\/\/raw\.githubusercontent\.com\/cohesivity-org\/cohesivity-skill\/[a-f0-9]{40}\/cohesivity\.skill\.md)'$/m, 'immutable quickstart skill URL'),
    skill: {
      size: Number(capture(source, /^STANDALONE_SKILL_SIZE='(\d+)'$/m, 'quickstart skill size')),
      sha256: capture(source, /^STANDALONE_SKILL_SHA256='([a-f0-9]{64})'$/m, 'quickstart skill hash'),
    },
    archive: {
      url: capture(source, /^PLUGIN_ARCHIVE_URL='(https:\/\/codeload\.github\.com\/cohesivity-org\/cohesivity-plugin\/tar\.gz\/[a-f0-9]{40})'$/m, 'immutable quickstart archive URL'),
      size: Number(capture(source, /^PLUGIN_ARCHIVE_SIZE='(\d+)'$/m, 'quickstart archive size')),
      sha256: capture(source, /^PLUGIN_ARCHIVE_SHA256='([a-f0-9]{64})'$/m, 'quickstart archive hash'),
    },
  };
}

export function verifyRelease(value) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  check(value.installer.skillUrl === value.quickstart.skillUrl, 'npm and quickstart standalone skill URL differ');
  check(value.npmPluginVersion === value.shellPluginVersion, `plugin version differs: npm ${value.npmPluginVersion}, quickstart ${value.shellPluginVersion}`);
  check(same(value.quickstart.skill, value.shellSkill), 'quickstart standalone skill pin does not match downloaded bytes');
  for (const [name, skill] of [['npm standalone skill', value.npmSkill], ['quickstart standalone skill', value.shellSkill]]) {
    check(same(skill, value.canonicalSkill), `${name} differs from the live canonical skill`);
  }
  for (const client of CLIENTS) {
    const npm = value.npmSkills[client];
    const shell = value.shellSkills[client];
    check(npm && shell, `${client} skill is missing from a delivery path`);
    check(same(npm, shell), `${client} skill differs between npm and quickstart`);
    // Claude intentionally adapts frontmatter and installation guidance. Compare
    // its two deliveries exactly, but never demand equality with the core skill.
    if (client !== 'claude') {
      check(same(npm, value.canonicalSkill), `${client} npm skill differs from the live canonical skill`);
      check(same(shell, value.canonicalSkill), `${client} quickstart skill differs from the live canonical skill`);
    }
  }
  return errors;
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error(`${url}: exceeds read limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function verifyPin(bytes, pin, label) {
  if (!same(fingerprint(bytes), pin)) throw new Error(`${label}: byte size or SHA-256 differs from pin`);
  return bytes;
}
// Read tar members in memory only. No archive content is written or executed.
export function readTarGzip(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_BYTES });
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return files;
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join('/');
    const rawSize = field(124, 136).trim();
    if (!/^[0-7]+$/.test(rawSize)) throw new Error('unsupported tar member size');
    const size = parseInt(rawSize, 8);
    const start = offset + 512;
    const end = start + size;
    if (!Number.isSafeInteger(end) || end > tar.length) throw new Error('truncated tar member');
    const type = header[156];
    if (type === 0 || type === 48) {
      if (files.has(name)) throw new Error(`duplicate tar member: ${name}`);
      files.set(name, tar.subarray(start, end));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error('tar archive has no end marker');
}
function member(files, path) {
  const value = files.get(path);
  if (!value) throw new Error(`archive missing ${path}`);
  return value;
}

export async function collectRelease({ source } = {}) {
  let installerBytes;
  let npmVersion;
  let npmTarball;
  if (source) installerBytes = readFileSync(source);
  else {
    const metadata = JSON.parse((await download('https://registry.npmjs.org/@cohesivity%2finit/latest')).toString());
    npmVersion = metadata.version;
    npmTarball = metadata.dist.tarball;
    const archive = await download(npmTarball);
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
    if (integrity !== metadata.dist.integrity) throw new Error('npm tarball integrity mismatch');
    const files = readTarGzip(archive);
    installerBytes = member(files, 'package/bin/cli.js');
    const pkg = JSON.parse(member(files, 'package/package.json').toString());
    if (pkg.version !== npmVersion) throw new Error('npm package version mismatch');
  }
  const installer = inspectInstaller(installerBytes.toString());
  if (npmVersion && npmVersion !== installer.version) throw new Error('npm CLI version mismatch');
  const [quickstartBytes, canonicalBytes, manifestBytes, npmSkillBytes] = await Promise.all([
    download('https://cohesivity.ai/quickstart.sh'), download('https://cohesivity.ai/skill.md'),
    download(installer.manifest.url), download(installer.skillUrl),
  ]);
  verifyPin(manifestBytes, installer.manifest, 'npm plugin manifest');
  const quickstart = inspectQuickstart(quickstartBytes.toString());
  const manifest = JSON.parse(manifestBytes.toString());
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.packages)) throw new Error('unsupported plugin manifest');
  const [shellSkillBytes, shellArchiveBytes] = await Promise.all([download(quickstart.skillUrl), download(quickstart.archive.url)]);
  verifyPin(shellArchiveBytes, quickstart.archive, 'quickstart plugin archive');
  const shellFiles = readTarGzip(shellArchiveBytes);
  const root = `cohesivity-plugin-${quickstart.archive.url.split('/').pop()}`;
  const shellPluginVersion = JSON.parse(member(shellFiles, `${root}/package.json`).toString()).version;
  const shellPaths = {
    portable: 'skills/cohesivity/SKILL.md', claude: 'packages/claude/skills/cohesivity/SKILL.md',
    codex: 'packages/codex/plugins/cohesivity/skills/cohesivity/SKILL.md', gemini: 'packages/gemini/skills/cohesivity/SKILL.md',
    antigravity: 'packages/antigravity/skills/cohesivity/SKILL.md', openai: 'packages/openai/skills/cohesivity/SKILL.md',
  };
  const shellSkills = Object.fromEntries(CLIENTS.map((client) => [client, fingerprint(member(shellFiles, `${root}/${shellPaths[client]}`))]));
  const npmSkills = {};
  for (const client of CLIENTS) {
    const entries = manifest.packages.filter((entry) => entry.client === client);
    if (entries.length !== 1) throw new Error(`expected one ${client} package`);
    const entry = entries[0];
    const archive = await download(entry.immutable_url);
    verifyPin(archive, entry, `${client} npm archive`);
    const files = readTarGzip(archive);
    const path = client === 'codex' ? 'plugins/cohesivity/skills/cohesivity/SKILL.md' : 'skills/cohesivity/SKILL.md';
    const skill = member(files, path);
    verifyPin(skill, entry.files.find((file) => file.path === path), `${client} npm skill`);
    npmSkills[client] = fingerprint(skill);
  }
  return {
    observedAt: new Date().toISOString(), mode: source ? 'source candidate' : 'published npm latest', npmTarball,
    installer, quickstart, canonicalSkill: fingerprint(canonicalBytes), npmSkill: fingerprint(npmSkillBytes), shellSkill: fingerprint(shellSkillBytes),
    npmPluginVersion: manifest.version, shellPluginVersion, npmSkills, shellSkills,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let source;
    let snapshot;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--source' && args[index + 1]) source = args[++index];
      else if (args[index] === '--snapshot' && args[index + 1]) snapshot = args[++index];
      else throw new Error(`unknown or incomplete argument: ${args[index]}`);
    }
    const value = await collectRelease({ source });
    const errors = verifyRelease(value);
    if (errors.length) throw new Error(errors.join('\n'));
    if (snapshot) writeFileSync(snapshot, `${JSON.stringify(value, null, 2)}\n`);
    console.log(`${value.mode}: init ${value.installer.version}, plugin ${value.npmPluginVersion}; all six client skills match quickstart and canonical skill checks pass.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
