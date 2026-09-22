import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHROME_ARGS,
  HEADED_ARGS,
  OFFSCREEN_ARGS,
  ensureChrome,
  chromeStatus,
  stopChrome,
  profileMarkerMatches,
  profileHolders,
} from '../src/browser/chrome.js';
import { launchTestChrome } from './helpers/chrome.js';

const HOME = '/tmp/wingman-home-test';
const PROFILE = '/tmp/wingman-profile-test';

// probeVersion is checked once before a spawn (step b: is something already
// answering?) and then polled after the spawn (step e's deadline loop). A
// mock that always answers truthy short-circuits step (b) into the reuse
// path and never exercises the spawn code at all — this sequences it: null
// on the first call (nothing answering yet), truthy from the second call on
// (the just-spawned Chrome came up).
function probeAnswersAfterSpawn() {
  let calls = 0;
  return async () => {
    calls++;
    return calls === 1 ? null : { Browser: 'Chrome' };
  };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    isDefaultUserDataDir: () => false,
    profileHolders: async () => ({ withPort: [], withoutPort: [] }),
    probeVersion: async () => null,
    findChrome: () => '/usr/bin/google-chrome',
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    sleep: async () => undefined,
    socketOwnerPid: async () => 999,
    killTree: async () => undefined,
    listChromeProcesses: async () => [],
    processListAvailable: () => true,
    minimiseWindow: async () => undefined,
    randomLaunchId: () => 'abc123abc123abc1',
    now: () => '2026-09-19T00:00:00.000Z',
    platform: 'linux',
    env: {},
    ...overrides,
  };
}

test('refuses the default user-data dir without spawning', async () => {
  let spawnCalled = false;
  const deps = baseDeps({
    isDefaultUserDataDir: () => true,
    directSpawnFn: () => {
      spawnCalled = true;
      return { pid: 1, unref: () => {} } as never;
    },
  });
  const result = await ensureChrome({ port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window: 'offscreen' }, deps as never);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'default-profile');
  assert.equal(spawnCalled, false);
});

test('refuses when a Chrome holds the profile without a debug port and kills nothing', async () => {
  let killed = 0;
  const deps = baseDeps({
    profileHolders: async () => ({ withPort: [], withoutPort: [4242] }),
    killTree: async () => {
      killed++;
    },
  });
  const result = await ensureChrome({ port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window: 'offscreen' }, deps as never);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'foreign-holder');
    assert.deepEqual(result.pids, [4242]);
  }
  assert.equal(killed, 0);
});

test('refuses when the answering Chrome uses another profile', async () => {
  const deps = baseDeps({
    probeVersion: async () => ({ Browser: 'Chrome' }),
    listChromeProcesses: async () => [{ pid: 55, cmdline: `chrome --remote-debugging-port=9333 --user-data-dir=/other/profile` }],
  });
  const result = await ensureChrome({ port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window: 'offscreen' }, deps as never);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'profile-mismatch');
});

test('reuses an answering Chrome on the same profile without spawning', async () => {
  let spawnCalled = false;
  const deps = baseDeps({
    probeVersion: async () => ({ Browser: 'Chrome' }),
    listChromeProcesses: async () => [{ pid: 55, cmdline: `chrome --remote-debugging-port=9333 --user-data-dir=${PROFILE}` }],
    spawnFn: () => {
      spawnCalled = true;
      return { pid: 1, unref: () => {} } as never;
    },
    directSpawnFn: () => {
      spawnCalled = true;
      return { pid: 1, unref: () => {} } as never;
    },
  });
  const result = await ensureChrome({ port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window: 'offscreen' }, deps as never);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.startedByUs, false);
  assert.equal(spawnCalled, false);
});

