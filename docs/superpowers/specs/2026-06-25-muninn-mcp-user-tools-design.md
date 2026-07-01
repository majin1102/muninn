# Muninn Skill And MCP Context Surface Design

## Summary

Muninn should expose a skill-first context surface for user workflows, backed by a minimal MCP surface for query recall and structured drill-down.

The user-facing skill workflows are:

```text
muninn-capture -> local client capture policy edit
muninn-import  -> MCP muninn-list + muninn-read import flow
```

The MCP server should expose four structured context tools:

```text
muninn-recall({ query, budget?, top_k? })
muninn-list({ query, top_k? })
muninn-read({ context_ids })
muninn-explain({ context_id })
```

The capture skill should edit client-local Muninn capture policy directly. Host hooks read that local policy and client-local transcript progress state to incrementally import only allowed sessions. The import skill should orchestrate MCP `muninn-list` and `muninn-read` calls. The server owns context lookup, source content, provenance, and storage-side deletion, but host integrations own client capture policy and transcript scanning progress.

Codex user entry should come from Muninn skills, not from assuming MCP tools appear as slash commands. The skill names are prefixed to avoid collisions:

```text
muninn-capture
muninn-import
```

## Goals

- Replace the current demo-oriented MCP surface with four context tools and two user-facing workflow skills.
- Keep MCP focused on context recall, candidate listing, and structured `context_id` drill-down.
- Support explicit user invocation through skills and agent-initiated recall and drill-down through MCP.
- Make current-session capture and query-driven import first-class skill workflows.
- Make query recall a first-class MCP capability for remembering context that happened in past or other sessions.
- Make query-scoped candidate context listing a first-class MCP capability for selecting prior sessions.
- Make context content reading and source provenance explanation first-class MCP drill-down capabilities.
- Keep project auto-capture allowlists separate from client-local current-session capture actions.
- Keep import as a single-query selection workflow that lists candidate sessions, asks the user to choose, and reads selected context.
- Keep capture mutation and transcript scanning in the client host integration; do not require MCP or server policy to infer the current session.

## Non-Goals

- Do not expose `print`, `get_timeline`, `get_detail`, or the previous unscoped `list` behavior as default user tools.
- Do not implement a generic context browser through MCP in this design.
- Do not make MCP tools depend on Codex slash-command availability.
- Do not expose `capture` or `import` as MCP tools in this design.
- Do not add compatibility handling for obsolete MCP tool names.
- Do not use `capture` to edit project auto-capture allowlists.

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
muninn-recall
muninn-list
muninn-read
muninn-explain
```

The new `muninn-list` tool is query-scoped candidate listing. It is not a compatibility alias for the previous unscoped `list` tool.

Remove or rewrite any Muninn skill/custom-prompt entries that target the old MCP surface. The shipped Muninn user entry should be exactly these two current skills:

```text
muninn-capture
muninn-import
```

Do not ship a generic `$muninn <command>` parser skill.

## Product Model

There are three separate layers:

```text
Muninn skills = user and workflow behavior layer
MCP tools = query recall, candidate listing, and structured context drill-down capability layer
Muninn server HTTP APIs = backend workflow and context operations
```

Skills provide explicit user entries in the skill UI and encode workflow behavior such as parsing flags, choosing candidates, asking for confirmation, and deciding when drill-down is useful. The capture skill edits client-local capture policy. The import skill orchestrates MCP `muninn-list` and `muninn-read` calls.

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
muninn-recall
muninn-list
muninn-read
muninn-explain
```

There should be no `capture` or `import` MCP tools. Those names belong to skill workflows. Server HTTP routes are backing or internal APIs only where explicitly specified.

## Context ID Model

Muninn outputs should use `context_id` for stable drill-down handles. In the current MVP surface, public context ids use three families:

```text
session_*
turn_*
ext:*
```

`session_*` identifies session-level context. `turn_*` identifies source conversation turn content. `ext:*` identifies extracted context content. These prefixes route tool usage: `muninn-read` accepts `session_*`, `turn_*`, and `ext:*`; `muninn-explain` accepts `session_*` only.

