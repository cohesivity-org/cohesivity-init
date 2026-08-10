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
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

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

test('nothing in the package is specific to any vendor or sandbox', () => {
  // A reviewing agent read all 336 lines before running this and called out
  // "hardcoded knowledge of specific sandboxes" — fairly: the package carried
  // an IS_CLAUDE_WEB branch, an IS_SANDBOX check, and a comment naming one
  // vendor's microVM supervisor. The detection was already generic; those made
  // it look targeted, which is its own cost when the reader decides whether to
  // execute the thing.
  for (const s of ['claude-web', 'firecracker', 'process_api', 'IS_SANDBOX', 'IS_CLAUDE_WEB']) {
    assert.ok(!cli.includes(s), `${s} must not appear — detection is generic and should read that way`);
  }
});

test('the README describes what the code actually does', () => {
  // 0.3.5 shipped a README claiming the package sends the raw ancestor-process
  // chain and reads the model out of the agent's session log. Both had been
  // removed (0.3.1 and 0.3.0). A reader auditing before running saw a wider
  // footprint than the code has, which is the worst direction for that error.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(!/model id is read from/i.test(readme), 'no claim of reading a model from a session log');
  assert.ok(!/raw ancestor-process command chain/i.test(readme), 'no claim of sending a chain');
  assert.ok(!/<model>/.test(readme), 'no claim of sending a model id');
  assert.match(readme, /\{npx:<name>\}/, 'states the User-Agent it actually sends');
  assert.match(readme, /no session logs/i, 'states plainly what it does not read');
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
  assert.match(cli, /execFileSync\('ps', \['-o', 'args=', '-p'/, 'argv-safe per-pid fallback for platforms without /proc');
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
  assert.ok(!/\b(?:readSync|openSync|statSync)\b/.test(cli), 'no session-log scanning of harness state');
  assert.ok(!/mmin|mtimeMs/.test(cli), 'no recency scan');
  assert.ok(!/"model/.test(cli), 'no model field vocabulary');
  assert.match(cli, /const UA = `\{npx:\$\{HARNESS\}\}`/, 'UA carries the harness alone');
});

test('the skill pin is a full immutable commit sha', () => {
  const m = cli.match(/^const SKILL_PIN = '([^']+)';$/m);
  assert.ok(m, 'SKILL_PIN not found in bin/cli.js');
  assert.equal(
    m[1],
    '58ee95ac648296e69cac36e7a3eb01f7958e1c1d',
    'init 0.6.0 must install generated skill mirror version 4a7bd4890f4c',
  );
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
const SKILL_REQUEST_FILE = 'skill-requested';
const TEST_SKILL_VERSION = '4a7bd4890f4c';
const TEST_SKILL = `---\nname: cohesivity\nversion: ${TEST_SKILL_VERSION}\n---\n# Cohesivity\n`;

// Stub origin recording what the CLI sent. It echoes the header on any request
// where it MINTS an id — when the caller sent none, and when the caller sent
// one that does not verify. That is the real contract (`resolveMachineId` in
// worker/src/machine-id.js: verify, else mint, and echo only what was minted).
//
// Modelling it as "echo only when the caller sent none" is what hid the bug
// this suite now covers: the client could not be caught dropping a replacement
// because the stub never issued one.
const COMPLETE_GENESIS_BODY = [
  'tenant_id=brave-otter-runs',
  'coh_management_key=coh_man_test_management_key',
  'coh_application_key=coh_app_test_application_key',
  'expires_at=2026-08-13T00:00:00.000Z',
  'tenant_lifecycle=ephemeral',
  'runtime_profile=v1-326',
  '',
].join('\n');

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function tarGz(entries) {
  const chunks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body || '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header[156] = (entry.type || '0').charCodeAt(0);
    if (entry.linkname) header.write(entry.linkname, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { mtime: 0 });
}

function pluginFixture(base, overrides = {}) {
  const definitions = {
    claude: { root: 'packages/claude', entries: [
      { name: 'packages/claude/.claude-plugin/marketplace.json', body: '{"name":"cohesivity"}\n' },
      { name: 'packages/claude/plugin.json', body: '{"name":"cohesivity"}\n' },
    ] },
    portable: { root: 'packages/portable', entries: [
      { name: 'packages/portable/plugin.json', body: '{"name":"cohesivity"}\n' },
      { name: 'packages/portable/skills/cohesivity/SKILL.md', body: TEST_SKILL },
    ] },
    'codex-marketplace': { root: 'codex-marketplace', entries: [
      { name: 'codex-marketplace/.agents/plugins/marketplace.json', body: '{"name":"cohesivity"}\n' },
    ] },
    gemini: { root: 'packages/gemini', entries: [
      { name: 'packages/gemini/gemini-extension.json', body: '{"name":"cohesivity","version":"1.0.0"}\n' },
    ] },
    ...overrides,
  };
  const archives = {};
  const artifacts = {};
  for (const [key, definition] of Object.entries(definitions)) {
    const archive = tarGz(definition.entries);
    archives[`/plugins/${key}.tar.gz`] = archive;
    artifacts[key] = {
      url: `${base}/plugins/${key}.tar.gz`, bytes: archive.length, sha256: sha256(archive),
      format: 'tar.gz', root: definition.root,
    };
  }
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, release: 'test-fixture', artifacts }));
  return {
    archives,
    manifest,
    pin: JSON.stringify({ url: `${base}/plugins/manifest.json`, bytes: manifest.length, sha256: sha256(manifest) }),
  };
}

function withStubOrigin(fn, response = {}) {
  const seen = [];
  const reqs = [];
  const requests = [];
  let plugins;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/api/genesis' && req.method === 'POST') {
      const sent = req.headers['x-cohesivity-machine-id'] || null;
      seen.push(sent);
      reqs.push({ ua: req.headers['user-agent'] || null, ancestry: req.headers['x-cohesivity-ancestry'] || null });
      const headers = { 'Content-Type': 'text/plain' };
      if (!sent) headers['X-Cohesivity-Machine-Id'] = MACHINE_ID;
      else if (!ISSUED_IDS.has(sent)) headers['X-Cohesivity-Machine-Id'] = REPLACEMENT_ID;
      res.writeHead(response.status ?? 201, headers);
      res.end(response.body ?? COMPLETE_GENESIS_BODY);
      return;
    }
    if (req.url === '/plugins/manifest.json' && plugins) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': plugins.manifest.length });
      res.end(plugins.manifest); return;
    }
    if (plugins?.archives[req.url]) {
      const body = plugins.archives[req.url];
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': body.length });
      res.end(body); return;
    }
    res.writeHead(404); res.end('');
  });
  return new Promise((resolve, reject) => {
    server.listen(0, async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      plugins = pluginFixture(base, response.pluginOverrides);
      try { resolve(await fn(base, seen, reqs, plugins, requests)); } catch (e) { reject(e); } finally {
        // closeAllConnections is required: undici holds the connection
        // keep-alive open, and close() alone would wait on it forever.
        server.closeAllConnections();
        server.close();
      }
    });
  });
}

