import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { packageRoot } from '../src/package-root.js';
import { startFixtureServer } from '../src/fixture-server.js';

const root = packageRoot();

// These fixture files intentionally contain text that looks like an import
// specifier or a notices marker, so that a real import-boundary/notices run
// against an isolated temp root can flag it. Built from split fragments so
// the literal keywords never appear contiguous in THIS file's own source —
// otherwise this package's own scoped import-boundary/notices gates would
// flag this test file itself.
const KW_FROM = ['fr', 'om'].join('');
const KW_PORTED = ['port', 'ed'].join('');

function run(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: opts.cwd ?? root,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function mkTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rawGet(port: number, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

test('build.mjs scoped build emits BUILD ok', () => {
  const outDir = fs.mkdtempSync(path.join(root, '.build', 'tmp-scaffold-'));
  try {
    const result = run(['scripts/build.mjs', '--out', outDir, 'src/package-root.ts']);
    assert.match(result.stdout, /BUILD: ok out=/);
    assert.equal(result.status, 0);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('build.mjs refuses entries without --out', () => {
  const result = run(['scripts/build.mjs', 'src/package-root.ts']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^Usage: node scripts\/build\.mjs \[--out <dir> <entry\.ts \.\.\.>\]/m);
});

test('build.mjs reports a type error without BUILD ok', () => {
  const outDir = fs.mkdtempSync(path.join(root, '.build', 'tmp-scaffold-'));
  const badEntryDir = fs.mkdtempSync(path.join(root, '.build', 'tmp-scaffold-src-'));
  const badEntry = path.join(badEntryDir, 'bad-entry.ts');
  fs.writeFileSync(badEntry, "const x: number = 'a';\n");
  try {
    const relEntry = path.relative(root, badEntry).split(path.sep).join('/');
    const result = run(['scripts/build.mjs', '--out', outDir, relEntry]);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /BUILD: ok/);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(badEntryDir, { recursive: true, force: true });
  }
});

test('run-tests.mjs fails on a basename that matches nothing', () => {
  const distDir = mkTempDir('wingman-scaffold-dist-');
  const testsDir = path.join(distDir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(
    path.join(testsDir, 'present.test.js'),
    "import test from 'node:test';\ntest('present', () => {});\n",
  );
  try {
    const result = run(['scripts/run-tests.mjs', '--dist', distDir, 'absent']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /No test files matched: absent/);
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

test('run-tests.mjs fails on a file with zero tests', () => {
  const distDir = mkTempDir('wingman-scaffold-dist-');
  const testsDir = path.join(distDir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(path.join(testsDir, 'empty.test.js'), 'export {};\n');
  try {
    const result = run(['scripts/run-tests.mjs', '--dist', distDir, 'empty']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RUN-TESTS: zero tests registered/);
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

test('run-tests.mjs fails on an empty file beside a file with tests', () => {
  const distDir = mkTempDir('wingman-scaffold-dist-');
  const testsDir = path.join(distDir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(path.join(testsDir, 'empty.test.js'), 'export {};\n');
  fs.writeFileSync(
    path.join(testsDir, 'one.test.js'),
    "import test from 'node:test';\ntest('one', () => {});\n",
  );
  try {
    const result = run(['scripts/run-tests.mjs', '--dist', distDir, 'empty', 'one']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RUN-TESTS: zero tests registered: empty\.test\.js/);
    assert.match(result.stdout, /^# tests 2$/m);
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

test('run-tests.mjs fails when the dist has no test files', () => {
  const distDir = mkTempDir('wingman-scaffold-dist-');
  const testsDir = path.join(distDir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  try {
    const result = run(['scripts/run-tests.mjs', '--dist', distDir]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /RUN-TESTS: zero tests registered/);
    assert.doesNotMatch(result.stdout, /RUN-TESTS: files=/);
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

test('run-tests.mjs child env carries no TypeSafe key and a temp WINGMAN_HOME', () => {
  const distDir = mkTempDir('wingman-scaffold-dist-');
  const testsDir = path.join(distDir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(
    path.join(testsDir, 'envcheck.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('envcheck', () => {",
      "  assert.equal(process.env.TYPESAFE_API_KEY, undefined);",
      "  assert.ok(process.env.WINGMAN_HOME && process.env.WINGMAN_HOME.includes('wingman-test-'));",
      '});',
      '',
    ].join('\n'),
  );
  try {
    const result = run(['scripts/run-tests.mjs', '--dist', distDir, 'envcheck'], {
      env: { ...process.env, TYPESAFE_API_KEY: 'dummy-key-should-be-scrubbed' },
    });
    assert.match(result.stdout, /RUN-TESTS: files=1 tests=1 pass=1 fail=0/);
    assert.equal(result.status, 0);
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});

test('import-boundary flags a path outside the package', () => {
  const tmpRoot = mkTempDir('wingman-scaffold-root-');
  try {
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'tmp-pkg' }));
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'bad.ts'),
      `import { log } ${KW_FROM} '../../../pa/src/lib/log.js';\nlog;\n`,
    );
    const result = run([path.join(root, 'scripts', 'gates', 'import-boundary.mjs'), '--root', tmpRoot]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /IMPORT-BOUNDARY: src\/bad\.ts:1 \.\.\/\.\.\/\.\.\/pa\/src\/lib\/log\.js/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('import-boundary flags an undeclared bare package', () => {
  const tmpRoot = mkTempDir('wingman-scaffold-root-');
  try {
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'tmp-pkg', dependencies: { tldts: '^7.4.13' } }),
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'bad.ts'),
      `import leftPad ${KW_FROM} 'left-pad';\nleftPad;\n`,
    );
    const result = run([path.join(root, 'scripts', 'gates', 'import-boundary.mjs'), '--root', tmpRoot]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /IMPORT-BOUNDARY: src\/bad\.ts:1 left-pad/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('notices flags a marker without an entry', () => {
  const tmpRoot = mkTempDir('wingman-scaffold-root-');
  try {
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'src', 'ported.ts'),
      `// ${KW_PORTED} ${KW_FROM} some-repo@1234567 src/thing.ts\nexport {};\n`,
    );
    fs.writeFileSync(path.join(tmpRoot, 'THIRD_PARTY_NOTICES'), 'Third-party notices\n');
    const result = run([path.join(root, 'scripts', 'gates', 'notices.mjs'), '--root', tmpRoot]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /NOTICES: src\/ported\.ts:1 missing entry some-repo@1234567/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('notices flags an entry without a marker', () => {
  const tmpRoot = mkTempDir('wingman-scaffold-root-');
  try {
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'THIRD_PARTY_NOTICES'),
      'Third-party notices\n\n## some-repo@1234567\nCopyright someone.\n',
    );
    const result = run([path.join(root, 'scripts', 'gates', 'notices.mjs'), '--root', tmpRoot]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /NOTICES: entry some-repo@1234567 has no marker/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('packageRoot resolves from a nested build dir', () => {
  const tmpRoot = mkTempDir('wingman-scaffold-pkgroot-');
  try {
    fs.writeFileSync(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'jev-browser-wingman' }),
    );
    const nestedDir = path.join(tmpRoot, '.build', 'a0', 'tests');
    fs.mkdirSync(nestedDir, { recursive: true });
    const nestedFile = path.join(nestedDir, 'fake.js');
    fs.writeFileSync(nestedFile, '// fake\n');
    const resolved = packageRoot(pathToFileURL(nestedFile).href);
    assert.equal(fs.realpathSync(resolved), fs.realpathSync(tmpRoot));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('fixture server serves form.html and 404s traversal', async () => {
  const server = await startFixtureServer();
  try {
    const ok = await fetch(`${server.url}/form.html`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'text/html; charset=utf-8');
    const body = await ok.text();
    assert.match(body, /Order details/);

    const traversal = await rawGet(server.port, '/../secret.html');
    assert.equal(traversal.status, 404);

    const secondSlash = await fetch(`${server.url}/a/b.html`);
    assert.equal(secondSlash.status, 404);

    const missing = await fetch(`${server.url}/does-not-exist.html`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});

test('fixture server sets the persistent cookie on cookie.html', async () => {
  const server = await startFixtureServer();
  try {
    const res = await fetch(`${server.url}/cookie.html`);
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.equal(setCookie, 'wingman_fixture=1; Max-Age=86400; Path=/; SameSite=Lax');
  } finally {
    await server.close();
  }
});
