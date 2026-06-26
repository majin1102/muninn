# Muninn Skill And MCP Context Surface Design

## Summary

Muninn should expose a skill-first context surface for user workflows, backed by a minimal MCP surface for query recall and structured drill-down.

The user-facing skill workflows are:

```text
muninn-capture -> assistant magic word + host hook capture flow
muninn-import  -> MCP muninn_list + muninn_read import flow
```

The MCP server should expose four structured context tools:

```text
muninn_recall({ query, budget?, top_k? })
muninn_list({ query, top_k? })
muninn_read({ context_ids })
muninn_explain({ context_id })
```

The capture skill should make the assistant emit a strict Muninn control marker. The host Stop hook consumes that marker while it has reliable session identity, updates host-local capture policy, and uses existing server capture/delete capabilities as needed. The import skill should orchestrate MCP `muninn_list` and `muninn_read` calls. The server owns context lookup, source content, provenance, and storage-side deletion, but host integrations own session capture policy.

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
- Keep project auto-capture allowlists separate from host-local current-session capture actions.
- Keep import as a single-query selection workflow that lists candidate sessions, asks the user to choose, and reads selected context.
- Keep capture mutation inside host hooks with reliable session identity; do not require the capture skill or MCP layer to infer the current session.

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

Skills provide explicit user entries in the skill UI and encode workflow behavior such as parsing flags, choosing candidates, asking for confirmation, and deciding when drill-down is useful. The capture skill emits a strict control marker that host hooks can consume. The import skill orchestrates MCP `muninn_list` and `muninn_read` calls.

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

Server HTTP APIs back host startup context and turn capture. They are not MCP tools.

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

### Host-local capture control

Purpose: include or remove the current session from Muninn without asking MCP or a skill helper to infer current-session identity.

The capture user entry is a skill, but the mutation is performed by the host Stop hook. The skill instructs the assistant to emit one strict control marker in its response:

```xml
<muninn:capture enabled="true" />
```

```xml
<muninn:capture enabled="false" />
```

Behavior:

- The Stop hook reads the latest assistant turn and consumes only the strict marker forms above.
- The Stop hook resolves the current `session_id`, transcript path, project, cwd, and agent from host-provided hook context.
- The Stop hook stores current-session capture policy in host-local state, not server state.
- `enabled="true"` enables host-local capture for the current session, backfills the current transcript through the existing turn capture API, and allows future turns from this session to continue entering Muninn.
- `enabled="false"` disables host-local capture for the current session, calls the existing server-side delete-by-session capability for `{ agent, project, sessionId }`, and prevents future turns from this session from entering Muninn.
- `enabled="false"` is destructive and must be described as deletion, not pause.
- The operation is scoped to the current agent session, not to the project.
- The operation must not edit project auto-capture allowlists.
- The control marker itself must not be captured as ordinary Muninn context.
- If the Stop hook cannot resolve reliable current-session identity, it must fail closed and perform no policy change, backfill, or deletion.

Policy storage:

- Client capture policy is stored under the client host's local Muninn home, for example `$MUNINN_HOME/clients/codex/capture.json`; with the default home this is under `~/.muninn/clients/codex/capture.json`.
- Client capture policy uses the same agent/project field model as the server capture policy, plus explicit session overrides written by `muninn-capture`.
- Client capture policy defaults to disabled: absent agent, project, and session entries mean "do not capture".
- Users may enable default client-side automatic capture by editing the local client policy file.
- The server-side capture policy in `$MUNINN_HOME/muninn.json` remains server-local only. It must not be treated as a global policy for remote or host-client capture decisions.

Policy model:

```text
if current session is explicitly disabled in host-local policy:
  skip future hook capture for this session

else if current session is explicitly enabled in host-local policy:
  allow hook capture for this session, even when client project auto-capture is disabled

else if client policy enables the agent and project:
  allow hook capture for this project

else:
  skip hook capture
```