test('spawns with CHROME_ARGS and records the socket owner pid', async () => {
  const written: Array<Record<string, unknown>> = [];
  let capturedArgs: string[] | null = null;
  const deps = baseDeps({
    platform: 'linux',
    directSpawnFn: (_p: string, args: string[]) => {
      capturedArgs = args;
      return { pid: 111, unref: () => {} } as never;
    },
    probeVersion: probeAnswersAfterSpawn(),
    socketOwnerPid: async () => 222,
    writeFile: async (_path: string, content: string) => {
      written.push(JSON.parse(content));
    },
  });
  const result = await ensureChrome({ port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window: 'offscreen' }, deps as never);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pid, 222);
    assert.equal(result.startedByUs, true);
  }
  const expectedPrefix = CHROME_ARGS(9333, PROFILE);
  assert.deepEqual(capturedArgs!.slice(0, expectedPrefix.length), expectedPrefix);
  const last = written[written.length - 1];
  assert.equal(last.pid, 222);
  assert.equal(last.spawnedPid, 111);
});

test('a spawn that never answers is killed and the pidfile removed', async () => {
  const killedPids: number[] = [];
  let unlinkedPath: string | null = null;
  const deps = baseDeps({
    platform: 'linux',
    directSpawnFn: () => ({ pid: 333, unref: () => {} } as never),
    probeVersion: async () => null,
    listChromeProcesses: async () => [
      { pid: 333, cmdline: `chrome --jevw-launch=abc123abc123abc1 --user-data-dir=${PROFILE}` },
      { pid: 999, cmdline: 'chrome --other' },
    ],
    killTree: async (pid: number) => {
      killedPids.push(pid);
    },
    unlinkFile: async (path: string) => {
      unlinkedPath = path;
    },
  });
  const result = await ensureChrome({ port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window: 'offscreen' }, deps as never);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'timeout');
  assert.deepEqual(killedPids, [333]);
  const capturedUnlinkedPath: unknown = unlinkedPath;
  assert.ok(typeof capturedUnlinkedPath === 'string' && capturedUnlinkedPath.includes('chrome.pid'));
});