// Runs the real CLI in a throwaway project with a throwaway HOME. A preload
// intercepts only the immutable skill URL, keeping the subprocess tests local
// while preserving the real fetch path for the stub genesis origin.
//
// Must be async: the stub origin shares this process's event loop, so a
// blocking execFileSync would deadlock — the CLI would wait on a response the
// server could not send.
async function runCli(base, home, project, extraArgs = [], options = {}) {
  mkdirSync(project, { recursive: true });
  const fetchStub = join(home, 'fetch-stub.cjs');
  writeFileSync(fetchStub, `
const { appendFileSync } = require('node:fs');
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('https://raw.githubusercontent.com/cohesivity-org/cohesivity-skill/')) {
    appendFileSync(${JSON.stringify(join(home, SKILL_REQUEST_FILE))}, '1\\n');
    return { ok: true, status: 200, text: async () => ${JSON.stringify(TEST_SKILL)} };
  }
  return realFetch(input, init);
};
`);
  const modeArgs = options.plugins ? [] : ['--no-plugin'];
  const result = await run(process.execPath, [join(ROOT, 'bin', 'cli.js'), '--base', base, '--no-branding', ...modeArgs, ...extraArgs], {
    cwd: project,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      COHESIVITY_RUNTIME: 'claude-web',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(fetchStub)}`.trim(),
      ...options.env,
    },
  });
  return options.result ? result : result.stdout;
}

function fakeClients(home, names, failing = null) {
  const bin = join(home, 'test-bin');
  const commandLog = join(home, 'native-commands.jsonl');
  mkdirSync(bin, { recursive: true });
  for (const name of names) {
    const file = join(bin, name);
    writeFileSync(file, `#!${process.execPath}\n` +
      `const { appendFileSync } = require('node:fs');\n` +
      `const { basename } = require('node:path');\n` +
      `const row = { command: basename(process.argv[1]), args: process.argv.slice(2) };\n` +
      `appendFileSync(process.env.COMMAND_LOG, JSON.stringify(row) + '\\n');\n` +
      `if (process.env.FAIL_COMMAND === row.command) { console.error('fixture delivery failure'); process.exit(23); }\n`);
    chmodSync(file, 0o755);
  }
  return {
    commandLog,
    env: { PATH: bin, COMMAND_LOG: commandLog, ...(failing ? { FAIL_COMMAND: failing } : {}) },
  };
}

