import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { inspectInstaller, inspectQuickstart, verifyRelease, fingerprint, verifyPin, readTarGzip, inspectClientVersion } from '../../scripts/verify-release.mjs';

const canonical = { size: 123, sha256: 'a'.repeat(64) };
const adapted = { size: 145, sha256: 'b'.repeat(64) };
function observation() {
  return {
    installer: { skillUrl: 'https://example.test/skill', version: '0.7.0' },
    quickstart: { skillUrl: 'https://example.test/skill', skill: canonical },
    canonicalSkill: canonical, npmSkill: canonical, shellSkill: canonical,
    npmPluginVersion: '3.0.5', shellPluginVersion: '3.0.5',
    npmClientVersions: Object.fromEntries(['portable', 'claude', 'codex', 'gemini', 'antigravity', 'openai'].map((client) => [client, '3.0.5'])),
    shellClientVersions: Object.fromEntries(['portable', 'claude', 'codex', 'gemini', 'antigravity', 'openai'].map((client) => [client, '3.0.5'])),
    npmSkills: { portable: canonical, claude: adapted, codex: canonical, gemini: canonical, antigravity: canonical, openai: canonical },
    shellSkills: { portable: canonical, claude: adapted, codex: canonical, gemini: canonical, antigravity: canonical, openai: canonical },
  };
}

test('matching delivery passes while preserving the intentional Claude adapter', () => {
  assert.deepEqual(verifyRelease(observation()), []);
});

test('internally consistent old npm release still fails against quickstart', () => {
  const value = observation();
  value.installer.skillUrl = 'https://example.test/old-skill';
  value.npmSkill = { size: 111, sha256: 'c'.repeat(64) };
  value.npmPluginVersion = '2.1.5';
  for (const client of Object.keys(value.npmSkills)) value.npmSkills[client] = value.npmSkill;
  const errors = verifyRelease(value).join('\n');
  assert.match(errors, /standalone skill URL/);
  assert.match(errors, /plugin version/);
  assert.match(errors, /npm standalone skill/);
});

test('both installers lagging the live canonical skill is detected', () => {
  const value = observation();
  value.canonicalSkill = { size: 999, sha256: 'd'.repeat(64) };
  assert.match(verifyRelease(value).join('\n'), /canonical skill/);
});

test('same plugin version with a different client skill is detected', () => {
  const value = observation();
  value.shellSkills.claude = canonical;
  assert.match(verifyRelease(value).join('\n'), /claude.*differs/);
});

test('missing client and incorrect quickstart integrity pin are detected', () => {
  const value = observation();
  delete value.npmSkills.codex;
  value.quickstart.skill = adapted;
  const errors = verifyRelease(value).join('\n');
  assert.match(errors, /codex.*missing/);
  assert.match(errors, /quickstart standalone skill pin/);
});

test('release pin readers fail closed on missing or mutable references', () => {
  assert.throws(() => inspectInstaller(''), /missing/);
  assert.throws(() => inspectQuickstart(''), /missing/);
  const cli = readFileSync(new URL('../../bin/cli.js', import.meta.url), 'utf8');
  assert.throws(() => inspectInstaller(cli.replace(/const SKILL_PIN = '[^']+'/, "const SKILL_PIN = 'main'")), /immutable installer skill pin/);
  assert.throws(() => inspectInstaller(cli.replace(/cohesivity-plugin\/[a-f0-9]{40}\/artifacts/, 'cohesivity-plugin/main/artifacts')), /immutable manifest URL/);
});

test('checked-in candidate agrees with the independently collected delivery snapshot', () => {
  const value = JSON.parse(readFileSync(new URL('../fixtures/release-observation.json', import.meta.url)));
  const candidate = inspectInstaller(readFileSync(new URL('../../bin/cli.js', import.meta.url), 'utf8'));
  assert.equal(candidate.version, value.installer.version, 'Refresh the release observation when changing the installer version.');
  assert.equal(candidate.skillUrl, value.installer.skillUrl, 'Refresh the release observation when changing the skill pin.');
  assert.deepEqual(candidate.manifest, value.installer.manifest, 'Refresh the release observation when changing the plugin pin.');
  value.installer = candidate;
  assert.deepEqual(verifyRelease(value), []);
});

function tarEntry(name, body) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(body.length.toString(8).padStart(11, '0'), 124);
  header[156] = 48;
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)]);
}

test('read-only archive reader finds exact members and rejects truncation and duplicates', () => {
  const body = Buffer.from('example CLI');
  const entry = tarEntry('package/bin/cli.js', body);
  const end = Buffer.alloc(1024);
  assert.deepEqual(readTarGzip(gzipSync(Buffer.concat([entry, end]))).get('package/bin/cli.js'), body);
  assert.throws(() => readTarGzip(gzipSync(entry.subarray(0, 513))), /truncated/);
  assert.throws(() => readTarGzip(gzipSync(Buffer.concat([entry, entry, end]))), /duplicate/);
  assert.throws(() => readTarGzip(gzipSync(entry)), /end marker/);
});

test('artifact verification rejects changed bytes even when the length matches', () => {
  const bytes = Buffer.from('published skill');
  const pin = fingerprint(bytes);
  assert.equal(verifyPin(bytes, pin, 'skill'), bytes);
  assert.throws(() => verifyPin(Buffer.from('published Skill'), pin, 'skill'), /differs from pin/);
  assert.throws(() => verifyPin(bytes.subarray(1), pin, 'skill'), /differs from pin/);
});

test('an older archive cannot hide behind a current aggregate version and matching skills', () => {
  const value = observation();
  value.npmClientVersions.codex = '2.1.5';
  assert.match(verifyRelease(value).join('\n'), /codex npm package version.*manifest/);
  value.npmClientVersions.codex = '3.0.5';
  value.shellClientVersions.claude = '3.0.4';
  assert.match(verifyRelease(value).join('\n'), /claude quickstart package version/);
});

test('each client version is read from its actual metadata member', () => {
  const paths = {
    portable: 'plugin.json', claude: '.claude-plugin/plugin.json',
    codex: 'plugins/cohesivity/.codex-plugin/plugin.json', gemini: 'gemini-extension.json',
    antigravity: 'plugin.json', openai: '.codex-plugin/plugin.json',
  };
  for (const [client, path] of Object.entries(paths)) {
    const serverPath = client === 'codex' ? 'plugins/cohesivity/mcp/project-bootstrap.mjs' : 'mcp/project-bootstrap.mjs';
    const files = new Map([[path, Buffer.from(JSON.stringify({ version: '3.0.4' }))], [serverPath, Buffer.from('export const SERVER_VERSION = \"3.0.4\";')]]);
    assert.equal(inspectClientVersion(files, client), '3.0.4');
    assert.throws(() => inspectClientVersion(new Map(), client), /missing/);
    files.set(path, Buffer.from('{}'));
    if (client === 'antigravity') assert.equal(inspectClientVersion(files, client), '3.0.4');
    else assert.throws(() => inspectClientVersion(files, client), /version/);
    files.set(path, Buffer.from(JSON.stringify({ version: '3.0.5' })));
    if (client !== 'antigravity') assert.throws(() => inspectClientVersion(files, client), /versions differ/);
    files.set(serverPath, Buffer.from('export const SERVER_VERSION = null;'));
    assert.throws(() => inspectClientVersion(files, client), /server version/);
  }
});
