// Prebuild step: keep PACKAGE_VERSION in src/contract/constants.ts in sync
// with package.json. `npm version` only touches package.json; without this the
// CLI's --version (and any other PACKAGE_VERSION consumer) reports a stale
// version from a hand-maintained constant. Idempotent; exits 0 when in sync.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const constantsPath = join(root, 'src', 'contract', 'constants.ts');
const src = readFileSync(constantsPath, 'utf8');
const next = src.replace(
  /(export const PACKAGE_VERSION = ')[^']+(')/,
  `$1${pkg.version}$2`,
);
if (next === src) {
  if (!/export const PACKAGE_VERSION = '[^']+'/.test(src)) {
    throw new Error('PACKAGE_VERSION not found in constants.ts');
  }
  process.exit(0);
}
writeFileSync(constantsPath, next);
console.log(`sync-version: PACKAGE_VERSION -> ${pkg.version}`);