Agents may recognize the `session_*`, `turn_*`, and `ext:*` prefixes for tool routing, but they must treat the rest of every `context_id` as an opaque handle. They should not parse, truncate, transform, or synthesize context ids. They should pass only `context_id` values returned by Muninn back to `muninn-read` or `muninn-explain`.

Server HTTP APIs and MCP context tools may return `context_id` values. A returned id is not a request to read or explain immediately. It is a drill-down handle for later use when the current conversation needs additional content, evidence, or origin detail.

## Server HTTP APIs

Server HTTP APIs back host capture and MCP context operations. They are not MCP tools.

### Client-local capture control

Purpose: include or remove sessions from Muninn using client-local policy, without asking MCP or the server to decide host capture state.

The capture user entry is a skill/helper that edits a client-local policy file. Host hooks read that policy before scanning transcripts. If the current session or project is allowed, the hook imports newly observed transcript content from the last recorded offset/sequence.

Behavior:

- The capture skill/helper writes client-local policy directly; it does not ask the assistant to emit a control marker.
- Host hooks resolve `session_id`, transcript path, project, cwd, and agent from host-provided hook context.
- Host hooks read client-local capture policy before scanning or importing transcript content.
- If policy allows capture, the hook reads client-local progress state to determine whether the session has been imported before and where scanning should resume.
- The progress state records enough transcript position information to avoid duplicate import, keyed by canonical `muninnSessionKey`, such as transcript path, last turn sequence, byte offset, or host-specific cursor.
- Allowed sessions are imported incrementally through the existing turn capture API.
- Disabling the current session deletes current-session Muninn data through the server-side delete-by-session-key capability for canonical `muninnSessionKey`, clears or marks the client-local progress state for that key, and prevents future imports while disabled.
- Disable is destructive and must be described as deletion, not pause.
- Session-scoped capture operations are scoped to the current agent session, not to the project.
- Session-scoped capture operations must not edit project auto-capture allowlists.
- If no progress record exists, the hook treats the transcript as not previously imported and starts from the beginning.
- If the hook cannot resolve reliable current-session identity or cannot safely read/write the progress store, it must fail closed and perform no import or deletion.

Policy storage:

- Capture policy is stored at `$MUNINN_HOME/capture.json`; with the default home this is `~/.muninn/capture.json`.
- Server and client code read the capture policy from their own local `$MUNINN_HOME/capture.json`.
- Server and client capture policy use the same `CapturePolicyFile` shape.
- Client capture policy uses explicit session overrides written by the capture skill/helper.
- Capture policy defaults to disabled for both server-local capture and client-hook capture: absent agent, project, and session entries mean "do not capture". This replaces the previous server behavior where a missing agent entry was treated as enabled unless explicitly false.
- Users may enable default client-side automatic capture by editing the local client policy file.
- Client transcript progress is stored at `$MUNINN_HOME/progress.json`; with the default home this is `~/.muninn/progress.json`.
- `$MUNINN_HOME/muninn.json` remains the server runtime configuration file for storage, providers, extractor, observer, and watchdog settings. It must not contain capture policy.
- The server-side capture policy read from the server process's local `$MUNINN_HOME/capture.json` remains server-local only. It must not be treated as a global policy for remote or host-client capture decisions.

Shared policy shape:

```ts
type AgentName = string;
type CanonicalProjectIdentity = string;
type MuninnSessionKey = string;

type CapturePolicyFile = {
  capture?: {
    agents?: Record<AgentName, boolean>;
    projects?: Record<AgentName, Record<CanonicalProjectIdentity, boolean>>;
    sessions?: Record<MuninnSessionKey, boolean>;
  };
};
```

`capture.projects` is indexed as `capture.projects[agent][canonicalProjectIdentity]`, matching the existing server policy shape.

Shared progress shape:

```ts
type CaptureProgressFile = {
  sessions?: Record<MuninnSessionKey, {
    agent: string;
    project: string;
    cwd: string;
    sessionId: string;
    transcriptPath: string;
    lastTurnSequence?: number;
    byteOffset?: number;
    eventIndex?: number;
    updatedAt: string;
  }>;
};
```

The progress file must be written atomically after successful capture requests. Missing progress for a session means no previous import is known and the next allowed hook scan starts from the beginning of that transcript.

Canonical session key:

```ts
type MuninnSessionIdentity = {
  project: string;
  sessionId: string;
  agent: string;
};
```

