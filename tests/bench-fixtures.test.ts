// WP-D (r23): functional pins over the migrated the-internet fixture family.
//
// Group 1 — every migrated task's oracle is FALSE on its freshly loaded page
// (a pre-satisfied fixture would make gauntlet cells vacuous). Group 2 — the
// true legs, driven through REAL DOM events (click()/dispatchEvent/
// requestSubmit); direct property writes appear only where the spec sanctions
// them: the select value for t2's user-shaped change, TYPING (focus + value +
// input event) for t3/t5, and window.scrollTo for t13 — then the task's own
// oracle string, read from bench/tasks.json (single source of truth) and
// evaluated by the bench's own evaluateOracle (the real consumer).
//
// The full t9 chain is deliberately NOT duplicated here: only its index-graph
// first hop (t9-support) and the D4 same-URL error banner on /forgot_password
// — the gauntlet owns the chain.
//
// Rig: one ephemeral headless Chrome + one fixture server for the whole file
// (tests/helpers/chrome.ts's exit registry is best-effort; run-tests.mjs's
// WINGMAN_RUN_TOKEN sweep is the leak guarantee). Pages open attach-first
// (Target.createTarget about:blank + flatten attach + Page.navigate — a
// session attached after a navigation has already run evaluates against the
// pre-navigation context) and every page target is closed in a finally, so
// pages never accumulate.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchTestChrome } from './helpers/chrome.js';
import { startFixtureServer, type FixtureServer } from '../src/fixture-server.js';
import { CdpConnection } from '../src/adapters/cdp-connection.js';
import { evaluateOracle } from '../bench/oracle.js';
import { packageRoot } from '../src/package-root.js';

interface BenchTask {
  id: string;
  path: string;
  oracle: string;
  local?: boolean;
  values?: Record<string, string>;
}

// The 12 tasks D6 flipped to "local": true (the migrated the-internet pages;
// t15-t17 were already local against the chain-* family and are not in scope).
const MIGRATED_IDS = [
  't1-checkboxes',
  't2-dropdown',
  't3-dynamic-controls',
  't4-add-elements',
  't5-inputs',
  't6-dynamic-loading',
  't7-sort-table',
  't8-status-404',
  't9-long-chain',
  't12-js-confirm-dialog',
  't13-infinite-scroll',
  't14-key-press',
] as const;

const ALL_TASKS: BenchTask[] = JSON.parse(
  fs.readFileSync(path.join(packageRoot(), 'bench', 'tasks.json'), 'utf8'),
) as BenchTask[];

function taskById(id: string): BenchTask {
  const task = ALL_TASKS.find((t) => t.id === id);
  assert.ok(task, `task ${id} missing from bench/tasks.json`);
  assert.equal(task.local, true, `task ${id} must carry "local": true (WP-C dependency)`);
  return task;
}

type TestChrome = Awaited<ReturnType<typeof launchTestChrome>>;

interface Env {
  chrome: TestChrome;
  fixture: FixtureServer;
  conn: CdpConnection;
}

interface Page {
  targetId: string;
  sessionId: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let env: Env;

before(async () => {
  const chrome = await launchTestChrome();
  try {
    const fixture = await startFixtureServer();
    const conn = await CdpConnection.connect(chrome.endpoint);
    env = { chrome, fixture, conn };
  } catch (e) {
    await chrome.close().catch(() => {});
    throw e;
  }
});

after(async () => {
  if (!env) return;
  await env.conn.close().catch(() => {});
  await env.fixture.close().catch(() => {});
  await env.chrome.close().catch(() => {});
});

// Evaluates in the page's main world over the page session; null on CDP
// failure (a blocked renderer during a dialog, a navigating context).
async function evalJs(page: Page, expression: string, timeoutMs = 8_000): Promise<unknown> {
  const res = await env.conn
    .send<{ result?: { value?: unknown } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true },
      page.sessionId,
      timeoutMs,
    )
    .catch(() => null);
  return res?.result?.value;
}

// Opens fixtureUrl + taskPath attach-first and waits for readyState complete.
async function openTaskPage(taskPath: string): Promise<Page> {
  const url = `${env.fixture.url}${taskPath}`;
  const { targetId } = await env.conn.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
  });
  const { sessionId } = await env.conn.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await env.conn.send('Page.enable', {}, sessionId);
  const page: Page = { targetId, sessionId };
  try {
    // A fresh page's first navigation can occasionally miss the command
    // timeout; retry bounded before giving up (conformance.test.ts pattern).
    for (let attempt = 0; ; attempt++) {
      try {
        await env.conn.send('Page.navigate', { url }, sessionId, 10_000);
        break;
      } catch (e) {
        if (attempt >= 2 || !(e instanceof Error) || !/cdp timeout/.test(e.message)) throw e;
      }
    }
    const deadline = Date.now() + 15_000;
    while ((await evalJs(page, 'document.readyState', 2_000)) !== 'complete') {
      assert.ok(Date.now() < deadline, `page ${taskPath} never reached readyState complete`);
      await sleep(200);
    }
    return page;
  } catch (e) {
    await closePage(page);
    throw e;
  }
}

