// WP-H: capability profiles (spec 2026-09-26-wingman-forced-handoff § 5.8a).
// Pure tests: shipped profile data, the derived withheld set, argument rules,
// deny entries, and the user-profile override/skip rules.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadProfiles,
  profileForArgv,
  profileForTools,
  classOfCall,
  withheldClasses,
  toolsFingerprint,
  denyEntries,
  type Profile,
} from '../src/core/profiles.js';
import { CAPABILITY_CLASSES, WITHHOLDABLE_CLASSES } from '../src/contract/constants.js';
import { OPS } from '../src/contract/types.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-profiles-test-'));
}

function shipped(home: string): Profile[] {
  return loadProfiles(home);
}

function findProfile(profiles: Profile[], id: string): Profile {
  const p = profiles.find((x) => x.id === id);
  assert.ok(p, `profile ${id} not loaded`);
  return p;
}

test('both shipped profiles load and validate', () => {
  const home = tmpHome();
  const profiles = shipped(home);
  const pw = findProfile(profiles, 'playwright-mcp');
  const dev = findProfile(profiles, 'chrome-devtools-mcp');
  assert.equal(pw.match_tools.join(','), 'browser_snapshot,browser_click');
  assert.equal(pw.launch.endpoint_env, 'PLAYWRIGHT_MCP_CDP_ENDPOINT');
  assert.equal(pw.launch.endpoint_arg, null);
  assert.equal(pw.arg_rules.length, 0);
  assert.equal(dev.match_tools.join(','), 'take_snapshot,click');
  assert.equal(dev.launch.endpoint_env, null);
  assert.equal(dev.launch.endpoint_arg, '--browserUrl={endpoint}');
  assert.equal(dev.arg_rules.length, 3);
});

test('every tool class in both shipped profiles is a CAPABILITY_CLASSES member', () => {
  const profiles = shipped(tmpHome());
  for (const profile of profiles) {
    for (const [tool, cls] of Object.entries(profile.tools)) {
      assert.ok(
        (CAPABILITY_CLASSES as readonly string[]).includes(cls),
        `${profile.id}: ${tool} has class ${cls}`,
      );
    }
    for (const rule of profile.arg_rules) {
      assert.ok((CAPABILITY_CLASSES as readonly string[]).includes(rule.class));
    }
  }
});

// The 24 tool names of the @playwright/mcp 0.0.80 default tools/list
// (spec C11/C17: 37 mapped names = these 24 + the 10 opt-in names + the 3
// vision-gated *_xy names).
const PLAYWRIGHT_DEFAULT_24 = [
  'browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option',
  'browser_press_key', 'browser_hover', 'browser_file_upload', 'browser_navigate',
  'browser_navigate_back', 'browser_drag', 'browser_drop', 'browser_tabs',
  'browser_handle_dialog', 'browser_snapshot', 'browser_take_screenshot', 'browser_find',
  'browser_console_messages', 'browser_network_requests', 'browser_network_request', 'browser_wait_for',
  'browser_evaluate', 'browser_run_code_unsafe', 'browser_close', 'browser_resize',
];

test('every one of the 0.0.80 default 24 names has a class in the playwright profile', () => {
  const pw = findProfile(shipped(tmpHome()), 'playwright-mcp');
  assert.equal(PLAYWRIGHT_DEFAULT_24.length, 24);
  for (const name of PLAYWRIGHT_DEFAULT_24) {
    assert.ok(pw.tools[name], `${name} has no class`);
  }
});

// The 30 tool names of the chrome-devtools-mcp 1.10.1 tools/list (spec C11).
const DEVTOOLS_30 = [
  'click', 'fill', 'fill_form', 'type_text',
  'press_key', 'hover', 'upload_file', 'navigate_page',
  'drag', 'new_page', 'close_page', 'list_pages',
  'select_page', 'handle_dialog', 'take_snapshot', 'take_screenshot',
  'list_console_messages', 'get_console_message', 'list_network_requests', 'get_network_request',
  'get_css_styles', 'take_heapsnapshot', 'performance_start_trace', 'performance_stop_trace',
  'performance_analyze_insight', 'lighthouse_audit', 'wait_for', 'evaluate_script',
  'emulate', 'resize_page',
];

test('every one of the 1.10.1 30 names has a class in the devtools profile', () => {
  const dev = findProfile(shipped(tmpHome()), 'chrome-devtools-mcp');
  assert.equal(DEVTOOLS_30.length, 30);
  for (const name of DEVTOOLS_30) {
    assert.ok(dev.tools[name], `${name} has no class`);
  }
});