`muninnSessionKey` must be generated by a shared helper in `common` from the host-available identity fields above. Treat the generated key as opaque outside that helper. Callers must not parse it, concatenate it manually, or depend on a human-readable string format.

`project` must be the canonical project identity resolved from host `cwd`, not the raw working directory path. `cwd` remains runtime metadata for transcript scanning, worktree display, and debugging, but it must not be part of the canonical `muninnSessionKey`.

The canonical `muninnSessionKey` must not include server-local `observer`, extractor name, provider config, database name, raw `cwd`, or any other server-local runtime field. Existing server-side session key generation that includes `observer:<observer>` must be replaced with the shared helper.

The same `muninnSessionKey` value must be used by:

- `capture.sessions`,
- `progress.sessions`,
- turn/session rows stored by the server,
- `muninn-list` current-session exclusion,
- delete-by-session-key.

For MCP hidden structured current-session metadata, the server must derive `muninnSessionKey` from `{ project, sessionId, agent }` instead of receiving a pre-concatenated key from the MCP adapter.

Policy model:

```text
if current session is explicitly disabled in client-local policy:
  skip future hook capture for this session

else if current session is explicitly enabled in client-local policy:
  allow hook capture for this session, even when client project auto-capture is disabled

else if client policy enables the agent and project:
  allow hook capture for this project

else:
  skip hook capture
```

Client project policy is the default automatic capture policy. Explicit session capture is a client-local user action for the current session.

Deletion should reuse the existing delete-by-session behavior currently used by imported-session deletion. The hook should depend on a hook-facing/internal boundary, not on a UI route such as `/app/api/import/:agent/session`.

## MCP Context Tools

These are the only tools registered by the MCP server.

### `muninn-recall`

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
- Reject requests with `budget > 20000`.
- Use `top_k` as an optional maximum number of matched context items or source references to include before composing the answer.
- Use a server default result count when `top_k` is absent.
- Reject requests with `top_k > 50`.
- If a host, skill, or user-facing command supports `--top <integer>`, map it to MCP `top_k`.
- Return a concise recollection of what happened in past or other sessions.
- Return source context references when useful. These references are `session_*`, `turn_*`, or `ext:*` `context_id` values that point back to the original context.
- Keep query recall concise enough to choose relevant context; use `muninn-read` for original context content and `muninn-explain` for session provenance and references when needed.
- Do not treat `query` values that look like `session_*`, `turn_*`, or `ext:*` as drill-down. Context-id drill-down belongs to `muninn-read` and `muninn-explain`.
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

### `muninn-list`

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
- Reject requests with `top_k > 50`.
- If a host, skill, or user-facing command supports `--top <integer>`, map it to MCP `top_k`.
- Return ranked candidate sessions only; do not return generic database listings.
- Each candidate must include a `session_*` `context_id`, title, and summary.
- Exclude the current session when host current-session identity is available because `muninn-import` is for prior sessions and prior context.
- Current-session exclusion is based on host-provided structured current-session identity, not user input. The MCP adapter or server request path must attach `{ project, sessionId, agent }` when all fields are available so the server can generate `muninnSessionKey` and filter by exact `sessionKey` equality.
- If the MCP adapter does not have reliable host-provided structured identity, it must not infer one and `muninn-list` must not claim current-session exclusion.
- Do not return `turn_*` context ids from `muninn-list`; turn-level detail belongs to `muninn-read` after a session is selected.
- Do not read, import, or auto-select candidate content.
- Use `muninn-read` after the user or agent selects candidate `session_*` context ids.
- Use `muninn-explain` only if source provenance or references behind a selected session are needed.
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

`muninn-list` is the selection surface. It returns handles, not imported content. The agent should call `muninn-read` only for selected candidates, not for every listed `context_id`.

### `muninn-read`

Purpose: read selected Muninn context content by `context_id` when exact content is needed.

Schema:

```ts
type ReadInput = {
  context_ids: string[];
};
```

Behavior:

