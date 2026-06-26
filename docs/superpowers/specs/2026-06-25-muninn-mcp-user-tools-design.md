# Muninn Skill And MCP Context Surface Design

## Summary

Muninn should expose a skill-first context surface for user workflows, backed by a minimal MCP surface for query recall and structured drill-down.

The user-facing skill workflows are:

```text
muninn-capture -> HTTP capture
muninn-import  -> MCP muninn_list + muninn_read import flow
```

The MCP server should expose four structured context tools:

```text
muninn_recall({ query, budget?, top_k? })
muninn_list({ query, top_k? })
muninn_read({ context_ids })
muninn_explain({ context_id })
```

The capture skill should call the Muninn server through a shared helper or CLI-backed HTTP client, not by asking the model to hand-write `curl` requests. The import skill should orchestrate MCP `muninn_list` and `muninn_read` calls. The server owns context lookup, session identity, capture policy, deletion, and all storage-side behavior.

Codex user entry should come from Muninn skills, not from assuming MCP tools appear as slash commands. The skill names are prefixed to avoid collisions:

```text
muninn-capture
muninn-import
```

`recent` remains a server-side startup context API, not a user-facing skill. Do not ship `muninn-recent` or `muninn-brief`.

## Goals

- Replace the current demo-oriented MCP surface with four context tools and two user-facing workflow skills.
- Keep MCP focused on context recall, candidate listing, and structured `context_id` drill-down.
- Support explicit user invocation through skills and agent-initiated recall and drill-down through MCP.
- Make current-session capture and query-driven import first-class skill workflows.
- Make query recall a first-class MCP capability for remembering context that happened in past or other sessions.
- Make query-scoped candidate context listing a first-class MCP capability for selecting prior sessions.
- Keep recent startup context as a server/host integration capability rather than a slash-list skill.
- Make context content reading and source provenance explanation first-class MCP drill-down capabilities.
- Keep project auto-capture allowlists separate from explicit current-session capture actions.
- Keep import as a single-query selection workflow that lists candidate sessions, asks the user to choose, and reads selected context.
- Keep capture HTTP calls behind a shared helper so skills do not instruct the model to manually compose raw HTTP requests.

## Non-Goals

- Do not expose `print`, `get_timeline`, `get_detail`, or the previous unscoped `list` behavior as default user tools.
- Do not implement a generic context browser through MCP in this design.
- Do not make MCP tools depend on Codex slash-command availability.
- Do not expose `recent`, `capture`, or `import` as MCP tools in this design.
- Do not add compatibility handling for obsolete MCP tool names.
- Do not use `capture` to edit project auto-capture allowlists.
- Do not make `recent` or `brief` user-facing skills.

## Replacement Requirement

This design replaces the previous Muninn MCP and skill surface. Implementation must delete the old surface instead of preserving aliases or compatibility behavior.

Remove the previous default MCP tools:

```text
print
list
get_timeline
get_detail
```

Replace the previous MCP module with the four-tool context module in this spec:

```text
muninn_recall
muninn_list
muninn_read
muninn_explain
```

The new `muninn_list` tool is query-scoped candidate listing. It is not a compatibility alias for the previous unscoped `list` tool.

Remove or rewrite any Muninn skill/custom-prompt entries that target the old MCP surface. The shipped Muninn user entry should be exactly these two current skills:

```text
muninn-capture
muninn-import
```

Do not ship a generic `$muninn <command>` parser skill. Do not ship `muninn-recent` or `muninn-brief`.

## Product Model

There are three separate layers:

```text
Muninn skills = user and workflow behavior layer
MCP tools = query recall, candidate listing, and structured context drill-down capability layer
Muninn server HTTP APIs = backend workflow and context operations
```

Skills provide explicit user entries in the skill UI and encode workflow behavior such as parsing flags, choosing candidates, asking for confirmation, and deciding when drill-down is useful. The capture skill calls a shared Muninn helper that sends typed HTTP requests to the server. The import skill orchestrates MCP `muninn_list` and `muninn_read` calls.

MCP tools provide query recall, query-scoped candidate listing, and structured drill-down for `context_id` handles. They are not user-facing skills; they are available for agent-initiated recall and follow-up when past context, exact content, or provenance is needed, and workflow skills may instruct the agent to use them selectively after returning handles.

