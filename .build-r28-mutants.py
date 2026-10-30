# r28 mutant proof (.build-r28-spec.md WP-C step 2). Run from the repo root:
#   python .build-r28-mutants.py
#
# Same mechanics as .build-r24-mutants.py: flip one flag at a time to true in
# its owning src file, build tests/richtext-fill.test.ts into .build/kb-r28, run
# the mapped test file, and require EVERY mapped test title to appear among the
# FAILING tests AND no other test to fail (an unmapped red fails the runner).
# The map below is the spec § 6.3 teeth table. Under KB_*_RICH_TYPE flips the
# read-back retry SELF-HEALS the outcome pins, so only the __r28Events
# MECHANISM pin kills those; under KB_*_FILL_READBACK flips there is no retry,
# so the outcome pins (#selfheal stays CORRUPTED, #cursed resolves) are the
# killers.
#
# Before AND after every pass the runner enforces
#   grep -rnE "(const|var) KB_(...) = true" src
# returns nothing. Exit 0 only when every mutant's mapped tests failed, nothing
# else failed, every restore matched byte-identically, and the grep is clean.

import hashlib, io, re, subprocess, sys

ROOT = '.'
SRC = {'playwright': 'src/adapters/playwright.ts', 'cdp': 'src/adapters/cdp.ts'}
BUILD_ENTRIES = ['tests/richtext-fill.test.ts']
OUT = '.build/kb-r28'
GREP_RE = r"(const|var) KB_(PW_RICH_TYPE|PW_FILL_READBACK|CDP_RICH_TYPE|CDP_FILL_READBACK) = true"
# Per-subprocess cap (seconds): a wedged single-file run must not outlive the
# leg — richtext-fill normally completes in ~90 s. A leg whose run-tests hits
# the cap prints WEDGED and is recorded environment-blocked, never waved through.
LEG_TIMEOUT = 420

# (flag, src key, [(test basename, expected failing test title prefix), ...])
UNIT = [
    ('KB_PW_RICH_TYPE', 'playwright', [
        ('richtext-fill', 'r28 pw rich fill types by key events'),
    ]),
    ('KB_PW_FILL_READBACK', 'playwright', [
        ('richtext-fill', 'r28 pw read-back retries'),
        ('richtext-fill', 'r28 pw read-back failure'),
    ]),
    ('KB_CDP_RICH_TYPE', 'cdp', [
        ('richtext-fill', 'r28 cdp rich fill types by key events'),
    ]),
    ('KB_CDP_FILL_READBACK', 'cdp', [
        ('richtext-fill', 'r28 cdp read-back retries'),
        ('richtext-fill', 'r28 cdp read-back failure'),
    ]),
]


def run(args, timeout=None):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, shell=False, timeout=timeout)


def sweep_ephemeral_chromes():
    # Best-effort: a hard-killed run-tests cannot run its own token sweep, so
    # kill any chrome tagged wingman-ephemeral- (never a chrome on the shared
    # browser profile — the marker only matches ephemeral profiles).
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
          "Where-Object { $_.CommandLine -like '*wingman-ephemeral-*' } | "
          "ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }")
    subprocess.run(['powershell', '-NoProfile', '-Command', ps], cwd=ROOT,
                   capture_output=True, text=True, shell=False, timeout=120)


def grep_poisoned():
    r = run(['grep', '-rnE', GREP_RE, 'src'])
    return r.stdout.strip()


def failing_titles(output):
    titles = set()
    for m in re.finditer(r'^not ok \d+ - (.+?)(?: #\w+)?\s*$', output, re.MULTILINE):
        titles.add(m.group(1).strip())
    return titles


def read(path):
    return io.open(path, encoding='utf-8', newline='').read()


def write(path, text):
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


ok = True
poison = grep_poisoned()
if poison:
    print(f'PRE-PASS GREP DIRTY - STOP AND RESTORE: {poison}')
    sys.exit(1)

# Optional CLI arg: 1-based leg indices to run (default all), for one-at-a-time
# foreground operation on the 16 GB box.
legs = [int(a) for a in sys.argv[1:]] or list(range(1, len(UNIT) + 1))

originals = {key: read(path) for key, path in SRC.items()}
digests = {key: hashlib.sha256(text.encode('utf-8')).hexdigest() for key, text in originals.items()}
try:
    for legno, (flag, key, expected) in enumerate(UNIT, start=1):
        if legno not in legs:
            continue
        line = f'const {flag} = false;'
        count = originals[key].count(line)
        if count != 1:
            print(f'{flag}: ANCHOR IN {key} FOUND {count} TIMES - spec text differs')
            ok = False
            continue
        write(SRC[key], originals[key].replace(line, line.replace('= false;', '= true;')))
        b = run(['node', 'scripts/build.mjs', '--out', OUT] + BUILD_ENTRIES)
        if b.returncode != 0:
            print(f'{flag}: BUILD FAILED\n{(b.stdout + b.stderr)[-600:]}')
            ok = False
            continue
        basenames = sorted({bn for bn, _ in expected})
        try:
            t = run(['node', 'scripts/run-tests.mjs', '--dist', OUT] + basenames, timeout=LEG_TIMEOUT)
        except subprocess.TimeoutExpired:
            print(f'{flag}: WEDGED (run-tests exceeded {LEG_TIMEOUT}s) - environment-blocked leg')
            sweep_ephemeral_chromes()
            ok = False
            continue
        sweep_ephemeral_chromes()
        failed = failing_titles(t.stdout + t.stderr)
        misses = []
        for bn, want in expected:
            if not any(title.startswith(want) for title in failed):
                misses.append(f'{bn}:{want}')
        good = not misses
        extra = sorted(title for title in failed if not any(title.startswith(w) for _, w in expected))
        good = good and not extra
        ok = ok and good
        print(f"{flag}: {'OK ' if good else 'MISS'} expected-fail {[w for _, w in expected]}"
              + (f'; ALSO FAILED {extra}' if extra else '')
              + (f'; MISSED {misses}' if misses else ''))
        # restore immediately so a later leg's build never sees this flip
        write(SRC[key], originals[key])
finally:
    for key, path in SRC.items():
        write(path, originals[key])
    mismatched = [key for key in SRC if hashlib.sha256(read(SRC[key]).encode('utf-8')).hexdigest() != digests[key]]
    if mismatched:
        print(f'RESTORE MISMATCH - STOP AND REPORT: {mismatched}')
        ok = False
    else:
        print('restored src files byte-identically')

poison = grep_poisoned()
if poison:
    print(f'POST-PASS GREP DIRTY: {poison}')
    ok = False
else:
    print('post-pass grep clean (no KB_* = true in src)')

r = run(['node', 'scripts/build.mjs', '--out', OUT] + BUILD_ENTRIES)
print('rebuilt .build/kb-r28 clean' if r.returncode == 0 else 'REBUILD FAILED')
final_ok = ok and r.returncode == 0
print('PASS: every mapped test failed, nothing else failed, restores matched, grep clean' if final_ok else 'FAIL')
sys.exit(0 if final_ok else 1)
