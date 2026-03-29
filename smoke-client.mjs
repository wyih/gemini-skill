import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

const cwd = process.cwd();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(cwd, 'src/mcp-server.js')],
  cwd,
  stderr: 'pipe',
});
transport.stderr?.on?.('data', (chunk) => process.stderr.write(chunk));

const client = new Client({ name: 'openclaw-smoke', version: '0.1.0' });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(JSON.stringify({
    ok: true,
    tool_count: tools.tools.length,
    first_tools: tools.tools.slice(0, 8).map(t => t.name),
  }, null, 2));
} catch (err) {
  console.error('CLIENT_ERR', err?.stack || err?.message || String(err));
  process.exitCode = 1;
} finally {
  try { await client.close(); } catch {}
}