The user-facing skill display names should be:

```text
Muninn Capture
Muninn Import
```

The raw skill names should be:

```text
muninn-capture
muninn-import
```

The MCP tool names should be:

```text
muninn_recall
muninn_list
muninn_read
muninn_explain
```

There should be no `recent`, `capture`, or `import` MCP tools. Those names belong to host startup or skill workflows and server HTTP routes.

## Context ID Model

Muninn outputs should use `context_id` for stable drill-down handles. In the current MVP surface, public context ids use two families:

```text
session_*
turn_*
```

`session_*` identifies session-level context. `turn_*` identifies source conversation turn content. These prefixes route tool usage: `muninn_read` accepts `session_*` and `turn_*`; `muninn_explain` accepts `session_*` only.

Agents may recognize the `session_*` and `turn_*` prefixes for tool routing, but they must treat the rest of every `context_id` as an opaque handle. They should not parse, truncate, transform, or synthesize context ids. They should pass only `context_id` values returned by Muninn back to `muninn_read` or `muninn_explain`.

Server HTTP APIs and MCP context tools may return `context_id` values. A returned id is not a request to read or explain immediately. It is a drill-down handle for later use when the current conversation needs additional content, evidence, or origin detail.

## Server HTTP APIs

Server HTTP APIs back host startup context and current-session capture. They are not MCP tools.

### `recent`

Purpose: load startup context for the current project. This is a server/host integration API, not a user-facing skill.

Route:

```text
POST /api/v1/startup/recent
```

Schema:

```ts
type RecentInput = {
  cwd: string;
  budget?: number;
};
```

Behavior:

- Resolve `cwd` to the canonical project identity.
- Load recent session information for that project.
- Load important signals for that project.
- Return a concise briefing that can be read directly by the agent at session start.
- Honor `budget` as a character budget when provided; otherwise use the server default.

`recent` is intentionally queryless. It answers "what should I know when starting here?" Query-shaped retrieval belongs to `muninn_recall` and `muninn_list`.

`recent` should be invoked by session-start host integration or another automatic startup path. It should not be exposed as `muninn-recent`, `muninn-brief`, or `muninn skill-call recent`.

Output should be Markdown text, for example:

```md
# Muninn Recent

## Recent Sessions
- ...

## Signals
- ...

## Suggested Recall Queries
- ...
```

### `capture`

Purpose: include or remove the current session from Muninn.

Schema:

```ts
type CaptureInput = {
  enabled: boolean;
};
```

Behavior:

- `enabled: true` captures the current session into Muninn and allows future turns from this session to continue entering Muninn.
- `enabled: false` removes the current session from Muninn and prevents future turns from this session from entering Muninn.
- `enabled: false` is destructive and must be described as deletion, not pause.
- The operation is scoped to the current agent session, not to the project.
- The API must not edit project auto-capture allowlists.

Policy model:

```text
if current session is explicitly disabled:
  skip future hook capture for this session

else if current session is explicitly enabled:
  allow hook capture for this session, even when the project is not in the auto-capture allowlist

else:
  use the project auto-capture allowlist for hook capture
```

Project allowlists remain the default automatic capture policy. Explicit session capture is a user action for the current session.

Return examples:

```text
Capture enabled for this session.
```

```text
Current session removed from Muninn. Future turns from this session will not be captured.
```

## MCP Context Tools

These are the only tools registered by the MCP server.

### `muninn_recall`

Purpose: recall context that happened in past or other Muninn sessions by query, and return source context references to the original context.

Schema:

```ts
type RecallInput = {
  query: string;
  budget?: number;
  top_k?: number;
};
```

Behavior:

- Search previously captured Muninn context using `query`.
- Use `budget` as an optional character budget for composed context.
- Use a server default budget when `budget` is absent.
- Use `top_k` as an optional maximum number of matched context items or source references to include before composing the answer.
- Use a server default result count when `top_k` is absent.
- If a host, skill, or user-facing command supports `--top <integer>`, map it to MCP `top_k`.
- Return a concise recollection of what happened in past or other sessions.
- Return source context references when useful. These references are `session_*` or `turn_*` `context_id` values that point back to the original context.
- Keep query recall concise enough to choose relevant context; use `muninn_read` for original context content and `muninn_explain` for session provenance and references when needed.
- Do not treat `query` values that look like `session_*` or `turn_*` as drill-down. Context-id drill-down belongs to `muninn_read` and `muninn_explain`.
- Do not accept `limit`, `queryLimit`, `recallMode`, or `thinkingRatio`; `top_k` is the only user-facing result-count control.

