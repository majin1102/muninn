#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ServerClient, type ExplainInput, type ListInput, type ReadInput, type RecallInput } from './server-client.js';

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
});

const ListInputSchema = z.object({
  query: z.string().min(1).describe('Natural-language query for candidate prior session contexts'),
  top_k: z.number().int().positive().optional().describe('Optional candidate count; max 50'),
});

const ReadInputSchema = z.object({
  context_ids: z.array(z.string().min(1)).min(1).describe('Selected session_*, turn_*, or ext:* context_id handles returned by Muninn'),
});

const ExplainInputSchema = z.object({
  context_id: z.string().min(1).describe('Selected session_* context_id returned by Muninn'),
});

const tools: ToolSpec<any>[] = [
  {
    name: 'muninn-recall',
    description: 'Recall context from past or other Muninn sessions by query and return source context references. Accepts optional top_k and budget.',
    inputSchema: RecallInputSchema,
    run: (args: RecallInput, client) => client.recall(args),
  },
  {
    name: 'muninn-list',
    description: 'List candidate Muninn session contexts by query, excluding the current session when host current-session identity is available. Returns session_* context_ids with titles and summaries for selection before read.',
    inputSchema: ListInputSchema,
    run: (args: ListInput, client) => client.list(args),
  },
  {
    name: 'muninn-read',
    description: 'Read selected Muninn context content by context_id. Accepts session_*, turn_*, and ext:* context_ids. Use selectively when exact content is needed.',
    inputSchema: ReadInputSchema,
    run: (args: ReadInput, client) => client.read(args),
  },
  {
    name: 'muninn-explain',
    description: 'Inspect source provenance and references for a session_* context_id. Use selectively when evidence or origin detail is needed.',
    inputSchema: ExplainInputSchema,
    run: (args: ExplainInput, client) => client.explain(args),
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
