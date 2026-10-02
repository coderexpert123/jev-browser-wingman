# r17 WP-B mutant proof (.build-r17-spec.md, WP-B "Mutant runner").
# Run from the repo root AFTER WP-A and WP-B have landed:  python .build-r17-mutants.py
#
# WP-A shipped every KB proof flag as `const KB_<id> = false;` composed into
# the condition it guards ("never flip" comment shape). This runner flips one
# flag at a time to true in its owning src file, builds the unit test entries
# into .build/kb-r17, runs the mapped test file(s), and expects EVERY mapped
# pinned test title to appear among the FAILING tests. src files are restored
# byte-identically (sha256) in a finally block; .build/r17-b is rebuilt clean
# afterwards (a KB-proof run poisons a scoped .build until it is rebuilt).
#
# The cloud-deferred flags whose proofs need a real Chrome (page-scripts'
# hidden-sibling flag plus the CDP adapter's three) are asserted present and
# reported DEFERRED-CLOUD — the cloud KB-r17c run owns their live proof (spec,
# cloud gate step 3). KB_PW_CHECK_TOGGLE is the one adapter flag proven HERE:
# its leg is a Chrome-backed adapter-playwright test (added 2026-10-02, the
# flag was vacuous before), run in isolation inside the serial UNIT loop.
# Exit 0 only when every unit flag's mapped tests failed and every restore
# matched.

import hashlib, io, re, subprocess, sys

ROOT = '.'
SRC = {
    'loop': 'src/core/loop.ts',
    'page-scripts': 'src/core/page-scripts.ts',
    'cdp': 'src/adapters/cdp.ts',
    'playwright': 'src/adapters/playwright.ts',
}
BUILD_ENTRIES = ['tests/chain.test.ts', 'tests/loop.test.ts', 'tests/adapter-playwright.test.ts']
OUT = '.build/kb-r17'

# (flag, file, [(test basename, expected failing test title prefix), ...])
UNIT = [
    ('KB_PRESS_NONE', 'loop', [
        ('chain', 'T-press-none commits a targetless press'),
        ('chain', 'T-press-none is never margin-stolen'),
        ('loop', 'wingman_do press-none commits a targetless press'),
    ]),
    ('KB_PRESS_IRREV', 'loop', [
        ('chain', 'T-press-none refuses on irreversible'),
        ('loop', 'wingman_do press-none with irreversible refuses'),
    ]),
    ('KB_FOCUS_PROMOTE', 'loop', [
        ('chain', 'T-key-advance on focus moved'),
    ]),
    ('KB_KEY_EVIDENCE', 'loop', [
        ('chain', 'T-key-advance on focus moved'),
        ('chain', 'T-key-advance on page changed'),
    ]),
    ('KB_PRESS_KEY_EQ', 'loop', [
        ('chain', 'T-press different keys is not a repeat'),
    ]),
    ('KB_SIGNAL_SCROLL', 'loop', [
        ('chain', 'T-scroll carries a signal and repeat scroll bounces'),
        ('chain', 'T-count-met advances on scroll evidence'),
    ]),
    ('KB_SCROLL_NOSKIP', 'loop', [
        ('chain', 'T-scroll shadow: click twice, scroll, click'),
    ]),
    ('KB_COUNT_MET', 'loop', [
        ('chain', 'T-count-met advances on scroll evidence'),
        ('chain', 'T-count-met advances with zero scrolls when the page already has them'),
    ]),
    ('KB_DIALOG_ANSWER', 'loop', [
        ('chain', 'T-dialog answered accept per the step'),
        ('chain', 'T-dialog answered dismiss'),
        ('chain', 'T-round-top dialog answered then round continues'),
        ('loop', 'wingman_do token act answers the page dialog per the goal text'),
    ]),
    ('KB_LOGIN_SUPPRESS', 'loop', [
        ('chain', 'T-login suppressed by named bindings'),
        ('chain', 'T-login suppressed on progress'),
        ('chain', 'T-login suppressed on resume'),
        ('chain', 'T-login suppressed on wingman_do via the goal'),
    ]),
    ('KB_CHECK_FLIP', 'loop', [
        ('chain', 'T-check-flip advances on the act-returned flip'),
    ]),
    # KB_PW_CHECK_TOGGLE's proof was VACUOUS until 2026-10-02 (verifier): no
    # test drove a bare-sibling-label check through the playwright adapter.
    # The adapter-playwright leg below launches a real Chrome (unlike the unit
    # entries) but is proven locally, not deferred: it runs ALONE inside this
    # serial script, so only one Chrome-backed run ever executes per pass.
    ('KB_PW_CHECK_TOGGLE', 'playwright', [
        ('adapter-playwright', 'check on a sibling-label hidden checkbox activates the control itself (r17b)'),
    ]),
]
# Flag proofs that still need the cloud Chrome run (spec: DEFERRED-CLOUD):
# page-scripts' hidden-sibling flag plus the CDP adapter's three. The fourth
# former cloud flag, KB_PW_CHECK_TOGGLE, moved up to UNIT on 2026-10-02 once
# the playwright-adapter sibling-label check test existed (previously vacuous).
CLOUD = [
    ('KB_HIDDEN_SIBLING', 'page-scripts'),
    ('KB_CDP_PRESS_NONE', 'cdp'),
    ('KB_CDP_DIALOG', 'cdp'),
    ('KB_CDP_CHECK_TOGGLE', 'cdp'),
    ('KB_PW_PRESS_NONE', 'playwright'),
    ('KB_PW_DIALOG', 'playwright'),
]