Query recall output should make original source references obvious:

```md
## Source Context References

| context_id | reason | preview |
|---|---|---|
| session_01HX... | Discussed MCP schema naming | recall/capture/import were narrowed... |
| turn_01HY... | User clarified capture semantics | capture -1 means deletion, not pause... |
```

Recall results summarize remembered context from past or other sessions. The returned `context_id` values are references to original session or turn context. The agent should inspect those references only when the current conversation needs exact wording, provenance, surrounding turn detail, or stronger evidence before acting. It should not automatically read or explain every returned `context_id`.

### `muninn_list`

Purpose: list candidate Muninn session contexts by query before importing or selecting prior session context.

Schema:

```ts
type ListInput = {
  query: string;
  top_k?: number;
};
```

Behavior:

- Search session-level Muninn context using `query`.
- Use `top_k` as an optional maximum number of candidate sessions to return.
- Use a server default candidate count when `top_k` is absent.
- If a host, skill, or user-facing command supports `--top <integer>`, map it to MCP `top_k`.
- Return ranked candidate sessions only; do not return generic database listings.
- Each candidate must include a `session_*` `context_id`, title, and summary.
- Do not return `turn_*` context ids from `muninn_list`; turn-level detail belongs to `muninn_read` after a session is selected.
- Do not read, import, or auto-select candidate content.
- Use `muninn_read` after the user or agent selects candidate `session_*` context ids.
- Use `muninn_explain` only if source provenance or references behind a selected session are needed.
- Do not accept `budget`, `limit`, `queryLimit`, `recallMode`, or `thinkingRatio`; `top_k` is the only user-facing result-count control.

Candidate output should be easy to number for user choice:

```md
# Muninn List

1. MCP schema redesign
   context_id: session_01HX...
   summary: Recall, capture, import, read, and explain were narrowed...

2. Capture policy discussion
   context_id: session_01HY...
   summary: Project allowlists remain automatic capture policy...
```

`muninn_list` is the selection surface. It returns handles, not imported content. The agent should call `muninn_read` only for selected candidates, not for every listed `context_id`.

### `muninn_read`

Purpose: read selected Muninn context content by `context_id` when exact content is needed.

Schema:

```ts
type ReadInput = {
  context_ids: string[];
};
```

Behavior:

- Accept one or more `session_*` or `turn_*` `context_id` values returned by Muninn.
- Reject unsupported context id families.
- Use `muninn_read` selectively. A returned `context_id` is a drill-down handle, not a read request.
- Read only the supplied context ids.
- For `session_*`, return the session-level context content.
- For `turn_*`, return the source conversation turn content.
- Do not return provenance, references, or explanation details.
- If the agent needs source provenance or references for a `session_*` context item, it should call `muninn_explain` with that `context_id`.
- Do not call `muninn_explain` for `turn_*`; a turn is already source content.
- Do not accept `budget`, `query`, `refs`, `depth`, or automatic explanation parameters.
- Return per-id errors for unknown, deleted, or unsupported context ids without hiding successful reads for other ids.

Output should stay content-only:

```md
# Muninn Read

## session_01HX...

...

## turn_01HY...

...
```

The agent should not infer source provenance from read content. Source provenance inspection belongs to `muninn_explain`.

### `muninn_explain`

Purpose: inspect source provenance and references for a selected Muninn `session_*` `context_id` when evidence or origin detail is needed.

Schema:

```ts
type ExplainInput = {
  context_id: string;
};
```

Behavior:

- Accept exactly one `session_*` `context_id` returned by Muninn.
- Reject `turn_*` and unsupported context id families.
- Use `muninn_explain` selectively. A returned `context_id` is a drill-down handle, not an explanation request.
- Return source provenance and references for that session-level context item.
- Resolve supporting source references to `turn_*` context ids and source snippets or summaries where useful.
- Do not return the full session context itself except when needed to orient the provenance view; use `muninn_read` for the content itself.
- Do not return synthetic `relation` or `label` fields. The current backend has source reference arrays, not structured relation labels.
- Do not accept `budget`, `refs`, `depth`, or recursive explanation parameters.
- Do not explain every recalled or read context item automatically. Use `muninn_explain` only when the current conversation needs source provenance, references, or exact surrounding evidence.