function readCommands(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

// ── coordinated bootstrap ────────────────────────────────────────────────────

test('--help documents no-plugin mode', async () => {
  const { stdout } = await run(process.execPath, [join(ROOT, 'bin', 'cli.js'), '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(stdout, /--no-plugin/);
  assert.match(stdout, /standalone skill/i);
});

test('--no-plugin creates a fresh attributed tenant with only the canonical skill', async () => {
  await withStubOrigin(async (base, seen, reqs) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'README.md'), '# My app\n');

      const out = await runCli(base, home, project, ['--no-plugin']);

      assert.deepEqual(seen, [null], 'fresh bootstrap calls genesis once without a machine id');
      assert.equal(reqs[0].ua, '{npx:claude-web}', 'bootstrap keeps harness attribution');
      assert.match(readFileSync(join(project, '.cohesivity'), 'utf8'), /^tenant_id=brave-otter-runs$/m);
      assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), '.cohesivity\n');
      assert.equal(readFileSync(join(home, '.config', 'cohesivity', 'machine-id'), 'utf8').trim(), MACHINE_ID);
      assert.equal(readFileSync(join(home, '.agents', 'skills', 'cohesivity', 'SKILL.md'), 'utf8'), TEST_SKILL);
      assert.ok(!existsSync(join(home, '.claude', 'plugins')), 'no Claude plugin is installed');
      assert.ok(existsSync(join(home, SKILL_REQUEST_FILE)), 'the canonical skill is fetched');
      assert.match(readFileSync(join(project, 'README.md'), 'utf8'), /BEGIN:cohesivity/, 'project pointer is preserved');
      assert.match(out, /plugin and MCP installation disabled/i);
      assert.match(out, /Only the standalone skill was installed/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('--no-plugin reuses an existing tenant and preserves project pointers', async () => {
  await withStubOrigin(async (base, seen) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      mkdirSync(join(home, '.cursor'), { recursive: true });
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, '.cohesivity'), 'tenant_id=steady-fox\ncoh_management_key=coh_man_existing\ncoh_application_key=coh_app_existing\n');
      writeFileSync(join(project, 'AGENTS.md'), '# Agents\n');

      const out = await runCli(base, home, project, ['--no-plugin']);

      assert.deepEqual(seen, [], 'an existing tenant is reused without genesis');
      assert.match(out, /reusing existing \.cohesivity/);
      assert.ok(!existsSync(join(home, '.cursor', 'plugins', 'local', 'cohesivity')), 'no Cursor plugin');
      assert.equal(readFileSync(join(home, '.agents', 'skills', 'cohesivity', 'SKILL.md'), 'utf8'), TEST_SKILL);
      assert.match(readFileSync(join(project, 'AGENTS.md'), 'utf8'), /BEGIN:cohesivity/);
      assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), '.cohesivity\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('--no-plugin rejects an incomplete existing credential file but still gitignores it', async () => {
  await withStubOrigin(async (base, seen) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      mkdirSync(project, { recursive: true });
      const incomplete = 'tenant_id=steady-fox\ncoh_management_key=coh_man_existing\n';
      writeFileSync(join(project, '.cohesivity'), incomplete);
      writeFileSync(join(project, 'AGENTS.md'), '# Agents\n');

      await assert.rejects(runCli(base, home, project, ['--no-plugin']));

      assert.deepEqual(seen, []);
      assert.equal(readFileSync(join(project, '.cohesivity'), 'utf8'), incomplete, 'existing credentials are never overwritten');
      assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), '.cohesivity\n');
      assert.equal(readFileSync(join(project, 'AGENTS.md'), 'utf8'), '# Agents\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('--no-plugin fails closed on HTTP errors and incomplete credential responses', async () => {
  for (const response of [
    { status: 429, body: COMPLETE_GENESIS_BODY },
    { status: 201, body: 'tenant_id=incomplete\ncoh_management_key=coh_man_incomplete\n' },
  ]) {
    await withStubOrigin(async (base) => {
      const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
      const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
      try {
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, 'README.md'), '# My app\n');

        await assert.rejects(
          runCli(base, home, project, ['--no-plugin']),
          (error) => {
            assert.doesNotMatch(error.stdout || '', /cohesivity: ready/);
            assert.match(error.stderr || '', /setup failed/i);
            return true;
          },
        );

        assert.ok(!existsSync(join(project, '.cohesivity')), 'failed bootstrap never installs credentials');
        assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), '# My app\n', 'failed bootstrap never writes project pointers');
        assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), '.cohesivity\n', 'ignore contract is established before genesis');
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
      }
    }, response);
  }
});