test('win32 offscreen, normal and minimized launches go through start /min and never spawn chrome directly', async () => {
  for (const [window, extraArgs] of [
    ['offscreen', [...HEADED_ARGS, ...OFFSCREEN_ARGS]],
    ['normal', [...HEADED_ARGS]],
    ['minimized', [...HEADED_ARGS]],
  ] as const) {
    let directSpawnCalled = false;
    let capturedCmd: string | null = null;
    let capturedArgs: string[] | null = null;
    const deps = baseDeps({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      probeVersion: probeAnswersAfterSpawn(),
      spawnFn: (cmd: string, args: string[]) => {
        capturedCmd = cmd;
        capturedArgs = args;
        return { pid: 111, unref: () => {} } as never;
      },
      directSpawnFn: () => {
        directSpawnCalled = true;
        return { pid: 1, unref: () => {} } as never;
      },
    });
    const result = await ensureChrome(
      { port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window },
      deps as never,
    );
    assert.equal(result.ok, true, `expected ok for ${window}`);
    assert.equal(directSpawnCalled, false);
    assert.equal(capturedCmd, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(capturedArgs!.slice(0, 3), ['/d', '/s', '/c']);
    const expectedChromeArgs = [...CHROME_ARGS(9333, PROFILE), ...extraArgs, '--jevw-launch=abc123abc123abc1'];
    const cmdArg = capturedArgs![3];
    for (const a of expectedChromeArgs) {
      assert.ok(cmdArg.includes(a), `expected cmdArg to include ${a} for ${window}`);
    }
  }
});

test('every launch mode passes an explicit --window-position (WP-X)', async () => {
  // linux: every mode goes through the direct spawn, so one capture point
  // covers all four.
  for (const [window, expectedPos] of [
    ['offscreen', '--window-position=-32000,-32000'],
    ['normal', '--window-position=40,40'],
    ['minimized', '--window-position=40,40'],
    ['headless', '--window-position=40,40'],
  ] as const) {
    let capturedArgs: string[] | null = null;
    const deps = baseDeps({
      platform: 'linux',
      probeVersion: probeAnswersAfterSpawn(),
      directSpawnFn: (_p: string, args: string[]) => {
        capturedArgs = args;
        return { pid: 111, unref: () => {} } as never;
      },
    });
    const result = await ensureChrome({ port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window }, deps as never);
    assert.equal(result.ok, true, `expected ok for ${window}`);
    const pos = capturedArgs!.find((a) => a.startsWith('--window-position='));
    assert.ok(pos, `expected an explicit --window-position in the ${window} launch argv`);
    assert.equal(pos, expectedPos, `unexpected position for ${window}`);
  }
});

test('minimized mode minimises every window of a Chrome it started through Browser.setWindowBounds', async () => {
  let minimiseCalled = 0;
  const deps = baseDeps({
    platform: 'linux',
    probeVersion: probeAnswersAfterSpawn(),
    directSpawnFn: () => ({ pid: 111, unref: () => {} } as never),
    minimiseWindow: async () => {
      minimiseCalled++;
    },
  });
  const result = await ensureChrome({ port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window: 'minimized' }, deps as never);
  assert.equal(result.ok, true);
  assert.equal(minimiseCalled, 1);
});

test('offscreen and normal modes never call Browser.setWindowBounds', async () => {
  for (const window of ['offscreen', 'normal'] as const) {
    let minimiseCalled = 0;
    const deps = baseDeps({
      platform: 'linux',
      probeVersion: probeAnswersAfterSpawn(),
      directSpawnFn: () => ({ pid: 111, unref: () => {} } as never),
      minimiseWindow: async () => {
        minimiseCalled++;
      },
    });
    const result = await ensureChrome({ port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window }, deps as never);
    assert.equal(result.ok, true);
    assert.equal(minimiseCalled, 0, `expected zero minimise calls for ${window}`);
  }
});

test('headless mode spawns chrome directly with --headless=new and never minimises', async () => {
  let minimiseCalled = 0;
  let capturedArgs: string[] | null = null;
  let spawnFnCalled = false;
  const deps = baseDeps({
    platform: 'linux',
    probeVersion: probeAnswersAfterSpawn(),
    directSpawnFn: (_p: string, args: string[]) => {
      capturedArgs = args;
      return { pid: 111, unref: () => {} } as never;
    },
    spawnFn: () => {
      spawnFnCalled = true;
      return { pid: 1, unref: () => {} } as never;
    },
    minimiseWindow: async () => {
      minimiseCalled++;
    },
  });
  const result = await ensureChrome({ port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window: 'headless' }, deps as never);
  assert.equal(result.ok, true);
  assert.equal(spawnFnCalled, false);
  assert.ok(capturedArgs!.includes('--headless=new'));
  assert.equal(minimiseCalled, 0);
});

test('a reused Chrome is never minimised or activated', async () => {
  let minimiseCalled = 0;
  const deps = baseDeps({
    probeVersion: async () => ({ Browser: 'Chrome' }),
    listChromeProcesses: async () => [{ pid: 55, cmdline: `chrome --remote-debugging-port=9333 --user-data-dir=${PROFILE}` }],
    minimiseWindow: async () => {
      minimiseCalled++;
    },
  });
  const result = await ensureChrome({ port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window: 'minimized' }, deps as never);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.startedByUs, false);
  assert.equal(minimiseCalled, 0);
});

test('darwin launches through open -g -n -a when the binary is inside an app bundle', async () => {
  let capturedCmd: string | null = null;
  let capturedArgs: string[] | null = null;
  const deps = baseDeps({
    platform: 'darwin',
    findChrome: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    probeVersion: probeAnswersAfterSpawn(),
    spawnFn: (cmd: string, args: string[]) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return { pid: 111, unref: () => {} } as never;
    },
  });
  const result = await ensureChrome({ port: 9333, profileDir: PROFILE, chromePath: null, home: HOME, window: 'offscreen' }, deps as never);
  assert.equal(result.ok, true);
  assert.equal(capturedCmd, 'open');
  assert.deepEqual(capturedArgs!.slice(0, 4), ['-g', '-n', '-a', '/Applications/Google Chrome.app']);
});

test('stopChrome kills only the pidfile pid with both markers', async () => {
  const killed: number[] = [];
  const deps = {
    readPidFile: async () => ({ pid: 77, port: 9333, profileDir: PROFILE, startedAt: '2026-09-19T00:00:00.000Z' }),
    isAlive: async () => true,
    cmdlineOf: async () => `chrome --remote-debugging-port=9333 --user-data-dir=${PROFILE}`,
    killTree: async (pid: number) => {
      killed.push(pid);
    },
    unlinkFile: async () => undefined,
  };
  const result = await stopChrome({ port: 9333, profileDir: PROFILE, home: HOME }, deps as never);
  assert.deepEqual(result.killed, [77]);
  assert.deepEqual(killed, [77]);
});

