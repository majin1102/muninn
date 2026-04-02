#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SidecarClient } from './sidecar_client.js';

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderMemoryResponse(
  memoryResponse: { memoryHits: Array<{ memoryId: string; content: string }> },
): string {
  return memoryResponse.memoryHits.map((memoryHit) => {
    if (memoryHit.content.includes(memoryHit.memoryId)) {
      return memoryHit.content;
    }

    return [
      `Memory ID: ${memoryHit.memoryId}`,
      '',
      memoryHit.content,
    ].join('\n');
  }).join('\n\n---\n\n');
}

async function writeDebugMarkdown(toolName: string, args: unknown): Promise<string> {
  const muninnHome = process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
  const debugDir = path.join(muninnHome, 'debug');
  await mkdir(debugDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  const filePath = path.join(debugDir, `${timestamp}-${toolName}-${suffix}.md`);

  const markdown = [
    `# ${toolName}`,
    '',
    `- Time: ${new Date().toISOString()}`,
    `- Tool: ${toolName}`,
    '',
    '## Arguments',
    '',
    '```json',
    safeStringify(args),
    '```',
    '',
  ].join('\n');

  await writeFile(filePath, markdown, 'utf8');
  return filePath;
}

async function main() {
  const sidecarClient = new SidecarClient();
  const server = new McpServer(
    {
      name: 'muninn-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Work around TypeScript "type instantiation is excessively deep" triggered by
  // McpServer.registerTool's generics + Zod types.
  const registerTool: any = (server as any).registerTool.bind(server);

  registerTool(
    'print',
    {
      description: 'Debug tool: print arguments and write a Markdown snapshot',
      inputSchema: z.object({
        message: z.string().optional().describe('A short message'),
        data: z.any().optional().describe('Arbitrary JSON payload'),
      }),
    },
    async (args: any) => {
      const debugFilePath = await writeDebugMarkdown('print', args);
      console.error('[tool:print] args:', safeStringify(args));
      console.error('[tool:print] debug file:', debugFilePath);
      return {
        content: [{ type: 'text', text: `printed: ${debugFilePath}` }],
      };
    }
  );

  registerTool(
    'recall',
    {
      description: 'Recall memories based on a query',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
        limit: z.number().int().positive().optional().describe('Maximum number of results'),
        thinkingRatio: z.number().min(0).max(1).optional().describe('Ratio of thinking memories'),
      }),
    },
    async (args: any) => {
      const result = await sidecarClient.recall(args);
      return {
        content: [{ type: 'text', text: renderMemoryResponse(result) }],
      };
    }
  );

  registerTool(
    'list',
    {
      description: 'List recent memories',
      inputSchema: z.object({
        mode: z.literal('recency').default('recency').describe('List mode'),
        limit: z.number().int().positive().optional().describe('Maximum number of results'),
        thinkingRatio: z.number().min(0).max(1).optional().describe('Ratio of thinking memories'),
      }),
    },
    async (args: any) => {
      const result = await sidecarClient.list(args);
      return {
        content: [{ type: 'text', text: renderMemoryResponse(result) }],
      };
    }
  );

  registerTool(
    'get_timeline',
    {
      description: 'Get the surrounding timeline for a memory',
      inputSchema: z.object({
        memoryId: z.string().describe('Memory ID'),
        beforeLimit: z.number().int().nonnegative().optional().describe('Number of items before the anchor'),
        afterLimit: z.number().int().nonnegative().optional().describe('Number of items after the anchor'),
      }),
    },
    async (args: any) => {
      const result = await sidecarClient.getTimeline(args);
      return {
        content: [{ type: 'text', text: renderMemoryResponse(result) }],
      };
    }
  );

  registerTool(
    'get_detail',
    {
      description: 'Get the full detail for a memory',
      inputSchema: z.object({
        memoryId: z.string().describe('Memory ID'),
      }),
    },
    async (args: any) => {
      const result = await sidecarClient.getDetail(args);
      return {
        content: [{ type: 'text', text: renderMemoryResponse(result) }],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Muninn MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
