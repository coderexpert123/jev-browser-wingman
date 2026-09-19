import fs from 'node:fs';
import path from 'node:path';
import type { WingmanLogRecord, WingmanPlugin } from '../contract/types.js';

export async function writeLog(
  record: WingmanLogRecord,
  opts: { home: string; plugin?: WingmanPlugin | null },
): Promise<void> {
  try {
    if (opts.plugin?.log) {
      opts.plugin.log(record);
      return;
    }
    fs.mkdirSync(opts.home, { recursive: true });
    const logPath = path.join(opts.home, 'log.jsonl');
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch (e) {
    process.stderr.write(`jev-browser-wingman: log write failed: ${(e as Error).message}\n`);
  }
}