Output should be a source provenance view:

```md
# Muninn Explain

Explained: session_01HX...

## Source Provenance

### turn_01HY...

...

### turn_01HZ...

...
```

## Shared Skill HTTP Helper

The capture skill must call a shared helper instead of hand-writing HTTP requests. The helper is an implementation detail shipped with the Muninn CLI/runtime, but it is the stable command surface that capture skill instructions should use.

Target helper command forms:

```text
muninn skill-call capture --enabled true|false
```

The helper owns:

- Resolving `MUNINN_SERVER_BASE_URL` and authentication headers.
- Posting typed JSON to the Muninn server capture workflow HTTP route.
- Returning text-first output for the skill to show or reason over.
- Returning actionable error text when the server is unavailable or the current session cannot be identified.

The server workflow HTTP route is:

```text
POST /api/v1/skill/capture
```

This route is not an MCP route. It exists so the capture skill has a stable local execution path while MCP remains limited to `muninn_recall`, `muninn_list`, `muninn_read`, and `muninn_explain`.

## Skill Entries

Muninn should ship two user-facing skills with clear trigger descriptions. `muninn-capture` calls the shared Muninn HTTP helper. `muninn-import` orchestrates MCP `muninn_list` and `muninn_read`. Skills may instruct the agent to use MCP `muninn_recall`, `muninn_list`, `muninn_read`, and `muninn_explain` for context recovery and selective drill-down, but those MCP tools are not separate skills.

### `muninn-capture`

Display name: `Muninn Capture`

Trigger description:

```yaml
description: Use when the user explicitly asks Muninn to capture, remember, remove, forget, include, or exclude the current session.
```

Core instruction:

```text
Run `muninn skill-call capture --enabled true|false` only for explicit user requests. Do not call an MCP `capture` tool; it should not exist. Map `+1`, "on", "enable", "capture", "remember this session", or "include this session" to `true`. Map `-1`, "off", "disable", "remove this session", "delete this session", "forget this session", or "exclude this session" to `false`. Treat `false` as destructive deletion of the current session from Muninn.
```

Supported user forms:

```text
$muninn-capture +1
$muninn-capture -1
```

### `muninn-import`

Display name: `Muninn Import`

Trigger description:

```yaml
description: Use when the user asks Muninn to import prior sessions or context using a natural-language query.
```

Core instruction:

```text
Call MCP `muninn_list({ query, top_k? })` with the user's remaining text as `query`. Parse optional `--top <integer>` from the user request and pass it as `top_k` when present. Do not call an MCP `import` tool; it should not exist. Do not call `muninn skill-call import`; it should not exist. Show the numbered candidate list with session titles and summaries, then ask the user to choose by number. Keep the candidate `session_*` `context_id` values available for tool use. When the user chooses one or more candidates, map the selected numbers to `session_*` `context_id` values and call MCP `muninn_read({ context_ids })`. The read result is the imported context for the current conversation. If the user asks for source provenance or references behind a candidate, map the selected number to its candidate `session_*` `context_id` and call MCP `muninn_explain`.
```

Supported user form:

```text
$muninn-import MCP schema discussion from yesterday
$muninn-import --top 8 MCP schema discussion
```

## Server Responsibilities

The server must own the behavior behind workflow HTTP APIs and MCP context tools:

- Resolve workspace paths to canonical project identities for `recent`.
- Compose recent sessions and signals for `recent`.
- Compose recalled context from past or other sessions within a budget for `muninn_recall`.
- Search and rank candidate session contexts for `muninn_list`.
- Include stable `session_*` and `turn_*` `context_id` values in `recent`, `muninn_recall`, `muninn_list`, `muninn_read`, and `muninn_explain` results when drill-down is useful.
- Resolve selected `session_*` and `turn_*` `context_id` values for `muninn_read` without requiring the caller to know storage internals.
- Return context content from `muninn_read` without synthetic refs or provenance views.
- Resolve selected `session_*` `context_id` values for `muninn_explain` into source provenance views.
- For session context backed by extracted source references, map those source refs to their source `turn_*` rows.
- Identify the current session for `capture` without requiring the user to type a session id.
- Store session-level explicit capture state.
- Delete current-session rows and related derived context for `capture({ enabled: false })`.
- Override project auto-capture allowlists when current session state is explicit.
- Keep text rendering source-linked and useful without exposing separate navigation tools.