- Accept one or more `session_*`, `turn_*`, or `ext:*` `context_id` values returned by Muninn.
- Reject unsupported context id families.
- Use `muninn-read` selectively. A returned `context_id` is a drill-down handle, not a read request.
- Read only the supplied context ids.
- For `session_*`, return session timeline/content and allow the content to include `turn_*` or `ext:*` context ids as navigation handles.
- For `turn_*`, return the source conversation turn content.
- For `ext:*`, return the extracted context content itself.
- Do not return provenance, references, or explanation details.
- If the agent needs source provenance or references for a `session_*` context item, it should call `muninn-explain` with that `context_id`.
- Do not call `muninn-explain` for `turn_*`; a turn is already source content.
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

The agent should not infer source provenance from read content. Source provenance inspection belongs to `muninn-explain`.

### `muninn-explain`

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
- Use `muninn-explain` selectively. A returned `context_id` is a drill-down handle, not an explanation request.
- Return source provenance and references for that session-level context item.
- Resolve supporting source references to `turn_*` context ids and source snippets or summaries where useful.
- Do not return the full session context itself except when needed to orient the provenance view; use `muninn-read` for the content itself.
- Do not return synthetic `relation` or `label` fields. The current backend has source reference arrays, not structured relation labels.
- Do not accept `budget`, `refs`, `depth`, or recursive explanation parameters.
- Do not explain every recalled or read context item automatically. Use `muninn-explain` only when the current conversation needs source provenance, references, or exact surrounding evidence.

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

Muninn should ship two user-facing skills with clear trigger descriptions. `muninn-capture` updates client-local capture policy. `muninn-import` orchestrates MCP `muninn-list` and `muninn-read`. Skills may instruct the agent to use MCP `muninn-recall`, `muninn-list`, `muninn-read`, and `muninn-explain` for context recovery and selective drill-down, but those MCP tools are not separate skills.

### `muninn-capture`

Display name: `Muninn Capture`

Trigger description:

```yaml
description: Use when the user explicitly asks Muninn to capture, remember, remove, forget, include, or exclude the current session.
```

Core instruction:

```text
Call the installed Muninn client helper to edit the client-local capture policy for the current session. The helper must receive current-session identity from the host integration, not from model inference. If the helper cannot access reliable host session identity, it must fail closed and report that no capture change was made. Do not emit magic words or XML control markers. Do not call an MCP `capture` tool; it should not exist. Do not call `muninn skill-call capture`; it should not exist. Map `+1`, "on", "enable", "capture", "remember this session", or "include this session" to session capture enabled. Map `-1`, "off", "disable", "remove this session", "delete this session", "forget this session", or "exclude this session" to session capture disabled and deletion requested. Treat disable as destructive deletion of the current session from Muninn.
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
Call MCP `muninn-list({ query, top_k? })` with the user's remaining text as `query`. Parse optional `--top <integer>` from the user request and pass it as `top_k` when present. Do not call an MCP `import` tool; it should not exist. Do not call `muninn skill-call import`; it should not exist. Show the numbered candidate list with session titles and summaries, then ask the user to choose by number. Keep the candidate `session_*` `context_id` values available for tool use. When the user chooses one or more candidates, map the selected numbers to `session_*` `context_id` values and call MCP `muninn-read({ context_ids })`. The read result is the imported context for the current conversation. If the user asks for source provenance or references behind a candidate, map the selected number to its candidate `session_*` `context_id` and call MCP `muninn-explain`.
```

Supported user form:

```text
$muninn-import MCP schema discussion from yesterday
$muninn-import --top 8 MCP schema discussion
```

## Server Responsibilities

The server must own the behavior behind workflow HTTP APIs and MCP context tools:

- Compose recalled context from past or other sessions within a budget for `muninn-recall`.
- Search and rank candidate session contexts for `muninn-list`.
- Include stable `session_*`, `turn_*`, and `ext:*` `context_id` values in `muninn-recall`, `muninn-list`, `muninn-read`, and `muninn-explain` results when drill-down is useful.
- Resolve selected `session_*`, `turn_*`, and `ext:*` `context_id` values for `muninn-read` without requiring the caller to know storage internals.
- Return context content from `muninn-read` without synthetic refs or provenance views.
- Resolve selected `session_*` `context_id` values for `muninn-explain` into source provenance views.
- For session context backed by extracted source references, map those source refs to their source `turn_*` rows.
- Accept captured turns from host hooks through the existing turn capture API.
- Store the canonical `muninnSessionKey` on server-side turn/session records and expose it in context listing results where session identity is needed.
- Treat client hook capture policy as client-local. The server must not use its server-local project policy to reject turns that a host hook already decided to send.
- Provide or expose a hook-facing/internal delete-by-session-key capability for canonical `muninnSessionKey`.
- Keep text rendering source-linked and useful without exposing separate navigation tools.

