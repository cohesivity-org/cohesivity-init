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

test('parses processes that rewrite their own title (npm does)', () => {
  // Found by stress-testing 0.3.1 in production: `npx @cohesivity/init@0.3.1
  // --no-branding` produced the harness "init0.3.1--no-branding". npm rewrites
  // its process title, so /proc/<pid>/cmdline arrives as one blob with no NUL
  // separators and argv[0] became the tail of an entire command line.
  assert.match(cli, /argv\.length === 1 && argv\[0\]\.includes\(' '\)/, 're-splits a rewritten title');
  // /proc/<pid>/stat is "pid (comm) state ppid ..." and comm then contains
  // spaces, so the parent must be read after the LAST close-paren.
  assert.match(cli, /split\('\) '\)\.pop\(\)/, 'ppid parsed after the last close-paren');
});

test('pid 1 is examined, not used as the stop condition', () => {
  // Regression: the guard was `pid > 1`, so a process whose parent IS pid 1
  // never entered the loop and reported "none" — every microVM and container
  // entrypoint environment. Strictly additive: the walk breaks at the first
  // non-plumbing ancestor, so pid 1 is only reached by a chain already
  // returning "none", and on an ordinary machine pid 1 is init/systemd, which
  // the denylist rejects.
  assert.match(cli, /pid >= 1/, 'pid 1 is examined');
  assert.ok(!/&& pid > 1/.test(cli), 'the old guard skipped pid 1 entirely');
  const m = cli.match(/const PLUMBING = new Set\('([^']+)'/);
  for (const p1 of ['init', 'systemd', 'launchd']) {
    assert.ok(m[1].split(' ').includes(p1), `${p1} must stay denied so ordinary machines are unaffected`);
  }
});

test('the plumbing denylist contains no harness names', () => {
  const m = cli.match(/const PLUMBING = new Set\('([^']+)'/);
  assert.ok(m, 'PLUMBING set not found');
  const deny = m[1].split(' ');
  for (const harness of ['claude', 'grok', 'codex', 'cursor', 'cursor-agent', 'opencode', 'hermes', 'pi', 'windsurf']) {
    assert.ok(!deny.includes(harness), `${harness} must never be denied — harnesses name themselves`);
  }
  for (const plumbing of ['bash', 'npm', 'npx', 'timeout', 'timelimit', 'init', 'tmux', 'sshd']) {
    assert.ok(deny.includes(plumbing), `${plumbing} is closed-set plumbing`);
  }
});

test('only this process own lineage is read, never the system process list', () => {
  // `ps -eo` dumps every process on the machine with full command lines, which
  // reads as host reconnaissance and is how a third party's exported AWS key
  // reached the server. Walking our own parents needs none of that.
  assert.ok(!/ps -eo/.test(cli), 'never enumerates the process table');
  assert.match(cli, /\/proc\/\$\{pid\}\/cmdline/, 'reads its own ancestors via /proc');
  assert.match(cli, /ps -o args= -p/, 'per-pid fallback for platforms without /proc');
  assert.match(cli, /let pid = process\.ppid/, 'starts at the parent, never itself');
});

test('nothing but the harness name leaves the machine', () => {
  assert.ok(!/X-Cohesivity-Ancestry/.test(cli), 'no ancestry header');
  assert.match(cli, /const UA = `\{npx:\$\{HARNESS\}\}`/, 'the UA carries the harness alone');
});

test('no model-id logic remains: the session log is never read', () => {
  // Removed deliberately. It resolved on ~10% of real installs and required
  // reading the agent's own conversation transcript to get there, which is the
  // most alarming thing this package could do for the least valuable field.
  assert.ok(!/inferModel/.test(cli), 'inferModel is gone');
  assert.ok(!/readSync|openSync|statSync|readdirSync/.test(cli), 'no filesystem scanning of harness state');
  assert.ok(!/mmin|mtimeMs/.test(cli), 'no recency scan');
  assert.ok(!/"model/.test(cli), 'no model field vocabulary');
  assert.match(cli, /const UA = `\{npx:\$\{HARNESS\}\}`/, 'UA carries the harness alone');
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
// What the origin issues in place of an id it cannot verify.
const REPLACEMENT_ID = 'mach_zyx987wvu654tsr321qp.rEpLaCeMeNt';
const ISSUED_IDS = new Set([MACHINE_ID, REPLACEMENT_ID]);

// Stub origin recording what the CLI sent. It echoes the header on any request
// where it MINTS an id — when the caller sent none, and when the caller sent
// one that does not verify. That is the real contract (`resolveMachineId` in
// worker/src/machine-id.js: verify, else mint, and echo only what was minted).
//
// Modelling it as "echo only when the caller sent none" is what hid the bug
// this suite now covers: the client could not be caught dropping a replacement
// because the stub never issued one.
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
      else if (!ISSUED_IDS.has(sent)) headers['X-Cohesivity-Machine-Id'] = REPLACEMENT_ID;
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

test('genesis carries the measured UA and nothing else', async () => {
  await withStubOrigin(async (base, seen, reqs) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      await runCli(base, home, project);
      assert.equal(reqs.length, 1);
      // COHESIVITY_RUNTIME=claude-web is the explicit override in runCli.
      assert.equal(reqs[0].ua, '{npx:claude-web}');
      // Nothing but the UA: no chain, no process data.
      assert.equal(reqs[0].ancestry, null, 'no ancestry header is sent');
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

test('a machine whose id no longer verifies adopts the replacement it is issued', async () => {
  // The recovery path: the origin rotated MACHINE_ID_HMAC_SECRET, or the file
  // was corrupted into something still well-shaped. The id reads back fine and
  // is sent, the origin cannot verify it and mints a replacement. Dropping that
  // replacement re-mints on every genesis forever and turns each project into
  // its own machine row, which is precisely what the id exists to prevent.
  await withStubOrigin(async (base, seen) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const root = mkdtempSync(join(tmpdir(), 'coh-proj-'));
    const stale = 'mach_staleaaaabbbbccccdd.dEaDsIgNaTuRe';
    try {
      mkdirSync(join(home, '.config', 'cohesivity'), { recursive: true });
      writeFileSync(join(home, '.config', 'cohesivity', 'machine-id'), `${stale}\n`);
      await runCli(base, home, join(root, 'one'));
      await runCli(base, home, join(root, 'two'));
      await runCli(base, home, join(root, 'three'));
      // Sent once, replaced, then the replacement is what rides every later run.
      assert.deepEqual(seen, [stale, REPLACEMENT_ID, REPLACEMENT_ID]);
      assert.equal(
        readFileSync(join(home, '.config', 'cohesivity', 'machine-id'), 'utf8').trim(),
        REPLACEMENT_ID,
        'the replacement is persisted, not discarded',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('a healthy id is never rewritten', async () => {
  // The other half: once an id verifies the origin echoes nothing, so the file
  // must be left exactly as it is.
  await withStubOrigin(async (base, seen) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const root = mkdtempSync(join(tmpdir(), 'coh-proj-'));
    try {
      mkdirSync(join(home, '.config', 'cohesivity'), { recursive: true });
      writeFileSync(join(home, '.config', 'cohesivity', 'machine-id'), `${MACHINE_ID}\n`);
      await runCli(base, home, join(root, 'one'));
      await runCli(base, home, join(root, 'two'));
      assert.deepEqual(seen, [MACHINE_ID, MACHINE_ID]);
      assert.equal(
        readFileSync(join(home, '.config', 'cohesivity', 'machine-id'), 'utf8').trim(),
        MACHINE_ID,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
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