## Current Backend Gaps

The current backend already has project auto-capture policy, but it does not yet support the target session-level capture behavior.

Missing pieces:

- Session-level capture state keyed by current agent session.
- `POST /api/v1/skill/capture` for `capture({ enabled })`.
- Current-session identification in the skill helper/server call path.
- Deletion of current-session Muninn rows and related derived records.
- Hook gate that checks explicit session state before project allowlist.
- `POST /api/v1/startup/recent` that combines recent sessions and signals for session-start host integration.
- Shared `muninn skill-call` helper command that posts to the capture workflow HTTP route.
- MCP `muninn_recall({ query, budget?, top_k? })` tool for recalling past or other-session context and returning source context references.
- MCP `muninn_list({ query, top_k? })` tool for returning candidate `session_*` contexts with titles and summaries.
- MCP `muninn_read({ context_ids })` tool for resolving selected `session_*` and `turn_*` context handles.
- MCP `muninn_explain({ context_id })` tool for resolving selected `session_*` context handles into source provenance views.
- Removal of default MCP exposure for `print`, previous unscoped `list`, `get_timeline`, `get_detail`, `recent`, `capture`, and `import`.

## Implementation Notes

- MCP request/response types can live near the MCP/server HTTP boundary; workflow helper request/response types can live near the CLI/server HTTP boundary. `common` should only receive shared contracts if multiple packages need them.
- `capture({ enabled: false })` should be marked/described as destructive so Codex can request appropriate confirmation.
- `muninn-import` should be a skill workflow over MCP `muninn_list` and `muninn_read`, not a server-side import route.
- `recent` should be safe for automatic invocation at session start; `capture` and `import` require explicit user intent.
- `muninn_recall` can be agent-initiated when the current conversation lacks historical context or when the user asks Muninn to remember what happened before.
- `muninn_list` can be agent-initiated when the user or agent needs to select prior session context by query.
- `muninn_read` can be agent-initiated only for selected `session_*` and `turn_*` `context_id` handles returned by Muninn.
- `muninn_explain` can be agent-initiated only for selected `session_*` `context_id` handles when source provenance or references are needed.
- `muninn_recall` and `muninn_list` may accept `top_k`; `muninn_read` and `muninn_explain` must not.
- `muninn_read` must not accept a budget or return refs.
- `muninn_explain` must not accept a budget, batch input, or recursive explanation option.
- `recent` output should include suggested recall queries after recent sessions and signals.
- `mcp/src/demo-client.ts` must be removed or rewritten so it only exercises `muninn_recall`, `muninn_list`, `muninn_read`, and `muninn_explain`.
- `mcp/README.md` and `mcp/DEMO.md` must describe the new four-tool MCP surface only.
- CLI docs must describe `muninn skill-call` as a helper surface for installed skills, not as the primary end-user command set.

## Target MCP Module Code

Implementation should regenerate the MCP module around a single registry instead of patching the existing `registerTool` calls in place. The target module shape is:

```ts
#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ServerClient } from './server-client.js';

const RecallInput = z.object({
  query: z.string().min(1).describe('Query for recalling past or other-session Muninn context'),
  budget: z.number().int().positive().optional().describe('Character budget for recalled context'),
  top_k: z.number().int().positive().optional().describe('Maximum number of matched context items to use'),
});

const ListInput = z.object({
  query: z.string().min(1).describe('Query for listing candidate Muninn session contexts'),
  top_k: z.number().int().positive().optional().describe('Maximum number of candidate sessions to return'),
});

const ReadInput = z.object({
  context_ids: z
    .array(z.string().regex(/^(session|turn)_.+$/))
    .min(1)
    .describe('Muninn session_* or turn_* context_id values to read'),
});

const ExplainInput = z.object({
  context_id: z
    .string()
    .regex(/^session_.+$/)
    .describe('Muninn session_* context_id whose source provenance and references should be inspected'),
});

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
};

type ToolDefinition<Schema extends z.ZodTypeAny> = {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  run(args: z.infer<Schema>, client: ServerClient): Promise<string>;
};

function textResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

const tools: ToolDefinition<z.ZodTypeAny>[] = [
  {
    name: 'muninn_recall',
    description: 'Recall context from past or other Muninn sessions by query and return source context references. Accepts optional top_k and budget.',
    inputSchema: RecallInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args, client) => client.recall(args),
  },
  {
    name: 'muninn_list',
    description: 'List candidate Muninn session contexts by query. Returns session_* context_ids with titles and summaries for selection before read.',
    inputSchema: ListInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args, client) => client.list(args),
  },
  {
    name: 'muninn_read',
    description: 'Read selected Muninn context content by context_id. Accepts session_* and turn_* context_ids. Use selectively when exact content is needed.',
    inputSchema: ReadInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args, client) => client.read(args),
  },
  {
    name: 'muninn_explain',
    description: 'Inspect source provenance and references for a session_* context_id. Use selectively when evidence or origin detail is needed.',
    inputSchema: ExplainInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args, client) => client.explain(args),
  },
];

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
        annotations: tool.annotations,
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
```

