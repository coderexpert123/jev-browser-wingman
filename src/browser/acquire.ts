import type { WingmanConfig } from '../contract/types.js';
import { ENV } from '../contract/constants.js';
import { probeVersion } from './chrome.js';

export interface ResolveEndpointDeps {
  probeVersion?: typeof probeVersion;
}

export async function resolveEndpoint(
  env: NodeJS.ProcessEnv,
  config: Pick<WingmanConfig, 'port'>,
  deps: ResolveEndpointDeps = {},
): Promise<{ endpoint: string; source: 'WINGMAN_CDP_ENDPOINT' | 'PLAYWRIGHT_MCP_CDP_ENDPOINT' | 'probe' } | null> {
  const probe = deps.probeVersion ?? probeVersion;
  const wingmanEndpoint = env[ENV.CDP_ENDPOINT];
  if (wingmanEndpoint) {
    return { endpoint: wingmanEndpoint, source: 'WINGMAN_CDP_ENDPOINT' };
  }
  const playwrightEndpoint = env[ENV.PLAYWRIGHT_CDP];
  if (playwrightEndpoint) {
    return { endpoint: playwrightEndpoint, source: 'PLAYWRIGHT_MCP_CDP_ENDPOINT' };
  }
  const answer = await probe(config.port, 1500);
  if (answer) {
    return { endpoint: `http://127.0.0.1:${config.port}`, source: 'probe' };
  }
  return null;
}
