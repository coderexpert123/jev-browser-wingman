// MCP stdio server (§ WP-F1 item 3). Start and tools/list contact no browser
// (§ 3.14): the endpoint is resolved and attached inside each tools/call.
// Nothing but protocol goes to stdout.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../contract/constants.js';
import { loadConfig } from '../core/config.js';
import { createWingman } from '../lib.js';
import {
  BROWSE_STEP_DESCRIPTION,
  BROWSE_STEP_SCHEMA,
  WINGMAN_CHECK_DESCRIPTION,
  WINGMAN_CHECK_SCHEMA,
  WINGMAN_DO_DESCRIPTION,
  WINGMAN_DO_SCHEMA,
} from './tool-text.js';

const TOOLS = [
  { name: 'wingman_do', description: WINGMAN_DO_DESCRIPTION, inputSchema: WINGMAN_DO_SCHEMA },
  { name: 'wingman_check', description: WINGMAN_CHECK_DESCRIPTION, inputSchema: WINGMAN_CHECK_SCHEMA },
  { name: 'browse_step', description: BROWSE_STEP_DESCRIPTION, inputSchema: BROWSE_STEP_SCHEMA },
];

export async function runMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Config is read at start (for the tool list's mode) and again at every
  // tools/call. A start failure is one stderr line and an empty tool list.
  const startConfig = await loadConfig(env);
  const startMode = startConfig.ok ? startConfig.config.mode : 'off';
  if (!startConfig.ok) {
    process.stderr.write(`jev-browser-wingman: config: ${startConfig.error}\n`);
  }

  const server = new Server({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Clients cache the tool list, so a mode change takes effect next session.
    return { tools: startMode === 'off' ? [] : TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (name !== 'wingman_do' && name !== 'wingman_check' && name !== 'browse_step') {
      return { content: [{ type: 'text', text: `unknown tool: ${String(name)}` }], isError: true };
    }
    try {
      const wingman = await createWingman({ env });
      const result =
        name === 'wingman_do'
          ? await wingman.do(request.params.arguments)
          : name === 'browse_step'
            ? await wingman.step(request.params.arguments)
            : await wingman.check(request.params.arguments);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `jev-browser-wingman: ${(e as Error).message}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
}