The target server client shape is:

```ts
export class ServerClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = process.env.MUNINN_SERVER_BASE_URL || 'http://127.0.0.1:8080') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  recall(request: { query: string; budget?: number; top_k?: number }): Promise<string> {
    return this.postText('/api/v1/mcp/recall', request);
  }

  list(request: { query: string; top_k?: number }): Promise<string> {
    return this.postText('/api/v1/mcp/list', request);
  }

  read(request: { context_ids: string[] }): Promise<string> {
    return this.postText('/api/v1/mcp/read', request);
  }

  explain(request: { context_id: string }): Promise<string> {
    return this.postText('/api/v1/mcp/explain', request);
  }

  private async postText(path: string, body: unknown): Promise<string> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(text.trim() || `Muninn request failed with status ${response.status}`);
    }
    return text;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    const token = process.env.MUNINN_DESKTOP_TOKEN;
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }
}
```

The concrete implementation may move schemas into a helper module if tests need to import them, but the generated MCP runtime surface must remain the four tools above.

## Target Skill Helper Shape

Implementation should add a shared CLI-backed helper for the capture skill instead of duplicating HTTP logic in the skill. The helper should be a hidden or low-level command under `@muninn/cli`, not the primary end-user command surface.

Target command behavior:

```text
muninn skill-call capture --enabled true|false
  -> POST /api/v1/skill/capture
     { "enabled": true|false }
```

The helper should:

- Reuse the same server base URL and auth token resolution as the MCP server client.
- Print successful server responses as text without wrapping them in extra JSON.
- Print server errors as actionable text and exit non-zero.
- Avoid exposing server-side tuning fields.

## Required Design Decisions For Implementation

### Current Session Identity

`capture({ enabled })` intentionally does not accept `agent`, `cwd`, `project`, or `sessionId`. The implementation must provide current-session identity through the Muninn host integration or skill helper call context. The user-facing command remains "this session", not "this project" or "session id X".

If the skill helper/server call path cannot resolve the current session, `capture` must return an actionable error and perform no write or delete:

```text
Muninn could not identify the current session, so no capture change was made.
```

The implementation plan must choose the exact identity transport for Codex and Claude Code before implementing `capture`.

### Import Selection Flow

`muninn-import` is a skill workflow, not an MCP tool or server-side import route. It should always list candidates first:

```text
muninn-import <query>
  -> MCP muninn_list({ query, top_k? })
  -> show numbered session candidates
  -> user chooses one or more numbers
  -> MCP muninn_read({ context_ids: selected session_* ids })
```

The skill must not auto-read every listed candidate. It should read only the candidates the user selects.

The externally visible rule is:

```text
import means selecting prior session context, then reading that selected context into the current conversation
```

### Session Deletion Scope

`capture({ enabled: false })` must delete the current session's Muninn data without leaving dangling references. At minimum, deletion must cover:

- turn rows for the current session,
- session snapshots derived from those turns,
- extraction rows derived only from those turns,
- observation/context rows that no longer have valid source references after the session is removed,
- session index entries and cached UI/session tree data for that session.

If a derived row references both the deleted session and other sessions, implementation must either rewrite it without the deleted references or remove it and let the pipeline rebuild it. Keeping stale references to deleted turns is not allowed.
