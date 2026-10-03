# r19 mutant proof (.build-r19-spec.md, D-11). Run from the repo root AFTER
# WP-1 has landed:  python .build-r19-mutants.py
#
# Same mechanics as .build-r17-mutants.py: flip one flag at a time to true in
# its owning src file(s), build the mapped test entries into .build/r19-mut,
# run the mapped test file(s), and expect EVERY mapped pinned test title to
# appear among the FAILING tests. src files are restored byte-identically
# (sha256) in a finally block; a clean rebuild follows the pass (a KB-proof
# run poisons a scoped .build until it is rebuilt).
#
# KB_TABLE_HEADERS flips BOTH anchors in one mutant: the `var` inside
# page-scripts' enumerate body AND the module-level `const` in questions.ts
# (D-11: "One mutant flips BOTH anchors").
#
# Later WPs extend MUTANTS per D-11: WP-2 adds KB_UPLOAD_EVIDENCE (loop.ts),
# WP-5 adds the bench/run.ts slice-line source-shape tripwire (D-11 left the
# file unowned in WP-4's list; the dispatch assigned the append here). A
# source-shape mutant is not a flag flip: its anchor is the literal good
# source line and its optional 4th tuple element is the bad line to substitute
# (the runner flips flags when no 4th element is present).
#
# Before AND after every pass (the runner enforces both):
#   grep -rn "KB_\(TABLE_HEADERS\|DBLCLICK_ENUM\|UPLOAD_EVIDENCE\) = true" src
# must return nothing (the r17c killed-runner gotcha — a pre-poisoned flag
# makes the anchor check and the flip vacuous). Exit 0 only when every
# mutant's mapped tests failed, every restore matched, and the grep is clean.

import hashlib, io, re, subprocess, sys

ROOT = '.'
SRC = {
    'page-scripts': 'src/core/page-scripts.ts',
    'questions': 'src/core/questions.ts',
    'loop': 'src/core/loop.ts',
    'run': 'bench/run.ts',
}
BUILD_ENTRIES = ['tests/page-scripts.test.ts', 'tests/questions.test.ts', 'tests/chain.test.ts', 'tests/bench-browse.test.ts']
OUT = '.build/r19-mut'
GREP_RE = r"KB_(TABLE_HEADERS|DBLCLICK_ENUM|UPLOAD_EVIDENCE) = true"

# (mutant name, [(src key, anchor flag line)], [(test basename, expected failing test title prefix), ...])
MUTANTS = [
    ('KB_TABLE_HEADERS', [('page-scripts', 'var'), ('questions', 'const')], [
        ('page-scripts', 'table-headers.html enumerates th as columnheader'),
        ('page-scripts', 'tableId names the enclosing table'),
        ('page-scripts', 'verify round-trips the new roles'),
        ('questions', 'table context rides the criterion'),
    ]),
    ('KB_DBLCLICK_ENUM', [('page-scripts', 'var')], [
        ('page-scripts', 'double-click.html enumerates the ondblclick div'),
        ('page-scripts', 'verify round-trips the new roles'),
    ]),
    ('KB_UPLOAD_EVIDENCE', [('loop', 'const')], [
        ('chain', 'T-upload evidence advances on the act-returned uploaded'),
    ]),
    # Source-shape tripwire (D-11): reverting the fresh-log read to a decoded-
    # string slice must flip bench-browse's source-shape pin red. Not a flag:
    # the anchor is the good line, the 4th element is the bad line.
    ('RUN_SLICE_SOURCE_TRIPWIRE', [('run', "      const fresh = freshLogSlice(fs.readFileSync(logPath), before);")], [
        ('bench-browse', 'run.ts reads the fresh log tail as a Buffer subarray'),
    ], "      const fresh = fs.readFileSync(logPath, 'utf8').slice(before);"),
]


def run(args):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, shell=False)


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

originals = {key: read(path) for key, path in SRC.items()}
digests = {key: hashlib.sha256(text.encode('utf-8')).hexdigest() for key, text in originals.items()}
try:
    for flag, anchors, expected, *rest in MUTANTS:
        replace_to = rest[0] if rest else None
        for key, anchor in anchors:
            line = anchor if replace_to is not None else f'{anchor} {flag} = false;'
            if originals[key].count(line) != 1:
                print(f'{flag}: ANCHOR IN {key} FOUND {originals[key].count(line)} TIMES - spec text differs')
                ok = False
        if not ok:
            continue
        for key, anchor in anchors:
            line = anchor if replace_to is not None else f'{anchor} {flag} = false;'
            new_line = replace_to if replace_to is not None else line.replace('= false;', '= true;')
            write(SRC[key], originals[key].replace(line, new_line))
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
print('rebuilt .build/r19-mut clean' if r.returncode == 0 else 'REBUILD FAILED')
sys.exit(0 if ok and r.returncode == 0 else 1)