## Current Backend Gaps

The current backend already has project auto-capture policy in `muninn.json` and imported-session deletion logic, but the target design moves capture policy to `$MUNINN_HOME/capture.json` and adds client-local transcript progress behavior.

Missing pieces:

- Shared capture policy file at `$MUNINN_HOME/capture.json`, using agent/project policy plus session overrides and defaulting to disabled.
- Removal of capture policy from `$MUNINN_HOME/muninn.json`.
- Server capture policy reads and writes against `$MUNINN_HOME/capture.json`.
- Client-local transcript progress file at `$MUNINN_HOME/progress.json`, keyed by reliable current-session identity.
- Installed capture skill/helper behavior that edits client-local policy directly.
- Shared `muninnSessionKey` helper in `common`, generated from canonical project identity, normalized `sessionId`, and `agent`.
- Removal of `observer:<observer>` and extractor name from public/current-session key generation.
- Host-provided structured current-session identity for the capture helper and MCP adapter.
- Hook-side current-session identification from host-provided `session_id`, transcript path, cwd, resolved project identity, and agent.
- Hook-side incremental transcript scanning from the recorded sequence, byte offset, or host-specific cursor when capture is enabled.
- Hook-side deletion flow that calls delete-by-session-key behavior through a hook-facing/internal boundary when capture is disabled.
- Hook gate that checks client-local explicit session state before client-local agent/project policy.
- Turn capture API behavior that accepts client-authorized hook captures without applying the server-local capture policy as an additional gate.
- MCP `muninn-recall({ query, budget?, top_k? })` tool for recalling past or other-session context and returning source context references.
- MCP `muninn-list({ query, top_k? })` tool for returning candidate `session_*` contexts with titles and summaries.
- Structured current-session identity propagation into `muninn-list` requests so the server can generate `muninnSessionKey` and exclude the current session by exact key equality when available.
- MCP `muninn-read({ context_ids })` tool for resolving selected `session_*`, `turn_*`, and `ext:*` context handles.
- MCP `muninn-explain({ context_id })` tool for resolving selected `session_*` context handles into source provenance views.
- Removal of default MCP exposure for `print`, previous unscoped `list`, `get_timeline`, `get_detail`, `capture`, and `import`.

## Implementation Notes

- MCP request/response types can live near the MCP/server HTTP boundary. Shared capture contracts and helpers must live in `common`, including `CapturePolicyFile`, `CaptureProgressFile`, `MuninnSessionIdentity`, and the `muninnSessionKey` helper. Server, host hooks, and skill helpers should import these contracts instead of redefining local copies.
- `muninn-capture` should be marked/described as destructive for disable/delete requests so Codex can request appropriate confirmation before editing local policy and deleting current-session data.
- `muninn-import` should be a skill workflow over MCP `muninn-list` and `muninn-read`, not a server-side import route.
- `muninn-capture` and `muninn-import` require explicit user intent.
- Capture policy is local to the process home that reads `$MUNINN_HOME/capture.json`. The server must not be the source of truth for host-client per-session capture allow/deny state in this design.
- Server-local capture and client-hook capture use the same file name and schema, but each runtime reads its own local `$MUNINN_HOME/capture.json`.
- The server must not read capture policy from `$MUNINN_HOME/muninn.json`.
- Capture enable writes client-local policy and lets host hooks import the current transcript incrementally through the existing turn capture API.
- Capture disable deletes current-session Muninn data through existing delete-by-session behavior and disables future hook capture for this session.
- `muninn-recall` can be agent-initiated when the current conversation lacks historical context or when the user asks Muninn to remember what happened before.
- `muninn-list` can be agent-initiated when the user or agent needs to select prior session context by query.
- `muninn-read` can be agent-initiated only for selected `session_*`, `turn_*`, and `ext:*` `context_id` handles returned by Muninn.
- `muninn-explain` can be agent-initiated only for selected `session_*` `context_id` handles when source provenance or references are needed.
- `muninn-recall` and `muninn-list` may accept `top_k`; `muninn-read` and `muninn-explain` must not.
- `muninn-read` must not accept a budget or return refs.
- `muninn-explain` must not accept a budget, batch input, or recursive explanation option.
- `mcp/src/demo-client.ts` must be removed or rewritten so it only exercises `muninn-recall`, `muninn-list`, `muninn-read`, and `muninn-explain`.
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
  budget: z.number().int().positive().max(20000).optional().describe('Character budget for recalled context'),
  top_k: z.number().int().positive().max(50).optional().describe('Maximum number of matched context items to use'),
});

