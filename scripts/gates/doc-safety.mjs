#!/usr/bin/env node
// WP-G: doc-safety gate. Reader-facing package docs must contain no
// paste-this-prompt text, no remote content piped to a shell, no eval of
// remote content, no Invoke-Expression, and no instruction-override text.
// Each hit prints `DOC-SAFETY: <file>:<line> <rule-id>`; any hit exits 1.
// A clean run prints `DOC-SAFETY: ok files=<n>`. Proven against a planted
// `curl | sh` line (§ 8).

import fs from 'node:fs';

const RULES = [
  [
    'pipe-to-shell',
    [/(curl|wget|iwr|Invoke-WebRequest)[^\n|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|powershell)\b/],
  ],
  [
    'eval-remote',
    [/eval\s+"?\$\((curl|wget)/, /(sh|bash)\s+<\(\s*(curl|wget)/],
  ],
  ['invoke-expression', [/\bInvoke-Expression\b|\biex\b/]],
  ['paste-prompt', [/paste (this|the following) (prompt|into)/]],
  ['override-instructions', [/ignore (all |any )?(previous|prior) instructions/]],
];

const files = process.argv.slice(2);
let hits = 0;
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const [rule, patterns] of RULES) {
      if (patterns.some((re) => re.test(lines[i]))) {
        console.log(`DOC-SAFETY: ${file}:${i + 1} ${rule}`);
        hits += 1;
      }
    }
  }
}
if (hits > 0) {
  process.exit(1);
}
console.log(`DOC-SAFETY: ok files=${files.length}`);