async function closePage(page: Page): Promise<void> {
  await env.conn.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
}

// Waits until the predicate expression returns true in the page.
async function waitFor(page: Page, expression: string, what: string, deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if ((await evalJs(page, `Boolean(${expression})`, 2_000)) === true) return;
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await sleep(200);
  }
}

// Runs one true-leg scenario: opens the task's own page, runs the real-event
// body, then asserts the task's OWN oracle (verbatim from tasks.json) is true
// through the bench's evaluateOracle.
async function withTaskPage(id: string, body: (page: Page, task: BenchTask) => Promise<void>): Promise<void> {
  const task = taskById(id);
  const page = await openTaskPage(task.path);
  try {
    await body(page, task);
    assert.equal(
      await evaluateOracle(env.conn, page.targetId, task.oracle),
      true,
      `${id}: oracle must be TRUE after the real-event leg on ${task.path}`,
    );
  } finally {
    await closePage(page);
  }
}

// ---------------------------------------------------------------- group 1

test('every migrated oracle is false on its freshly loaded page', async () => {
  for (const id of MIGRATED_IDS) {
    const task = taskById(id);
    const page = await openTaskPage(task.path);
    try {
      assert.equal(
        await evaluateOracle(env.conn, page.targetId, task.oracle),
        false,
        `${id}: oracle must be FALSE on fresh load of ${task.path}`,
      );
    } finally {
      await closePage(page);
    }
  }
});

// ---------------------------------------------------------------- group 2

test('t1: clicking the first checkbox satisfies the oracle', async () => {
  await withTaskPage('t1-checkboxes', async (page) => {
    const ret = await evalJs(
      page,
      `(() => {
        const inputs = document.querySelectorAll('#checkboxes input');
        if (inputs.length !== 2) return 'unexpected input count ' + inputs.length;
        inputs[0].click();
        return 'clicked';
      })()`,
    );
    assert.equal(ret, 'clicked');
  });
});

test('t2: a user-shaped change on the select satisfies the oracle', async () => {
  await withTaskPage('t2-dropdown', async (page) => {
    // Spec-sanctioned shape: focus, set value, dispatch a real change event —
    // the page's own onchange handler then moves the selected attribute.
    const ret = await evalJs(
      page,
      `(() => {
        const s = document.querySelector('#dropdown');
        s.focus();
        s.value = '2';
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return s.value;
      })()`,
    );
    assert.equal(ret, '2');
  });
});

test('t3: Enable then typing into the enabled input satisfies the oracle', async () => {
  await withTaskPage('t3-dynamic-controls', async (page, task) => {
    const clicked = await evalJs(
      page,
      `(() => {
        const b = document.querySelector('#input-example button');
        if (b.textContent !== 'Enable') return 'unexpected button ' + b.textContent;
        b.click();
        return 'clicked';
      })()`,
    );
    assert.equal(clicked, 'clicked');
    // The fixture's swapInput completes at 3000 ms; wait past it.
    await waitFor(page, "!document.querySelector('#input-example input').disabled", 'the input to enable', 10_000);
    // TYPING leg (spec-sanctioned shape): focus + value + input event.
    const typed = await evalJs(
      page,
      `(() => {
        const i = document.querySelector('#input-example input');
        i.focus();
        i.value = ${JSON.stringify(task.values?.note ?? '')};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return i.value;
      })()`,
    );
    assert.equal(typed, task.values?.note);
  });
});

test('t4: three Add Element clicks satisfy the oracle', async () => {
  await withTaskPage('t4-add-elements', async (page) => {
    const ret = await evalJs(
      page,
      `(() => {
        const bs = document.querySelectorAll('button');
        for (let i = 0; i < bs.length; i++) {
          if (bs[i].textContent === 'Add Element') { bs[i].click(); bs[i].click(); bs[i].click(); return 3; }
        }
        return 0;
      })()`,
    );
    assert.equal(ret, 3);
  });
});

test('t5: typing the amount into the number input satisfies the oracle', async () => {
  await withTaskPage('t5-inputs', async (page, task) => {
    const typed = await evalJs(
      page,
      `(() => {
        const i = document.querySelector('input[type=number]');
        i.focus();
        i.value = ${JSON.stringify(task.values?.amount ?? '')};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return i.value;
      })()`,
    );
    assert.equal(typed, task.values?.amount);
  });
});

test('t6: Start plus the 5 s load satisfies the oracle', async () => {
  await withTaskPage('t6-dynamic-loading', async (page) => {
    const clicked = await evalJs(page, `(() => { document.querySelector('#start button').click(); return 'clicked'; })()`);
    assert.equal(clicked, 'clicked');
    await sleep(5_500);
    await waitFor(page, "getComputedStyle(document.querySelector('#finish')).display !== 'none'", '#finish to show', 10_000);
  });
});