def run(args):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, shell=False)


def failing_titles(output):
    titles = set()
    for m in re.finditer(r'^not ok \d+ - (.+?)(?: #\w+)?\s*$', output, re.MULTILINE):
        titles.add(m.group(1).strip())
    return titles


def read(path):
    return io.open(path, encoding='utf-8', newline='').read()


def write(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


originals = {key: read(path) for key, path in SRC.items()}
digests = {key: hashlib.sha256(text.encode('utf-8')).hexdigest() for key, text in originals.items()}
ok = True
try:
    for flag, file_key, expected in UNIT:
        # `const` at module level; page-scripts' KB_HIDDEN_SIBLING-shaped flags
        # ride `var` inside the stringified function body.
        const_anchor = f'const {flag} = false;'
        var_anchor = f'var {flag} = false;'
        orig = originals[file_key]
        if orig.count(const_anchor) == 1:
            anchor = const_anchor
        elif orig.count(var_anchor) == 1:
            anchor = var_anchor
        else:
            n = orig.count(const_anchor) + orig.count(var_anchor)
            print(f'{flag}: ANCHOR FOUND {n} TIMES - WP-A text differs from the spec')
            ok = False
            continue
        write(SRC[file_key], orig.replace(anchor, anchor.replace('= false;', '= true;')))
        b = run(['node', 'scripts/build.mjs', '--out', OUT] + BUILD_ENTRIES)
        if b.returncode != 0:
            print(f'{flag}: BUILD FAILED\n{(b.stdout + b.stderr)[-600:]}')
            ok = False
            continue
        basenames = sorted({bn for bn, _ in expected})
        t = run(['node', 'scripts/run-tests.mjs', '--dist', OUT] + basenames)
        failed = failing_titles(t.stdout + t.stderr)
        misses = []
        for bn, want in expected:
            if not any(title.startswith(want) for title in failed):
                misses.append(f'{bn}:{want}')
        good = not misses
        ok = ok and good
        extra = sorted(title for title in failed if not any(title.startswith(w) for _, w in expected))
        print(f"{flag}: {'OK ' if good else 'MISS'} expected-fail {[w for _, w in expected]}"
              + (f'; ALSO FAILED {extra}' if extra else '')
              + (f'; MISSED {misses}' if misses else ''))
    for flag, file_key in CLOUD:
        n = originals[file_key].count(f'const {flag} = false;') + originals[file_key].count(f'var {flag} = false;')
        good = n == 1
        ok = ok and good
        print(f'{flag}: {"DEFERRED-CLOUD" if good else f"ANCHOR FOUND {n} TIMES"}')
finally:
    for key, path in SRC.items():
        write(path, originals[key])
    mismatched = [key for key in SRC if hashlib.sha256(read(SRC[key]).encode('utf-8')).hexdigest() != digests[key]]
    if mismatched:
        print(f'RESTORE MISMATCH - STOP AND REPORT: {mismatched}')
        ok = False
    else:
        print('restored src files byte-identically')

r = run(['node', 'scripts/build.mjs', '--out', '.build/r17-b'] + BUILD_ENTRIES)
print('rebuilt .build/r17-b clean' if r.returncode == 0 else 'REBUILD FAILED')
sys.exit(0 if ok and r.returncode == 0 else 1)
