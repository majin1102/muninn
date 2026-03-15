#!/usr/bin/env node

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  // Compiled output lives in dist/, so ".." is the package root.
  const packageRoot = path.resolve(__dirname, '..');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    cwd: packageRoot,
  });

  const client = new Client(
    { name: 'munnai-mcp-demo-client', version: '0.1.0' },
    { capabilities: {} }
  );

  await client.connect(transport);

  const tools = await client.listTools();
  console.log('tools:', tools.tools.map((t) => t.name).sort());

  const result = await client.callTool({
    name: 'print',
    arguments: {
      message: 'hello from demo-client',
      data: {
        now: new Date().toISOString(),
        pid: process.pid,
      },
    },
  });
  const resultAny = result as any;
  const firstBlock = Array.isArray(resultAny?.content) ? resultAny.content[0] : null;
  console.log('print result:', firstBlock?.type === 'text' ? firstBlock.text : resultAny);

  await client.close();
}

main().catch((error) => {
  console.error('demo-client error:', error);
  process.exit(1);
});