test('stopChrome never sweeps other Chromes on the profile', async () => {
  const killed: number[] = [];
  const deps = {
    readPidFile: async () => ({ pid: 77, port: 9333, profileDir: PROFILE, startedAt: '2026-09-19T00:00:00.000Z' }),
    isAlive: async () => true,
    cmdlineOf: async () => `chrome --remote-debugging-port=1111 --user-data-dir=${PROFILE}`,
    killTree: async (pid: number) => {
      killed.push(pid);
    },
    unlinkFile: async () => undefined,
  };
  const result = await stopChrome({ port: 9333, profileDir: PROFILE, home: HOME }, deps as never);
  assert.deepEqual(result.killed, []);
  assert.deepEqual(killed, []);
});

test('CHROME_ARGS equals the PA launcher headed list', () => {
  const expected = [
    '--remote-debugging-port=9333',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session=false',
    '--window-size=1280,800',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,TabDiscarding,TabFreezing,IntensiveWakeUpThrottling',
  ];
  assert.deepEqual(CHROME_ARGS(9333, PROFILE), expected);
});

test('profileMarkerMatches rejects a sibling dir prefix', () => {
  assert.equal(profileMarkerMatches(`chrome --user-data-dir=${PROFILE}2`, PROFILE), false);
  assert.equal(profileMarkerMatches(`chrome --user-data-dir=${PROFILE}`, PROFILE), true);
});

test('profileHolders counts Chrome child processes (--type=) as non-holders (OG-1)', async () => {
  const ours = 'C:\\Users\\u\\AppData\\Local\\Temp\\wingman-ephemeral-x';
  const other = 'C:\\Users\\u\\AppData\\Local\\Temp\\other-profile';
  // Realistic Windows cmdlines: quoted exe path, embedded quoting on the
  // profile dir, plus the switches chrome.exe actually carries on win32.
  const listChromeProcesses = async () => [
    // (a) main browser process on OUR profile with the debug port -> holder, withPort
    { pid: 58260, cmdline: `"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 "--user-data-dir=${ours}" --no-first-run` },
    // (b) chrome's own gpu child on OUR profile, no port -> NOT a holder
    { pid: 48536, cmdline: `"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" --type=gpu-process "--user-data-dir=${ours}" --mojo-platform-channel-handle=...` },
    // (c) chrome's own crashpad child on OUR profile, no port -> NOT a holder
    { pid: 17244, cmdline: `"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" --type=crashpad-handler "--user-data-dir=${ours}"` },
    // (d) foreign main browser process on ANOTHER profile, no port -> holder, withoutPort
    { pid: 23612, cmdline: `"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" "--user-data-dir=${other}"` },
  ];
  // On OUR profile: only the main process is a holder; the --type= children are
  // excluded, and the foreign chrome is not a holder of this profile at all.
  const oursResult = await profileHolders(ours, { listChromeProcesses });
  assert.deepEqual(oursResult.withPort, [{ pid: 58260, port: 9222 }]);
  assert.deepEqual(oursResult.withoutPort, []);
  // On the FOREIGN profile: its main process is still a holder without a port
  // (this is what the G4 / V4 / profile-safe gate must keep catching).
  const otherResult = await profileHolders(other, { listChromeProcesses });
  assert.deepEqual(otherResult.withPort, []);
  assert.deepEqual(otherResult.withoutPort, [23612]);
});


test('launchEphemeralChrome returns an answering endpoint and close removes the profile', async () => {
  const chrome = await launchTestChrome();
  try {
    assert.ok(chrome.endpoint.startsWith('http://127.0.0.1:'));
    const status = await chromeStatus({ port: chrome.port, profileDir: chrome.profileDir, home: HOME });
    assert.equal(status.answering, true);
  } finally {
    await chrome.close();
  }
  const status = await chromeStatus({ port: chrome.port, profileDir: chrome.profileDir, home: HOME });
  assert.equal(status.answering, false);
});
