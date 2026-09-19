// CLI `guide` command (§ WP-F1 item 5): prints the package's
// INSTALL-FOR-AGENTS.md. A missing file is a stderr line and exit 1.

import fs from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../package-root.js';

export async function guideCommand(
  io: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream } = process,
): Promise<number> {
  const root = packageRoot(import.meta.url);
  const file = path.join(root, 'INSTALL-FOR-AGENTS.md');
  if (!fs.existsSync(file)) {
    io.stderr.write(`INSTALL-FOR-AGENTS.md not found in ${root}\n`);
    return 1;
  }
  io.stdout.write(fs.readFileSync(file));
  return 0;
}
