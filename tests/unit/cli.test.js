// Static and CLI-surface checks for @cohesivity/init.
//
// No network. `--help` is the only subprocess path that makes no fetch:
// installSkill() calls fetch before it checks --dry-run, so --dry-run is not
// hermetic and is not exercised here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const CLI = join(ROOT, 'bin', 'cli.js');
const cli = readFileSync(CLI, 'utf8');

test('PKG_VERSION matches package.json version', () => {
  const m = cli.match(/^const PKG_VERSION = '([^']+)';$/m);
  assert.ok(m, 'PKG_VERSION not found in bin/cli.js');
  assert.equal(
    m[1],
    pkg.version,
    `bin/cli.js PKG_VERSION ${m[1]} != package.json ${pkg.version}. ` +
      'The version rides in the User-Agent that /api/genesis records, so drift misattributes installs.',
  );
});

test('repository points at the repo that builds this package', () => {
  assert.equal(pkg.repository?.url, 'git+https://github.com/cohesivity-org/cohesivity-init.git');
  assert.equal(pkg.repository?.type, 'git');
});

test('bin entry exists and is executable as a program', () => {
  assert.equal(pkg.bin?.['cohesivity-init'], 'bin/cli.js');
  assert.ok(existsSync(CLI), 'bin/cli.js is missing');
  assert.ok(cli.startsWith('#!/usr/bin/env node\n'), 'bin/cli.js needs a node shebang for npx');
});

test('the published tarball carries bin/ and nothing unexpected', () => {
  assert.deepEqual(pkg.files, ['bin/']);
});

test('no runtime dependencies', () => {
  // Zero deps is the contract: npx resolves nothing before it runs.
  assert.equal(pkg.dependencies, undefined);
  assert.match(pkg.engines.node, />=\s*18/);
});

test('the skill pin is a full immutable commit sha', () => {
  const m = cli.match(/^const SKILL_PIN = '([^']+)';$/m);
  assert.ok(m, 'SKILL_PIN not found in bin/cli.js');
  assert.match(m[1], /^[0-9a-f]{40}$/, 'SKILL_PIN must be a full 40-char sha, not a branch or short sha');
});

test('--help exits 0 and documents every flag the CLI reads', () => {
  const out = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  for (const flag of ['--runtime', '--no-branding', '--dry-run', '--base']) {
    assert.ok(out.includes(flag), `--help does not document ${flag}`);
  }
});