test('t7: one Last Name header click satisfies the oracle', async () => {
  await withTaskPage('t7-sort-table', async (page) => {
    const clicked = await evalJs(page, `(() => { document.querySelector('#table1 th').click(); return 'clicked'; })()`);
    assert.equal(clicked, 'clicked');
    // The plain-JS sorter is synchronous; the oracle itself asserts Bach.
  });
});

test('t8: clicking the 404 link satisfies the oracle', async () => {
  await withTaskPage('t8-status-404', async (page) => {
    const clicked = await evalJs(
      page,
      `(() => {
        const a = document.querySelector("a[href='status_codes/404']");
        if (!a) return 'link missing';
        a.click();
        return 'clicked';
      })()`,
    );
    assert.equal(clicked, 'clicked');
    await waitFor(page, "location.pathname === '/status_codes/404'", 'the 404 navigation');
  });
});

// t9-support: only the index graph's first hop — the FULL chain is the
// gauntlet's job and is deliberately not duplicated here.
test('t9-support: the index Checkboxes link navigates', async () => {
  const page = await openTaskPage('/');
  try {
    const clicked = await evalJs(
      page,
      `(() => {
        const a = document.querySelector("a[href='/checkboxes']");
        if (!a) return 'link missing';
        a.click();
        return 'clicked';
      })()`,
    );
    assert.equal(clicked, 'clicked');
    await waitFor(page, "location.pathname === '/checkboxes'", 'the Checkboxes navigation');
    assert.equal(await evalJs(page, 'location.pathname'), '/checkboxes');
  } finally {
    await closePage(page);
  }
});

test('t12: accepting the JS Confirm dialog satisfies the oracle', async () => {
  await withTaskPage('t12-js-confirm-dialog', async (page) => {
    // Real dialog, answered through the adapter's own mechanism
    // (Page.javascriptDialogOpening -> Page.handleJavaScriptDialog accept,
    // the cdp adapter's answerDialog path). Unsubscribed in finally.
    const unsubscribe = env.conn.on('Page.javascriptDialogOpening', (_params, sessionId) => {
      if (!sessionId) return;
      void env.conn.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
    });
    try {
      // Schedule the click so the evaluate returns before confirm() blocks
      // the renderer; the dialog event then lands on the open session.
      const scheduled = await evalJs(
        page,
        `(() => {
          const bs = document.querySelectorAll('button');
          for (let i = 0; i < bs.length; i++) {
            if (bs[i].textContent === 'Click for JS Confirm') {
              const b = bs[i];
              setTimeout(function () { b.click(); }, 0);
              return 'scheduled';
            }
          }
          return 'not-found';
        })()`,
      );
      assert.equal(scheduled, 'scheduled');
      // Polling evals return null while the dialog holds the renderer; the
      // accept above unblocks within milliseconds of the dialog opening.
      await waitFor(page, "document.querySelector('#result').innerText.includes('Ok')", 'the confirm result', 15_000);
    } finally {
      unsubscribe();
    }
  });
});

test('t13: scrolling in a loop satisfies the oracle', async () => {
  await withTaskPage('t13-infinite-scroll', async (page) => {
    // Spec shape: scrollTo + scroll event, >= 12 iterations with ~300 ms
    // gaps (the fixture appends at most one block per 250 ms throttle tick).
    // The dispatched scroll event is what kicks the listener while the short
    // page cannot yet move scrollY.
    for (let i = 0; i < 18; i++) {
      await evalJs(
        page,
        `(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          window.dispatchEvent(new Event('scroll'));
          return true;
        })()`,
        2_000,
      );
      await sleep(320);
      // Minimum 12 iterations always run; break only once the oracle holds.
      if (i >= 11 && (await evaluateOracle(env.conn, page.targetId, taskById('t13-infinite-scroll').oracle))) break;
    }
  });
});

test('t14: a real Escape keydown satisfies the oracle', async () => {
  await withTaskPage('t14-key-press', async (page) => {
    const ret = await evalJs(
      page,
      `(() => {
        const t = document.getElementById('target');
        t.focus();
        t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return document.activeElement === t;
      })()`,
    );
    assert.equal(ret, true);
  });
});

// Not a task oracle — the D4 behavior pin for t9's forgot-password clause
// page: the submit never leaves the page and the error banner renders.
test('forgot_password: requestSubmit renders the same-URL error banner', async () => {
  const page = await openTaskPage('/forgot_password');
  try {
    const ret = await evalJs(
      page,
      `(() => {
        const f = document.getElementById('forgot_password');
        if (!f) return 'form missing';
        f.requestSubmit();
        return 'submitted';
      })()`,
    );
    assert.equal(ret, 'submitted');
    await waitFor(
      page,
      "location.pathname === '/forgot_password' && !!document.querySelector('#flash.error') && document.querySelector('#flash.error').textContent.includes('Internal Server Error')",
      'the D4 same-URL error banner',
    );
  } finally {
    await closePage(page);
  }
});
