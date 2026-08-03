// Each check guards a promise the package makes somewhere else, where breaking
// it looks like nothing is wrong.
//
// The machine-id tests run the real CLI as a subprocess against a local stub
// origin, with HOME and XDG_CONFIG_HOME pointed at a temp dir. Asserting on
// source text would not catch the failure that actually matters — writing the
// id to the wrong place, or minting a second one for a machine that already
// has one — because both look correct in the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const cli = readFileSync(join(ROOT, 'bin', 'cli.js'), 'utf8');

test('PKG_VERSION matches package.json version', () => {
  const m = cli.match(/^const PKG_VERSION = '([^']+)';$/m);
  assert.ok(m, 'PKG_VERSION not found in bin/cli.js');
  assert.equal(
    m[1],
    pkg.version,
    `bin/cli.js PKG_VERSION ${m[1]} != package.json ${pkg.version}. ` +
      'The banner names this version, so drift misreports what users are running.',
  );
});

// ── attribution: measured, never asked ───────────────────────────────────────

test('the plumbing denylist contains no harness names', () => {
  const m = cli.match(/const PLUMBING = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, 'PLUMBING set not found');
  for (const harness of ['claude', 'grok', 'codex', 'cursor', 'cursor-agent', 'opencode', 'hermes', 'pi', 'windsurf']) {
    assert.ok(
      !m[1].includes(`'${harness}'`),
      `'${harness}' must never be denied — harnesses name themselves through the chain; the denylist is closed Unix plumbing only`,
    );
  }
});

test('the model state dir is derived by truncating the name, not from a harness list', () => {
  // The binary is cursor-agent but the dir is ~/.cursor; the script is
  // pi-coding-agent but the dir is ~/.pi. Truncating at hyphens is a string
  // rule over the measured name — naming harnesses here would defeat the point.
  assert.match(cli, /n\.slice\(0, n\.lastIndexOf\('-'\)\)/, 'name truncated at hyphens');
  assert.match(cli, /names\.flatMap/, 'every variant contributes roots');
  const attribution = cli.slice(0, cli.indexOf('function skillDirs'));
  for (const harness of ['cursor', 'claude', 'grok', 'codex', 'opencode', 'hermes']) {
    assert.ok(
      !new RegExp(`['"\`.]${harness}['"\`/]`).test(attribution),
      `${harness} must not be named in the attribution path`,
    );
  }
});

test('the model read tries several candidates instead of only the newest file', () => {
  // A harness touches lock / session-env / file-history files alongside its
  // session log, so the most recently written file frequently carries no
  // model. Reporting "none" while the answer sits in the next file loses real
  // data — the pick is ordered and iterated, not single-shot.
  assert.match(cli, /const ordered = \[/, 'candidates are ordered');
  assert.match(cli, /for \(const pick of ordered\)/, 'and iterated until one yields a model');
  assert.ok(!/const pick = files\.find/.test(cli), 'no single-candidate pick remains');
});

test('command arguments are dropped before the chain is sent', () => {
  // A real caller's chain reached the server carrying live AWS credentials,
  // because its parent was `sh -c export AWS_ACCESS_KEY_ID=… …`. Arguments
  // also carry --token flags and, on agent invocations, the user's prompt.
  // argv[0] identifies the harness; arguments are pure liability.
  assert.match(cli, /function reduceEntry/, 'entries are reduced before transmission');
  assert.match(cli, /chain\.push\(reduceEntry\(/, 'the reduction is applied while walking the chain');
  assert.ok(!/\[\^\\w \._:;\(\)\/\+~@=,\|-\]/.test(cli), '= is no longer a transmitted character');
});

test('the ancestry chain starts at the parent, never this process', () => {
  // `node …/cli.js` inferring itself (or the npx shim) as the harness is the
  // self-attribution bug this pins.
  assert.match(cli, /pp\[String\(process\.pid\)\]/, 'chain must start from the parent pid');
  assert.ok(cli.includes(`'npx-cli.js'`), 'the npx shim script is a generic segment');
  assert.ok(cli.includes(`'npm-cli.js'`), 'the npm shim script is a generic segment');
});

test('the skill pin is a full immutable commit sha', () => {
  const m = cli.match(/^const SKILL_PIN = '([^']+)';$/m);
  assert.ok(m, 'SKILL_PIN not found in bin/cli.js');
  assert.match(
    m[1],
    /^[0-9a-f]{40}$/,
    'SKILL_PIN must be a full 40-char sha. A branch or short sha makes the skill a moving target, ' +
      'and the README promises users can audit the exact bytes.',
  );
});

// ── machine id ────────────────────────────────────────────────────────────────

const MACHINE_ID = 'mach_abc123def456ghi789jk.sIgNaTuRe';

// Stub origin recording what the CLI sent. Echoes a machine id header only when
// the caller sent none — the real genesis contract.
function withStubOrigin(fn) {
  const seen = [];
  const reqs = [];
  const server = createServer((req, res) => {
    if (req.url === '/api/genesis' && req.method === 'POST') {
      const sent = req.headers['x-cohesivity-machine-id'] || null;
      seen.push(sent);
      reqs.push({ ua: req.headers['user-agent'] || null, ancestry: req.headers['x-cohesivity-ancestry'] || null });
      const headers = { 'Content-Type': 'text/plain' };
      if (!sent) headers['X-Cohesivity-Machine-Id'] = MACHINE_ID;
      res.writeHead(201, headers);
      res.end('tenant_id=brave-otter-runs\ncoh_management_key=coh_man_t\ncoh_application_key=coh_app_t\n');
      return;
    }
    res.writeHead(404); res.end('');
  });
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try { resolve(await fn(base, seen, reqs)); } catch (e) { reject(e); } finally {
        // closeAllConnections is required: undici holds the connection
        // keep-alive open, and close() alone would wait on it forever.
        server.closeAllConnections();
        server.close();
      }
    });
  });
}