test('profileForArgv and profileForTools pick correctly', () => {
  const profiles = shipped(tmpHome());
  assert.equal(
    profileForArgv(profiles, 'npx', ['-y', '@playwright/mcp@0.0.80'])?.id,
    'playwright-mcp',
  );
  assert.equal(
    profileForArgv(profiles, 'node', ['node_modules/@playwright/mcp/cli.js'])?.id,
    'playwright-mcp',
  );
  assert.equal(
    profileForArgv(profiles, 'npx', ['-y', 'chrome-devtools-mcp@1.10.1'])?.id,
    'chrome-devtools-mcp',
  );
  assert.equal(profileForArgv(profiles, 'node', ['server.js', '--port=1']), null);

  assert.equal(
    profileForTools(profiles, ['browser_snapshot', 'browser_click', 'browser_other'])?.id,
    'playwright-mcp',
  );
  assert.equal(
    profileForTools(profiles, ['take_snapshot', 'click', 'list_pages'])?.id,
    'chrome-devtools-mcp',
  );
  assert.equal(profileForTools(profiles, ['browser_snapshot']), null);
  assert.equal(profileForTools(profiles, ['click']), null);
});

test('classOfCall applies argument rules before the tool map', () => {
  const profiles = shipped(tmpHome());
  const pw = findProfile(profiles, 'playwright-mcp');
  const dev = findProfile(profiles, 'chrome-devtools-mcp');
  assert.equal(classOfCall(pw, 'browser_tabs', { action: 'new', url: 'https://x/' }), 'tabs');
  assert.equal(classOfCall(pw, 'browser_tabs', { action: 'list' }), 'tabs');
  assert.equal(classOfCall(dev, 'navigate_page', { type: 'back' }), 'back');
  assert.equal(classOfCall(dev, 'navigate_page', { type: 'reload' }), 'session');
  assert.equal(classOfCall(dev, 'navigate_page', { type: 'forward' }), 'session');
  assert.equal(classOfCall(dev, 'navigate_page', { type: 'url', url: 'https://x/' }), 'navigate');
  assert.equal(classOfCall(dev, 'new_page', { url: 'https://x/' }), 'tabs');
  assert.equal(classOfCall(dev, 'click', {}), 'element-act');
  assert.equal(classOfCall(pw, 'totally_unknown_tool', {}), 'unknown');
});

test('denyEntries omits tools with a rule to a retained class and includes plain withheld tools', () => {
  const dev = findProfile(shipped(tmpHome()), 'chrome-devtools-mcp');
  const withheld = withheldClasses(OPS, []);
  const result = denyEntries('claude', 's', dev, withheld);
  assert.ok(result, 'claude deny entries expected');
  assert.equal(result.file, 'settings');
  assert.ok(result.entries.includes('mcp__s__click'), 'click is denied');
  assert.ok(!result.entries.includes('mcp__s__navigate_page'), 'navigate_page stays allowed (reload/forward rules)');
  assert.ok(result.entries.includes('mcp__s__fill'));
  assert.ok(!result.entries.includes('mcp__s__take_snapshot'), 'read is retained, never denied');
  assert.ok(result.entries.includes('mcp__s__evaluate_script'), 'script is withheld by default');
});

test('withheldClasses(OPS, []) is all ten withholdable classes', () => {
  assert.deepEqual(withheldClasses(OPS, []), [...WITHHOLDABLE_CLASSES]);
});

test('withheldClasses omits upload when the adapter lacks it (dead-end rule)', () => {
  const withoutUpload = OPS.filter((op) => op !== 'upload');
  const result = withheldClasses(withoutUpload, []);
  assert.ok(!result.includes('upload'));
  assert.ok(result.includes('type'));
});

test('withheldClasses honours retain', () => {
  const result = withheldClasses(OPS, ['scroll']);
  assert.ok(!result.includes('scroll'));
  assert.ok(result.includes('navigate'));
});

test('withheldClasses withholds script by default even though no adapter declares any op for it (operator override of the dead-end rule)', () => {
  const result = withheldClasses([], []);
  assert.ok(result.includes('script'), `script should be withheld regardless of adapter ops: ${result}`);
});

