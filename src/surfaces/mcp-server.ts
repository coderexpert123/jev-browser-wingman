// MCP stdio server (§ WP-F1 item 3). Start and tools/list contact no browser
// (§ 3.14): the endpoint is resolved and attached inside each tools/call.
// Nothing but protocol goes to stdout.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HANDOFF_OPTIONAL, PACKAGE_NAME, PACKAGE_VERSION } from '../contract/constants.js';
import { handoffOf, loadConfig } from '../core/config.js';
import { createWingman } from '../lib.js';
import { SERVED_TOOLS } from './tool-text.js';

const TOOLS = SERVED_TOOLS;

// browse-only (the forced default) lists and serves browse_step only; the
// legacy tools are refused at call time (§ 5.10).
const BROWSE_ONLY_TOOLS = [TOOLS[2]];

export async function runMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Config is read at start (for the tool list's mode and handoff) and again
  // at every tools/call. A start failure is one stderr line and an empty tool
  // list.
  const startConfig = await loadConfig(env);
  const startMode = startConfig.ok ? startConfig.config.mode : 'off';
  const handoff = startConfig.ok ? handoffOf(startConfig.config) : HANDOFF_OPTIONAL;
  if (!startConfig.ok) {
    process.stderr.write(`jev-browser-wingman: config: ${startConfig.error}\n`);
  }
  const listedTools = handoff.tools === 'browse-only' ? BROWSE_ONLY_TOOLS : TOOLS;

  const server = new Server({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Clients cache the tool list, so a mode change takes effect next session.
    return { tools: startMode === 'off' ? [] : listedTools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (handoff.tools === 'browse-only' && (name === 'wingman_do' || name === 'wingman_check')) {
      return { content: [{ type: 'text', text: `unknown tool: ${String(name)}` }], isError: true };
    }
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