// Runs the real CLI in a throwaway project with a throwaway HOME.
//
// Must be async: the stub origin shares this process's event loop, so a
// blocking execFileSync would deadlock — the CLI would wait on a response the
// server could not send. claude-web is the runtime because it is the one that
// skips the global skill install, keeping the test off the network entirely;
// the machine-id path under test is identical across runtimes.
async function runCli(base, home, project, extraArgs = []) {
  mkdirSync(project, { recursive: true });
  const { stdout } = await run(process.execPath, [join(ROOT, 'bin', 'cli.js'), '--base', base, '--no-branding', ...extraArgs], {
    cwd: project,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), COHESIVITY_RUNTIME: 'claude-web' },
  });
  return stdout;
}

test('genesis carries the measured UA shape and the raw ancestry chain', async () => {
  await withStubOrigin(async (base, seen, reqs) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      await runCli(base, home, project);
      assert.equal(reqs.length, 1);
      // COHESIVITY_RUNTIME=claude-web is the explicit override in runCli, and
      // the throwaway HOME holds no session log, so the model half is "none".
      assert.equal(reqs[0].ua, '{npx:claude-web, none}');
      // The raw chain rides as a header. This test process tree always exists,
      // so on any POSIX CI the header is present and plumbing-shaped.
      assert.ok(reqs[0].ancestry, 'X-Cohesivity-Ancestry sent');
      assert.match(reqs[0].ancestry, /node|npm/, 'chain names the real ancestors');
      assert.ok(reqs[0].ancestry.length <= 800, 'capped');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('a machine with no id is issued one, and it lands outside the project', async () => {
  await withStubOrigin(async (base, seen) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      await runCli(base, home, project);
      assert.deepEqual(seen, [null], 'first run sends no machine id');
      const idFile = join(home, '.config', 'cohesivity', 'machine-id');
      assert.ok(existsSync(idFile), 'the issued id is persisted');
      assert.equal(readFileSync(idFile, 'utf8').trim(), MACHINE_ID);
      // The per-project file must never carry machine state.
      assert.ok(!/machine/i.test(readFileSync(join(project, '.cohesivity'), 'utf8')));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('a second project on the same machine reuses the id instead of minting another', async () => {
  await withStubOrigin(async (base, seen) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const root = mkdtempSync(join(tmpdir(), 'coh-proj-'));
    try {
      await runCli(base, home, join(root, 'one'));
      await runCli(base, home, join(root, 'two'));
      assert.deepEqual(seen, [null, MACHINE_ID], 'the second project sends the id the first was issued');
      assert.equal(readFileSync(join(home, '.config', 'cohesivity', 'machine-id'), 'utf8').trim(), MACHINE_ID);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('--dry-run sends nothing and writes no machine id', async () => {
  await withStubOrigin(async (base, seen) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      await runCli(base, home, project, ['--dry-run']);
      assert.deepEqual(seen, [], 'dry-run never calls genesis');
      assert.ok(!existsSync(join(home, '.config', 'cohesivity', 'machine-id')), 'dry-run changes nothing');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('a garbage machine-id file is ignored rather than sent', async () => {
  await withStubOrigin(async (base, seen) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      mkdirSync(join(home, '.config', 'cohesivity'), { recursive: true });
      writeFileSync(join(home, '.config', 'cohesivity', 'machine-id'), 'not-a-machine-id\n');
      await runCli(base, home, project);
      assert.deepEqual(seen, [null], 'a malformed id is never sent; a fresh one is issued');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('an unwritable config dir does not fail setup', async () => {
  await withStubOrigin(async (base) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      mkdirSync(join(home, '.config'), { recursive: true });
      chmodSync(join(home, '.config'), 0o500);
      const out = await runCli(base, home, project);
      assert.match(out, /created an ephemeral tenant/, 'the tenant is still created');
      assert.ok(!/machine/i.test(out), 'and the id failure is never mentioned');
    } finally {
      chmodSync(join(home, '.config'), 0o700);
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});