test('withheldClasses honours retain for script', () => {
  const result = withheldClasses(OPS, ['script']);
  assert.ok(!result.includes('script'), `retain: ["script"] should keep it out of the withheld set: ${result}`);
  assert.ok(result.includes('navigate'), 'unrelated classes stay withheld');
});

test('denyEntries shapes per client and returns null for unknown clients', () => {
  const pw = findProfile(shipped(tmpHome()), 'playwright-mcp');
  const withheld = withheldClasses(OPS, []);
  const claude = denyEntries('claude', 'myserver', pw, withheld);
  assert.ok(claude);
  // drag is a retained class, so browser_drag/browser_drop are never denied
  assert.deepEqual(claude, {
    file: 'settings',
    entries: [
      'mcp__myserver__browser_click',
      'mcp__myserver__browser_check',
      'mcp__myserver__browser_uncheck',
      'mcp__myserver__browser_type',
      'mcp__myserver__browser_fill_form',
      'mcp__myserver__browser_press_sequentially',
      'mcp__myserver__browser_select_option',
      'mcp__myserver__browser_press_key',
      'mcp__myserver__browser_hover',
      'mcp__myserver__browser_file_upload',
      'mcp__myserver__browser_navigate',
      'mcp__myserver__browser_navigate_back',
      'mcp__myserver__browser_evaluate',
      'mcp__myserver__browser_run_code_unsafe',
    ],
  });
  const opencode = denyEntries('opencode', 'myserver', pw, withheld);
  assert.ok(opencode);
  assert.equal(opencode.file, 'config');
  assert.deepEqual(opencode.entries, [
    'myserver_browser_click',
    'myserver_browser_check',
    'myserver_browser_uncheck',
    'myserver_browser_type',
    'myserver_browser_fill_form',
    'myserver_browser_press_sequentially',
    'myserver_browser_select_option',
    'myserver_browser_press_key',
    'myserver_browser_hover',
    'myserver_browser_file_upload',
    'myserver_browser_navigate',
    'myserver_browser_navigate_back',
    'myserver_browser_evaluate',
    'myserver_browser_run_code_unsafe',
  ]);
  assert.equal(denyEntries('codex', 'myserver', pw, withheld), null);
});

test('an invalid user profile is skipped with one stderr line naming the file', () => {
  const home = tmpHome();
  const userProfiles = path.join(home, 'profiles');
  fs.mkdirSync(userProfiles, { recursive: true });
  const badFile = path.join(userProfiles, 'broken-tool.json');
  fs.writeFileSync(badFile, JSON.stringify({ id: 'broken-tool', description: 'x', tools: { t: 'not-a-class' } }));

  const lines: string[] = [];
  const orig = console.error;
  console.error = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '));
  };
  let profiles: Profile[];
  try {
    profiles = loadProfiles(home);
  } finally {
    console.error = orig;
  }
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('broken-tool.json'), `stderr line names the file: ${lines[0]}`);
  assert.equal(profiles.find((p) => p.id === 'broken-tool'), undefined);
  // the shipped profiles still load
  assert.ok(profiles.find((p) => p.id === 'playwright-mcp'));
});

test('a user profile with the same id overrides the shipped one', () => {
  const home = tmpHome();
  const userProfiles = path.join(home, 'profiles');
  fs.mkdirSync(userProfiles, { recursive: true });
  fs.writeFileSync(
    path.join(userProfiles, 'playwright-mcp.json'),
    JSON.stringify({
      id: 'playwright-mcp',
      description: 'local override',
      detect: { args_contain: ['@playwright/mcp'], extension_flags: [], endpoint_flags: [] },
      launch: { endpoint_env: 'PLAYWRIGHT_MCP_CDP_ENDPOINT', endpoint_arg: null, strip_args: [] },
      match_tools: ['browser_snapshot'],
      tools: { browser_click: 'unknown', browser_navigate: 'navigate' },
      arg_rules: [],
    }),
  );
  const profiles = loadProfiles(home);
  const pw = findProfile(profiles, 'playwright-mcp');
  assert.equal(pw.description, 'local override');
  assert.deepEqual(Object.entries(pw.tools), [['browser_click', 'unknown'], ['browser_navigate', 'navigate']]);
});

test('toolsFingerprint is stable, order-insensitive and 16 hex chars', () => {
  const a = toolsFingerprint(['b_tool', 'a_tool']);
  const b = toolsFingerprint(['a_tool', 'b_tool']);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, toolsFingerprint(['a_tool', 'c_tool']));
});
