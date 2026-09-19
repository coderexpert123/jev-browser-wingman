import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export function packageRoot(fromUrl: string = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(fromUrl));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (parsed && parsed.name === 'jev-browser-wingman') {
          return dir;
        }
      } catch {
        // not a valid package.json; keep walking up
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('jev-browser-wingman package root not found');
}
