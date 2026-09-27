import type { WingmanConfig } from '../contract/types.js';
import { ENV } from '../contract/constants.js';
import { wingmanHome } from '../contract/home.js';
import { loadProfiles } from '../core/profiles.js';
import { probeVersion } from './chrome.js';

export interface ResolveEndpointDeps {
  probeVersion?: typeof probeVersion;
  loadProfiles?: typeof loadProfiles;
  home?: string;
}

// Endpoint sources, in order: WINGMAN_CDP_ENDPOINT, then each loaded
// capability profile's launch.endpoint_env (load order), then the probe.
// `source` is the env name, or 'probe' for the probe.
export async function resolveEndpoint(
  env: NodeJS.ProcessEnv,
  config: Pick<WingmanConfig, 'port'>,
  deps: ResolveEndpointDeps = {},
): Promise<{ endpoint: string; source: string } | null> {
  const probe = deps.probeVersion ?? probeVersion;
  const wingmanEndpoint = env[ENV.CDP_ENDPOINT];
  if (wingmanEndpoint) {
    return { endpoint: wingmanEndpoint, source: 'WINGMAN_CDP_ENDPOINT' };
  }
  const loadProfilesFn = deps.loadProfiles ?? loadProfiles;
  const profiles = loadProfilesFn(deps.home ?? wingmanHome(env));
  for (const profile of profiles) {
    const name = profile.launch.endpoint_env;
    if (name && env[name]) {
      return { endpoint: env[name], source: name };
    }
  }
  const answer = await probe(config.port, 1500);
  if (answer) {
    return { endpoint: `http://127.0.0.1:${config.port}`, source: 'probe' };
  }
  return null;
}