Client project policy is the default automatic capture policy. Explicit session capture is a host-local user action for the current session.

Deletion should reuse the existing delete-by-session behavior currently used by imported-session deletion. The hook should depend on a hook-facing/internal boundary, not on a UI route such as `/app/api/import/:agent/session`.

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

## Skill Entries

Muninn should ship two user-facing skills with clear trigger descriptions. `muninn-capture` emits a strict control marker for host hooks. `muninn-import` orchestrates MCP `muninn_list` and `muninn_read`. Skills may instruct the agent to use MCP `muninn_recall`, `muninn_list`, `muninn_read`, and `muninn_explain` for context recovery and selective drill-down, but those MCP tools are not separate skills.

### `muninn-capture`

Display name: `Muninn Capture`

Trigger description:

```yaml
description: Use when the user explicitly asks Muninn to capture, remember, remove, forget, include, or exclude the current session.
```

Core instruction:

```text
For explicit capture-enable requests, reply with exactly `<muninn:capture enabled="true" />` and no other text. For explicit capture-disable, remove, delete, forget, or exclude requests, reply with exactly `<muninn:capture enabled="false" />` and no other text. Do not call an MCP `capture` tool; it should not exist. Do not call `muninn skill-call capture`; it should not exist. Map `+1`, "on", "enable", "capture", "remember this session", or "include this session" to `true`. Map `-1`, "off", "disable", "remove this session", "delete this session", "forget this session", or "exclude this session" to `false`. Treat `false` as destructive deletion of the current session from Muninn.
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
- Accept captured turns from host hooks through the existing turn capture API.
- Treat client hook capture policy as client-local. The server must not use its server-local project policy to reject turns that a host hook already decided to send.
- Provide or expose a hook-facing/internal delete-by-session capability for `{ agent, project, sessionId }`.
- Keep text rendering source-linked and useful without exposing separate navigation tools.

## Current Backend Gaps

The current backend already has project auto-capture policy and imported-session deletion logic, but the host integrations do not yet support the target magic-marker capture behavior.

Missing pieces:

- Client-local capture policy file under the local Muninn home, using agent/project policy plus session overrides and defaulting to disabled.
- Host-local session capture policy keyed by reliable current-session identity.
- Strict magic-marker parsing in Stop hooks for `<muninn:capture enabled="true" />` and `<muninn:capture enabled="false" />`.
- Hook-side current-session identification from host-provided `session_id`, transcript path, project, cwd, and agent.
- Hook-side backfill of the current transcript through the existing turn capture API when capture is enabled.
- Hook-side deletion flow that calls existing delete-by-session behavior through a hook-facing/internal boundary when capture is disabled.
- Hook gate that checks host-local explicit session state before client-local agent/project policy.
- Turn capture API behavior that accepts client-authorized hook captures without applying the server-local capture policy as an additional gate.
- `POST /api/v1/startup/recent` that combines recent sessions and signals for session-start host integration.
- MCP `muninn_recall({ query, budget?, top_k? })` tool for recalling past or other-session context and returning source context references.
- MCP `muninn_list({ query, top_k? })` tool for returning candidate `session_*` contexts with titles and summaries.
- MCP `muninn_read({ context_ids })` tool for resolving selected `session_*` and `turn_*` context handles.
- MCP `muninn_explain({ context_id })` tool for resolving selected `session_*` context handles into source provenance views.
- Removal of default MCP exposure for `print`, previous unscoped `list`, `get_timeline`, `get_detail`, `recent`, `capture`, and `import`.

## Implementation Notes

- MCP request/response types can live near the MCP/server HTTP boundary. Host-local capture policy contracts should live near host hook integrations unless multiple packages need them.
- `muninn-capture` should be marked/described as destructive for disable/delete requests so Codex can request appropriate confirmation.
- `muninn-import` should be a skill workflow over MCP `muninn_list` and `muninn_read`, not a server-side import route.
- `recent` should be safe for automatic invocation at session start; `capture` and `import` require explicit user intent.
- Capture policy is host-local. The server must not be the source of truth for per-session capture allow/deny state in this design.
- Server-local capture policy and client-local capture policy are separate files. The server policy only controls server-local capture behavior; the client policy controls host hook capture behavior and defaults to disabled.
- Capture control markers must be parsed only from the latest assistant turn and must not be captured as ordinary Muninn context.
- Capture enable backfills the current transcript through the existing turn capture API and enables future hook capture for this session.
- Capture disable deletes current-session Muninn data through existing delete-by-session behavior and disables future hook capture for this session.
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

## Target Host Capture Shape

Implementation should add host-local capture control to agent hooks instead of adding a capture MCP tool or capture skill-call helper.

Target hook behavior:

```text
latest assistant turn contains exactly <muninn:capture enabled="true" />
  -> resolve current session identity from hook payload/transcript
  -> write host-local session capture policy: enabled
  -> backfill current transcript through existing turn capture API
  -> skip capturing the marker turn as ordinary context

