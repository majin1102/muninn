#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ServerClient, type ReadInput, type RecallInput } from './server-client.js';

type ToolSpec<TInput extends object> = {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  run(args: TInput, client: ServerClient): Promise<string>;
};

const RecallInputSchema = z.object({
  query: z.string().min(1).describe('Natural-language query for past or other-session Muninn context'),
  budget: z.number().int().nonnegative().optional().describe('Optional character budget for composed recall context; max 20000'),
  top_k: z.number().int().positive().optional().describe('Optional result count; max 50'),
  mode: z.enum(['session', 'extraction']).optional().describe('Recall mode. Use session for import candidate sessions; defaults to extraction.'),
});

const ReadInputSchema = z.object({
  context_ids: z.array(z.string().min(1)).min(1).describe('Selected session:<row_id>, turn:<id>, or ext:<uuid> context_id handles returned by Muninn'),
});

const tools: ToolSpec<any>[] = [
  {
    name: 'muninn-recall',
    description: 'Recall Muninn context by query. Defaults to extraction recall; use mode=session to get prior session import candidates. Accepts optional top_k and extraction budget.',
    inputSchema: RecallInputSchema,
    run: (args: RecallInput, client) => client.recall(args),
  },
  {
    name: 'muninn-read',
    description: 'Read selected Muninn context content by context_id. Accepts session:<row_id>, turn:<id>, and ext:<uuid> context_ids. Use selectively when exact content is needed.',
    inputSchema: ReadInputSchema,
    run: (args: ReadInput, client) => client.read(args),
  },
];

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

async function main(): Promise<void> {
  const client = new ServerClient();
  const server = new McpServer(
    {
      name: 'muninn-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Keep the cast local until SDK/Zod generic depth is no longer an issue.
  const registerTool: any = (server as any).registerTool.bind(server);
  for (const tool of tools) {
    registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args: unknown) => textResult(await tool.run(args as never, client)),
    );
  }

  await server.connect(new StdioServerTransport());
  console.error('Muninn MCP server running on stdio');
}

main().catch((error) => {
  console.error('Muninn MCP server error:', error);
  process.exit(1);
});
