// WP-C C3: a stdio MCP server stub driven entirely by env (spec § 6 WP-C).
//   STUB_TOOLS      JSON array of {name, description} listed by tools/list
//                   (default: one tool named stub_tool)
//   STUB_LOG        every received method and tool name, plus the child argv,
//                   is appended here
//   STUB_NOTIFY_RAW when set, the stub emits this exact string as one stdout
//                   line at startup (non-canonical spacing rides in the value)
// It answers tools/call with {content:[{type:'text',text:'ok:<name>'}]}.

import fs from 'node:fs';

const append = (s) => {
  try {
    fs.appendFileSync(process.env.STUB_LOG, s + '\n');
  } catch {
    // a missing log must not kill the stub
  }
};

append('argv:' + JSON.stringify(process.argv.slice(2)));

if (process.env.STUB_NOTIFY_RAW) {
  process.stdout.write(process.env.STUB_NOTIFY_RAW + '\n');
}

let tools = [{ name: 'stub_tool', description: 'stub' }];
try {
  const parsed = JSON.parse(process.env.STUB_TOOLS ?? '');
  if (Array.isArray(parsed)) tools = parsed;
} catch {
  // STUB_TOOLS unset or invalid: keep the default single tool
}
append('tools:' + JSON.stringify(tools.map((t) => t.name)));

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    append('unparsed');
    return;
  }
  const toolName = msg.params && msg.params.name ? ':' + msg.params.name : '';
  append('method:' + (msg.method ?? 'response') + toolName);
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'stub-browsing', version: '0.0.0' },
    });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, { tools });
  } else if (msg.method === 'tools/call') {
    reply(msg.id, { content: [{ type: 'text', text: 'ok:' + ((msg.params && msg.params.name) ?? '') }] });
  } else if (msg.id !== undefined) {
    reply(msg.id, {});
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