latest assistant turn contains exactly <muninn:capture enabled="false" />
  -> resolve current session identity from hook payload/transcript
  -> write host-local session capture policy: disabled
  -> delete existing Muninn data for { agent, project, sessionId }
  -> skip capturing the marker turn as ordinary context
```

The host integration should:

- Store capture policy locally under the client host's Muninn home, using `$MUNINN_HOME/clients/<agent>/capture.json` by default.
- Use this file shape:

```ts
type ClientCapturePolicyFile = {
  capture?: {
    agents?: Record<string, boolean>;
    projects?: Record<string, Record<string, boolean>>;
    sessions?: Record<string, Record<string, boolean>>;
  };
};
```

- Treat missing `capture`, missing agent entries, missing project entries, and missing session entries as disabled.
- Reuse the server capture policy field model for `agents` and `projects`, but do not read the server's `$MUNINN_HOME/muninn.json` as the client hook policy.
- Store explicit `muninn-capture` decisions in `capture.sessions[agent][sessionKey]`, where `sessionKey` is a stable key derived from the resolved current-session identity.
- Evaluate capture in this order: explicit disabled session, explicit enabled session, enabled client agent plus enabled client project, disabled.
- Key policy by stable session identity derived from host-provided `session_id`, project, cwd, and agent.
- Never infer current session identity from "latest transcript file" alone for deletion.
- Fail closed if reliable current-session identity is unavailable.
- Reuse the same server base URL and auth token resolution as existing hook capture.
- Reuse existing imported-session deletion logic through a hook-facing/internal boundary rather than coupling hooks to UI routes.

## Required Design Decisions For Implementation

### Current Session Identity

`muninn-capture` intentionally does not ask the user to type `agent`, `cwd`, `project`, `sessionId`, or `sessionKey`. The implementation must resolve current-session identity from host hook context. The user-facing command remains "this session", not "this project" or "session id X".

If the Stop hook cannot resolve the current session, it must log an actionable error and perform no policy write, backfill, capture, or deletion:

```text
Muninn could not identify the current session, so no capture change was made.
```

For Codex, the Stop hook can use hook payload `session_id` or `transcript_path`, then read the transcript to derive project, cwd, and agent ownership. Other hosts must provide an equivalently reliable identity source before supporting `muninn-capture`.

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

`<muninn:capture enabled="false" />` must delete the current session's Muninn data without leaving dangling references. At minimum, deletion must cover:

- turn rows for the current session,
- session snapshots derived from those turns,
- extraction rows derived only from those turns,
- observation/context rows that no longer have valid source references after the session is removed,
- session index entries and cached UI/session tree data for that session.

If a derived row references both the deleted session and other sessions, implementation must either rewrite it without the deleted references or remove it and let the pipeline rebuild it. Keeping stale references to deleted turns is not allowed.