const ListInput = z.object({
  query: z.string().min(1).describe('Query for listing candidate Muninn session contexts'),
  top_k: z.number().int().positive().max(50).optional().describe('Maximum number of candidate sessions to return'),
});

const ReadInput = z.object({
  context_ids: z
    .array(z.string().regex(/^(session|turn)_.+$|^ext:.+$/))
    .min(1)
    .describe('Muninn session_*, turn_*, or ext:* context_id values to read'),
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
    name: 'muninn-recall',
    description: 'Recall context from past or other Muninn sessions by query and return source context references. Accepts optional top_k and budget.',
    inputSchema: RecallInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args, client) => client.recall(args),
  },
  {
    name: 'muninn-list',
    description: 'List candidate Muninn session contexts by query, excluding the current session when host current-session identity is available. Returns session_* context_ids with titles and summaries for selection before read.',
    inputSchema: ListInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args, client) => client.list(args),
  },
  {
    name: 'muninn-read',
    description: 'Read selected Muninn context content by context_id. Accepts session_*, turn_*, and ext:* context_ids. Use selectively when exact content is needed.',
    inputSchema: ReadInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (args, client) => client.read(args),
  },
  {
    name: 'muninn-explain',
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
    return this.postText('/api/v1/mcp/list', {
      ...request,
      session_identity: this.currentSessionIdentity(),
    });
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

  private currentSessionIdentity():
    | { project: string; sessionId: string; agent: string }
    | undefined {
    const project = process.env.MUNINN_SESSION_PROJECT;
    const sessionId = process.env.MUNINN_SESSION_ID;
    const agent = process.env.MUNINN_SESSION_AGENT;
    if (!project || !sessionId || !agent) {
      return undefined;
    }
    return { project, sessionId, agent };
  }
}
```

The concrete implementation may move schemas into a helper module if tests need to import them, but the generated MCP runtime surface must remain the four tools above.

Current-session context used for `muninn-list` exclusion is transport context, not public MCP input. The MCP schema must remain `{ query, top_k? }`; host integrations should expose structured identity fields to the MCP adapter, for example `MUNINN_SESSION_PROJECT`, `MUNINN_SESSION_ID`, and `MUNINN_SESSION_AGENT`. The MCP adapter should attach those fields as internal `session_identity` in the MCP adapter -> server HTTP request when all three are available. The server then generates the canonical `muninnSessionKey` with the shared helper and filters by exact `sessionKey` equality. The MCP adapter must not synthesize identity from partial fields or from model-visible text.

## Target Host Capture Shape

Implementation should add client-local capture policy and transcript progress handling to agent hooks instead of adding a capture MCP tool.

Target hook behavior:

```text
hook runs with host-provided session/transcript context
  -> resolve canonical muninnSessionKey from host payload/transcript using the shared helper
  -> read client-local capture policy
  -> if policy denies capture, skip import
  -> read client-local transcript progress for muninnSessionKey
  -> scan transcript from the recorded sequence, byte offset, or host cursor
  -> import only new turns through existing turn capture API
  -> update client-local progress after successful import

muninn-capture +1
  -> resolve canonical muninnSessionKey from host-provided structured identity
  -> edit client-local session policy: capture.sessions[muninnSessionKey] = true
  -> next hook run imports current transcript from recorded progress or beginning if no progress exists

muninn-capture -1
  -> resolve canonical muninnSessionKey from host-provided structured identity
  -> edit client-local session policy: capture.sessions[muninnSessionKey] = false
  -> delete existing Muninn data for muninnSessionKey
  -> clear or tombstone progress.sessions[muninnSessionKey]
