import os from 'node:os';
import { join } from 'node:path';

export function wingmanHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return env.WINGMAN_HOME ? env.WINGMAN_HOME : join(home, '.jev-browser-wingman');
}

export function expandHome(p: string, home = os.homedir()): string {
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return home + p.slice(1);
  }
  return p;
}