test('--no-plugin fails before genesis when credentials cannot be gitignored', async () => {
  await withStubOrigin(async (base, seen) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      mkdirSync(project, { recursive: true });
      mkdirSync(join(project, '.gitignore'));
      writeFileSync(join(project, 'README.md'), '# My app\n');

      await assert.rejects(runCli(base, home, project, ['--no-plugin']));

      assert.deepEqual(seen, [], 'genesis is never called without an ignore contract');
      assert.ok(!existsSync(join(project, '.cohesivity')));
      assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), '# My app\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('--no-plugin --dry-run reports bootstrap effects but changes nothing', async () => {
  await withStubOrigin(async (base, seen) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      mkdirSync(join(home, '.codex'), { recursive: true });
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'README.md'), '# My app\n');

      const out = await runCli(base, home, project, ['--no-plugin', '--dry-run']);

      assert.deepEqual(seen, [], 'dry-run never calls genesis');
      assert.ok(!existsSync(join(project, '.cohesivity')));
      assert.ok(!existsSync(join(project, '.gitignore')));
      assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), '# My app\n');
      assert.ok(!existsSync(join(home, '.config', 'cohesivity', 'machine-id')));
      assert.ok(!existsSync(join(home, '.codex', 'skills', 'cohesivity', 'SKILL.md')));
      assert.ok(!existsSync(join(home, SKILL_REQUEST_FILE)), 'dry-run does not fetch the skill');
      assert.match(out, /would create a tenant/);
      assert.match(out, /would add a Cohesivity managed block to README\.md/);
      assert.match(out, /would fetch .*cohesivity-skill.*atomically install the standalone skill/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('plain mode with no detected client installs the canonical standalone skill', async () => {
  await withStubOrigin(async (base, seen) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      const emptyPath = join(home, 'empty-bin');
      mkdirSync(emptyPath);
      const out = await runCli(base, home, project, [], { plugins: true, env: { PATH: emptyPath } });

      assert.deepEqual(seen, [null], 'plain mode creates the tenant');
      assert.equal(readFileSync(join(home, '.agents', 'skills', 'cohesivity', 'SKILL.md'), 'utf8'), TEST_SKILL);
      assert.ok(existsSync(join(home, SKILL_REQUEST_FILE)), 'plain fallback fetches the skill');
      assert.match(out, /no supported client detected/i);
      assert.match(readFileSync(join(project, '.cohesivity'), 'utf8'), /coh_management_key=/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('plain mode detects every supported client independently and uses the Task 17 adapter matrix', async () => {
  await withStubOrigin(async (base, seen, _reqs, plugins, requests) => {
    const root = mkdtempSync(join(tmpdir(), 'coh-matrix-'));
    const home = join(root, 'home with spaces');
    const project = join(root, 'project with spaces');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    const fake = fakeClients(home, ['claude', 'cursor', 'codex', 'gemini', 'agy', 'openclaw', 'hermes']);
    try {
      for (const destination of [
        join(home, '.cursor', 'plugins', 'local', 'cohesivity'),
        join(home, '.hermes', 'plugins', 'cohesivity'),
      ]) {
        mkdirSync(destination, { recursive: true });
        writeFileSync(join(destination, 'stale.txt'), 'remove me\n');
      }
      const out = await runCli(base, home, project, [], {
        plugins: true,
        env: { ...fake.env, COHESIVITY_PLUGIN_MANIFEST_PIN: plugins.pin },
      });

      assert.deepEqual(seen, [null], 'plugin delivery does not replace tenant bootstrap');
      for (const route of ['manifest.json', 'claude.tar.gz', 'portable.tar.gz', 'codex-marketplace.tar.gz', 'gemini.tar.gz']) {
        assert.ok(requests.some((request) => request.includes(route)), `${route} was fetched`);
      }
      const commands = readCommands(fake.commandLog);
      const claudeMarket = commands.find((row) => row.command === 'claude' && row.args.slice(0, 3).join(' ') === 'plugin marketplace add');
      assert.ok(claudeMarket.args[3].endsWith('/extracted/packages/claude'));
      assert.deepEqual(claudeMarket.args.slice(4), ['--scope', 'user']);
      assert.ok(commands.some((row) => row.command === 'claude' && JSON.stringify(row.args) === JSON.stringify(['plugin', 'install', 'cohesivity@cohesivity', '--scope', 'user'])));
      const codexMarket = commands.find((row) => row.command === 'codex' && row.args.slice(0, 3).join(' ') === 'plugin marketplace add');
      assert.ok(codexMarket.args[3].endsWith('/extracted/codex-marketplace'));
      assert.ok(commands.some((row) => row.command === 'codex' && JSON.stringify(row.args) === JSON.stringify(['plugin', 'add', 'cohesivity@cohesivity'])));
      assert.ok(commands.some((row) => row.command === 'gemini' && row.args[0] === 'extensions' && row.args[1] === 'install' && row.args.at(-1) === '--consent'));
      assert.ok(commands.some((row) => row.command === 'agy' && row.args[0] === 'plugin' && row.args[1] === 'install'));
      assert.ok(commands.some((row) => row.command === 'openclaw' && JSON.stringify(row.args.slice(0, 2)) === JSON.stringify(['plugins', 'install']) && row.args.at(-1) === '--force'));
      assert.ok(commands.some((row) => row.command === 'openclaw' && JSON.stringify(row.args) === JSON.stringify(['plugins', 'enable', 'cohesivity'])));
      assert.ok(commands.some((row) => row.command === 'hermes' && JSON.stringify(row.args) === JSON.stringify(['plugins', 'enable', 'cohesivity'])));
      assert.equal(readFileSync(join(home, '.cursor', 'plugins', 'local', 'cohesivity', 'plugin.json'), 'utf8'), '{"name":"cohesivity"}\n');
      assert.equal(readFileSync(join(home, '.hermes', 'plugins', 'cohesivity', 'plugin.json'), 'utf8'), '{"name":"cohesivity"}\n');
      assert.ok(!existsSync(join(home, '.cursor', 'plugins', 'local', 'cohesivity', 'stale.txt')), 'Cursor replacement drops stale files');
      assert.ok(!existsSync(join(home, '.hermes', 'plugins', 'cohesivity', 'stale.txt')), 'Hermes replacement drops stale files');
      assert.ok(!existsSync(join(home, '.agents', 'skills', 'cohesivity')), 'supported packages, not a duplicate standalone skill');
      assert.doesNotMatch(commands.map((row) => row.args.join(' ')).join('\n'), /login|oauth/i, 'OAuth is deferred');
      assert.match(out, /Hermes:.*Dynamic Client Registration/i, 'Hermes caveat is explicit');
      assert.match(out, /restart\/authentication steps/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('Antigravity uses the IDE portable fallback only after positive home detection', async () => {
  await withStubOrigin(async (base, _seen, _reqs, plugins) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    const emptyPath = join(home, 'empty-bin');
    try {
      mkdirSync(join(home, '.gemini', 'antigravity-ide'), { recursive: true });
      mkdirSync(emptyPath);
      const out = await runCli(base, home, project, [], {
        plugins: true,
        env: { PATH: emptyPath, COHESIVITY_PLUGIN_MANIFEST_PIN: plugins.pin },
      });
      assert.equal(readFileSync(join(home, '.gemini', 'config', 'plugins', 'cohesivity', 'plugin.json'), 'utf8'), '{"name":"cohesivity"}\n');
      assert.match(out, /Antigravity integration installed or reconciled/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('unsupported detected adapters receive only the standalone skill and native MCP command', async () => {
  await withStubOrigin(async (base, _seen, _reqs, _plugins, requests) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    const fake = fakeClients(home, ['grok']);
    try {
      await runCli(base, home, project, [], { plugins: true, env: fake.env });
      assert.equal(readFileSync(join(home, '.agents', 'skills', 'cohesivity', 'SKILL.md'), 'utf8'), TEST_SKILL);
      assert.deepEqual(readCommands(fake.commandLog), [{
        command: 'grok', args: ['mcp', 'add', '--transport', 'http', 'cohesivity', 'https://cohesivity.ai/mcp/manage'],
      }]);
      assert.ok(!requests.some((request) => request.includes('/plugins/')), 'fallback adapters need no plugin artifact');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('plugin dry-run prints exact actions without network, commands, or filesystem effects', async () => {
  await withStubOrigin(async (base, seen, _reqs, plugins, requests) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    const fake = fakeClients(home, ['claude', 'cursor', 'codex']);
    try {
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'README.md'), '# Dry\n');
      const out = await runCli(base, home, project, ['--dry-run'], {
        plugins: true,
        env: { ...fake.env, COHESIVITY_PLUGIN_MANIFEST_PIN: plugins.pin },
      });
      assert.deepEqual(seen, []);
      assert.ok(!requests.some((request) => request.includes('/plugins/') || request.includes('/api/genesis')));
      assert.deepEqual(readCommands(fake.commandLog), []);
      assert.ok(!existsSync(join(home, '.cursor', 'plugins')));
      assert.ok(!existsSync(join(project, '.cohesivity')));
      assert.ok(!existsSync(join(project, '.gitignore')));
      assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), '# Dry\n');
      assert.match(out, /would fetch and validate plugin manifest/);
      assert.match(out, /would run .*claude plugin marketplace add <verified:claude> --scope user/);
      assert.match(out, /would atomically replace ~\/\.cursor\/plugins\/local\/cohesivity/);
      assert.match(out, /would create a tenant/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('manifest or native delivery failures still finish tenant bootstrap and exit nonzero', async () => {
  for (const failure of ['manifest', 'command']) {
    await withStubOrigin(async (base, seen, _reqs, plugins) => {
      const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
      const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
      const fake = fakeClients(home, ['claude'], failure === 'command' ? 'claude' : null);
      try {
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, 'README.md'), '# App\n');
        const pin = JSON.parse(plugins.pin);
        if (failure === 'manifest') pin.sha256 = '0'.repeat(64);
        await assert.rejects(
          runCli(base, home, project, [], {
            plugins: true,
            env: { ...fake.env, COHESIVITY_PLUGIN_MANIFEST_PIN: JSON.stringify(pin) },
          }),
          (error) => {
            assert.match(error.stderr || '', /delivery failed for Claude/i);
            assert.match(error.stdout || '', /client delivery is incomplete/i);
            assert.doesNotMatch(error.stdout || '', /cohesivity: ready\b/);
            return true;
          },
        );
        assert.deepEqual(seen, [null]);
        assert.match(readFileSync(join(project, '.cohesivity'), 'utf8'), /coh_management_key=/);
        assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), '.cohesivity\n');
        assert.match(readFileSync(join(project, 'README.md'), 'utf8'), /BEGIN:cohesivity/);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
      }
    });
  }
});

test('unsafe archives are rejected before atomic replacement while tenant bootstrap completes', async () => {
  await withStubOrigin(async (base, seen, _reqs, plugins) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    const destination = join(home, '.cursor', 'plugins', 'local', 'cohesivity');
    try {
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, 'old.txt'), 'keep me\n');
      await assert.rejects(runCli(base, home, project, [], {
        plugins: true,
        env: { PATH: join(home, 'empty-bin'), COHESIVITY_PLUGIN_MANIFEST_PIN: plugins.pin },
      }));
      assert.deepEqual(seen, [null]);
      assert.equal(readFileSync(join(destination, 'old.txt'), 'utf8'), 'keep me\n');
      assert.ok(!existsSync(join(home, 'escaped')));
      assert.ok(existsSync(join(project, '.cohesivity')));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, {
    pluginOverrides: {
      portable: { root: 'packages/portable', entries: [{ name: '../escaped', body: 'bad\n' }] },
    },
  });
});

for (const unsafe of [
  { label: 'symbolic link', entry: { name: 'packages/portable/link', type: '2', linkname: '../../outside' }, error: /artifact link/i },
  { label: 'special file', entry: { name: 'packages/portable/device', type: '3' }, error: /artifact special entry/i },
]) {
  test(`safe extraction rejects a ${unsafe.label}`, async () => {
    await withStubOrigin(async (base, seen, _reqs, plugins) => {
      const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
      const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
      const emptyPath = join(home, 'empty-bin');
      try {
        mkdirSync(join(home, '.cursor'), { recursive: true });
        mkdirSync(emptyPath);
        await assert.rejects(
          runCli(base, home, project, [], {
            plugins: true,
            env: { PATH: emptyPath, COHESIVITY_PLUGIN_MANIFEST_PIN: plugins.pin },
          }),
          (error) => { assert.match(error.stderr || '', unsafe.error); return true; },
        );
        assert.deepEqual(seen, [null], 'tenant bootstrap still completes');
        assert.ok(existsSync(join(project, '.cohesivity')));
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(project, { recursive: true, force: true });
      }
    }, {
      pluginOverrides: { portable: { root: 'packages/portable', entries: [unsafe.entry] } },
    });
  });
}

test('artifact byte-size and SHA-256 pins are enforced before extraction', async () => {
  await withStubOrigin(async (base, seen, _reqs, plugins) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    const emptyPath = join(home, 'empty-bin');
    try {
      mkdirSync(join(home, '.cursor'), { recursive: true });
      mkdirSync(emptyPath);
      const manifest = JSON.parse(plugins.manifest.toString('utf8'));
      manifest.artifacts.portable.sha256 = '0'.repeat(64);
      plugins.manifest = Buffer.from(JSON.stringify(manifest));
      plugins.pin = JSON.stringify({
        url: `${base}/plugins/manifest.json`, bytes: plugins.manifest.length, sha256: sha256(plugins.manifest),
      });
      await assert.rejects(
        runCli(base, home, project, [], {
          plugins: true,
          env: { PATH: emptyPath, COHESIVITY_PLUGIN_MANIFEST_PIN: plugins.pin },
        }),
        (error) => { assert.match(error.stderr || '', /portable artifact SHA-256 does not match/i); return true; },
      );
      assert.deepEqual(seen, [null]);
      assert.ok(existsSync(join(project, '.cohesivity')));
      assert.ok(!existsSync(join(home, '.cursor', 'plugins', 'local', 'cohesivity')));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('plugin pins are isolated placeholders and config formats are never regex-edited', () => {
  assert.match(cli, /const PLUGIN_RELEASE = Object\.freeze\(\{[\s\S]*REPLACE_WITH_FINAL_40_CHAR_COMMIT[\s\S]*REPLACE_WITH_FINAL_64_CHAR_SHA256[\s\S]*\}\);/);
  assert.match(cli, /spawnSync\(command, args, \{[\s\S]*shell: false/);
  assert.doesNotMatch(cli, /config\.(?:json|toml|yaml)[\s\S]{0,100}replace\(/i);
  assert.match(cli, /artifact link .* is not allowed/);
  assert.match(cli, /artifact special entry .* is not allowed/);
});

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

// ── project-file pointers ─────────────────────────────────────────────────────
// Run for real rather than asserted on source text: the failure that matters is
// creating a file the project never had, and that looks identical in the source
// whichever way the existsSync guard points.

test('writes a pointer into AGENTS.md, CLAUDE.md and README.md when they exist', async () => {
  await withStubOrigin(async (base) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'AGENTS.md'), '# Agents\n');
      writeFileSync(join(project, 'CLAUDE.md'), '# Claude\n');
      writeFileSync(join(project, 'README.md'), '# My app\n');
      await runCli(base, home, project);

      const readme = readFileSync(join(project, 'README.md'), 'utf8');
      assert.match(readme, /^# My app$/m, 'the existing content survives');
      assert.match(
        readme,
        /If you are another agent who just picked up this project, you can get the status of its backend using the status endpoint, read more at https:\/\/cohesivity\.ai\/backend-for-ai-agents/,
        'the README line addresses the agent that arrives cold',
      );
      // The README speaks to someone who has not got the skill and has no
      // reason to trust a dotfile yet, so it must not be handed the agent-file
      // line about where the credentials sit.
      assert.ok(!/Credentials and tenant state live in/.test(readme), 'no credential pointer in the README');

      for (const f of ['AGENTS.md', 'CLAUDE.md']) {
        const text = readFileSync(join(project, f), 'utf8');
        assert.match(text, /This project uses \[Cohesivity\]/, `${f} keeps the agent-facing line`);
        assert.ok(!/backend-for-ai-agents/.test(text), `${f} does not get the README line`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('never creates a README the project did not have', async () => {
  // The whole reason README injection was dropped once already: an installer
  // that authors files nobody asked for is an edit the user has to review
  // mid-setup. Annotating one that exists is a different act from creating one.
  await withStubOrigin(async (base) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      const out = await runCli(base, home, project);
      for (const f of ['README.md', 'AGENTS.md', 'CLAUDE.md']) {
        assert.ok(!existsSync(join(project, f)), `${f} must not be created`);
      }
      assert.match(out, /no AGENTS\.md \/ CLAUDE\.md \/ README\.md present/, 'and it says so');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('re-running leaves one pointer block, not two', async () => {
  await withStubOrigin(async (base) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'README.md'), '# My app\n');
      await runCli(base, home, project);
      await runCli(base, home, project);
      const readme = readFileSync(join(project, 'README.md'), 'utf8');
      assert.equal(readme.match(/BEGIN:cohesivity/g).length, 1, 'the managed block is upserted, never duplicated');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

test('--dry-run touches none of the project files', async () => {
  await withStubOrigin(async (base) => {
    const home = mkdtempSync(join(tmpdir(), 'coh-home-'));
    const project = join(mkdtempSync(join(tmpdir(), 'coh-proj-')), 'app');
    try {
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, 'README.md'), '# My app\n');
      const out = await runCli(base, home, project, ['--dry-run']);
      assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), '# My app\n', 'unchanged');
      assert.match(out, /would add a Cohesivity managed block to README\.md/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});