```

The host integration should:

- Store capture policy locally under the client host's Muninn home, using `$MUNINN_HOME/capture.json`.
- Store transcript progress locally under the client host's Muninn home, using `$MUNINN_HOME/progress.json`.
- Use the shared `CapturePolicyFile` and `CaptureProgressFile` contracts from `common`; do not redefine host-local variants.

- Treat missing `capture`, missing agent entries, missing project entries, and missing session entries as disabled. This is the target `capture.json` semantics for both server-local capture and client-hook capture.
- Reuse the shared capture policy field model for `agents` and `projects`, but do not read `$MUNINN_HOME/muninn.json` as the client hook policy.
- Store explicit `muninn-capture` decisions in `capture.sessions[muninnSessionKey]`, where `muninnSessionKey` is generated by the shared helper.
- Evaluate capture in this order: explicit disabled session, explicit enabled session, enabled client agent plus enabled client project, disabled.
- Track transcript scan progress per stable session key. The progress record should include the transcript path and the strongest available cursor, such as last turn sequence, byte offset, event index, or host-specific cursor.
- Use progress to decide whether the current transcript has already been imported and where the next scan should start.
- Update progress only after the corresponding turn capture request succeeds.
- Key policy by canonical `muninnSessionKey` derived from host-provided canonical project identity, `session_id`, and agent.
- Never infer current session identity from "latest transcript file" alone for deletion.
- Fail closed if reliable current-session identity is unavailable.
- Reuse the same server base URL and auth token resolution as existing hook capture.
- Reuse existing imported-session deletion logic through a hook-facing/internal boundary rather than coupling hooks to UI routes.

## Required Design Decisions For Implementation

### Current Session Identity

`muninn-capture` intentionally does not ask the user to type `agent`, `project`, `sessionId`, or `muninnSessionKey`. The implementation must resolve current-session identity from host runtime context. The user-facing command remains "this session", not "this project" or "session id X".

At session start, the host integration must receive or derive the fields required by the shared `muninnSessionKey` helper:

- `cwd`,
- canonical project identity resolved from `cwd`,
- normalized `sessionId`,
- `agent`.

The host integration must make structured current-session identity available to every Muninn client surface that needs current-session behavior, including hooks, the capture helper, and MCP adapter hidden request metadata. Hooks and capture helpers may immediately generate `muninnSessionKey` with the shared helper. MCP adapters should receive the structured fields, for example through per-session process environment variables, and pass them as hidden transport metadata. This must not rely on model memory or a global "current session" file.

If the capture helper or host hook cannot resolve the current session, it must log an actionable error and perform no policy write, import, progress update, capture, or deletion:

```text
Muninn could not identify the current session, so no capture change was made.
```

For Codex, the host hook can use hook payload `session_id` or `transcript_path`, then read the transcript to derive `cwd`, resolve canonical project identity from that `cwd`, and derive normalized `sessionId` and `agent`. Other hosts must provide an equivalently reliable identity source before supporting `muninn-capture`.

If a host cannot provide exact structured current-session identity to MCP, MCP must not infer it and `muninn-list` must not exclude the current session by guesswork.

### Import Selection Flow

`muninn-import` is a skill workflow, not an MCP tool or server-side import route. It should always list candidates first:

```text
muninn-import <query>
  -> MCP muninn-list({ query, top_k? })
  -> show numbered session candidates
  -> user chooses one or more numbers
  -> MCP muninn-read({ context_ids: selected session_* ids })
```

The skill must not auto-read every listed candidate. It should read only the candidates the user selects.

The externally visible rule is:

```text
import means selecting prior session context, then reading that selected context into the current conversation
```

### Session Deletion Scope

`muninn-capture -1` must delete the current session's Muninn data by canonical `muninnSessionKey` without leaving dangling references. At minimum, deletion must cover:

- turn rows for the current session,
- session snapshots derived from those turns,
- extraction rows derived only from those turns,
- observation/context rows that no longer have valid source references after the session is removed,
- session index entries and cached UI/session tree data for that session.

If a derived row references both the deleted session and other sessions, implementation must either rewrite it without the deleted references or remove it and let the pipeline rebuild it. Keeping stale references to deleted turns is not allowed.
