# Codex Session Start Context Design

## Summary

Muninn should inject concise project context when Codex creates a new session. The first implementation is Codex-only and runs only for the `SessionStart` event whose `source` is `startup`.

The injected context is structured JSON with three independent sections:

- the five most recent session snapshots for the current project;
- up to twenty instruction signals;
- up to ten skill signals.

Recent session signals provide the recency slice. Project dreaming signals provide the score-ranked slice. Instruction and skill budgets are independent so that one signal kind cannot crowd out the other.

The server owns project resolution, selection, ranking, deduplication, and the response schema. The Codex adapter owns the host hook protocol and injects the server response as `SessionStart.hookSpecificOutput.additionalContext`.

## Goals

- Give a newly created Codex session immediate awareness of recent work in the current project.
- Return stable `contextId` handles for recent sessions so Codex can use Muninn MCP tools for exact drill-down later.
- Preserve both recent session signals and high-score project signals.
- Keep instruction and skill budgets independent.
- Keep startup context concise and directly usable by the model.
- Keep signal provenance, ranking metadata, and storage identifiers out of model context.
- Make startup failure non-blocking.

## Non-Goals

- Do not add this hook to Claude Code, OpenClaw, or other hosts in this change.
- Do not run the hook for `resume`, `clear`, or `compact`.
- Do not refresh startup context after Codex compaction.
- Do not add semantic or query-based recall to session startup.
- Do not return full session content, signal provenance, support turns, scores, timestamps, or internal signal row ids.
- Do not change skill resolution or invocation behavior.
- Do not add a user-facing `recent` MCP tool or skill.
- Do not implement project dreaming or a second signal scoring algorithm as part of this feature.

## Replaced Contract

This design replaces only the startup `recent` response contract in `2026-06-25-muninn-mcp-user-tools-design.md`.

The route remains:

```text
POST /api/v1/startup/recent
```

The older requirement for this route to return Markdown and suggested recall queries no longer applies. The route now returns the structured JSON response defined below. The MCP and skill contracts from the older design are otherwise unchanged.

## Product Behavior

When Codex creates a new session inside a trusted project:

1. Codex invokes the Muninn `SessionStart` hook with `source: "startup"`.
2. The hook sends the event `cwd` to Muninn server.
3. The server resolves `cwd` to the canonical Muninn project.
4. The server loads the five most recent session snapshots for that project.
5. The server selects recent and score-ranked instruction and skill signals under independent budgets.
6. The server returns structured JSON.
7. The hook serializes that response with `JSON.stringify(context, null, 2)` and returns it as extra developer context.

The startup context is background information. It is not a user request and must not trigger capture, import, deletion, or any other mutation.

## Server API

### Request

```ts
type StartupRecentRequest = {
  cwd: string;
};
```

`cwd` is required and must be resolved through the same canonical project identity rules used by the rest of the server. The client does not send a database name, project override, query, budget, or ranking configuration.

### Response

```ts
type StartupRecentResponse = {
  project: string;
  recentSessions: StartupRecentSession[];
  instructionSignals: string[];
  skills: StartupRecentSkill[];
};

type StartupRecentSession = {
  contextId: string;
  title: string;
  summary: string;
};

type StartupRecentSkill = {
  name: string;
  summary: string;
};
```

Example:

```json
{
  "project": "muninn",
  "recentSessions": [
    {
      "contextId": "session:42",
      "title": "梳理 Muninn hooks",
      "summary": "核对各 agent 的 hook 能力，确认 Codex 支持 SessionStart。"
    },
    {
      "contextId": "session:41",
      "title": "恢复 Codex 项目会话",
      "summary": "排查侧边栏项目路径归属问题并恢复历史会话。"
    }
  ],
  "instructionSignals": [
    "修改公共 API 时同步更新 common contracts 和相关测试。"
  ],
  "skills": [
    {
      "name": "review-pr-loop",
      "summary": "循环检查 PR review，修复问题并处理未解决评论。"
    }
  ]
}
```

The HTTP response uses `application/json`. Empty projects return the same shape with empty arrays. The response does not include `requestId`, ranking metadata, provenance, or internal storage ids because the complete response is injected into model context.

## Recent Session Selection

The server selects recent sessions as follows:

1. Restrict candidates to the canonical current project.
2. Select the latest public `SESSION` snapshot for each distinct session.
3. Sort sessions by snapshot `updatedAt` descending.
4. Skip snapshots whose public `contextId`, title, or summary is empty.
5. Continue through older candidates until five valid sessions are selected or candidates are exhausted.

Every returned `contextId` is a public `session:*` handle. Codex may pass it unchanged to the Muninn MCP drill-down tools. The id is opaque; the agent must not parse or synthesize it.

Because the event runs only for a newly created session, there is no persisted current session to exclude.

## Signal Sources

Startup context combines two signal sources:

### Recent session signals

Recent signals come from the latest snapshots of the selected recent sessions.

Each snapshot signal already contains supporting turn labels. Its recency is the newest `createdAt` among its supporting turns. Signals are sorted by that timestamp descending. A deterministic stable key breaks ties.

The server strips evidence labels before returning a signal. Evidence labels are retrieval metadata and must never appear in startup context.

### Project signals

Project signals come from the existing project dreaming signal rows for the canonical project.

They use the existing project signal score calculation and ordering. This feature must not reproduce or modify that scoring algorithm. Score is selection metadata only and is not returned.

## Independent Budgets

Instruction and skill signals use separate budgets.

### Instruction signals

- Total limit: 20.
- Recent session quota: at most 7, ordered by signal recency.
- Project quota: fill the remaining instruction slots by project signal score.

If only three recent instruction signals exist, project instruction signals may fill the remaining seventeen slots. If fewer than twenty unique instruction signals exist across both sources, return fewer than twenty.

### Skills

- Total limit: 10.
- Recent session quota: at most 3, ordered by signal recency.
- Project quota: fill the remaining skill slots by project signal score.

If only one recent skill exists, project skills may fill the remaining nine slots. If fewer than ten unique skills exist across both sources, return fewer than ten.

Instruction capacity cannot be borrowed by skills, and skill capacity cannot be borrowed by instructions.

## Deduplication

Deduplication happens independently for instruction and skill signals.

Instruction signals are deduplicated by normalized text:

- trim leading and trailing whitespace;
- collapse internal whitespace runs;
- compare the normalized result exactly.

Skills are deduplicated by normalized skill name. When duplicate candidates exist:

1. retain a recent session candidate before a project candidate;
2. among recent candidates, retain the newest;
3. among project candidates, retain the highest score;
4. use the retained candidate's summary.

Recent session candidates are selected first. Project candidates fill only unused slots and skip content already selected from recent sessions.

## Returned Signal Content

Instruction signals are returned as their complete one-line instruction text.

Skills are returned as:

```ts
{
  name: string;
  summary: string;
}
```

The server does not return:

- evidence labels;
- supporting turn ids;
- provenance or references;
- score;
- recency timestamp;
- project dreaming row id;
- full skill detail.

Full skill detail remains outside startup context and can be loaded through the existing skill behavior when needed.

## Codex Hook Protocol

The CLI installer adds a Muninn-owned `SessionStart` matcher without removing or rewriting unrelated user hooks:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "muninn-codex-hook",
            "timeout": 10,
            "statusMessage": "Loading Muninn context"
          }
        ]
      }
    ]
  }
}
```

The installed command may use the package's resolved executable path rather than the literal command shown above. Matching and uninstall logic must identify only the Muninn-owned command entry and must preserve unrelated `SessionStart` and `Stop` hooks.

The Codex handler accepts `SessionStart` input, validates `cwd`, and ignores every source except `startup`. For `startup`, it calls the server route and emits exactly one JSON document to stdout:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "{\n  \"project\": \"muninn\",\n  \"recentSessions\": [],\n  \"instructionSignals\": [],\n  \"skills\": []\n}"
  }
}
```

The exact `additionalContext` construction is:

```ts
JSON.stringify(response, null, 2)
```

There is no Markdown wrapper, explanatory prefix, XML tag, hidden marker, or extra prompt text.

## Failure Behavior

The hook must never block session creation because startup context is unavailable.

The hook exits successfully without model context when:

- Muninn server is unavailable;
- the request times out;
- the server returns a non-success response;
- the response does not match `StartupRecentResponse`;
- canonical project resolution finds no project;
- the input source is not `startup`.

Diagnostics may go to the existing hook diagnostic channel, but successful stdout must contain only the Codex hook response. Empty valid arrays are not an error and may be injected as the valid response shape.

The hook must use a bounded request timeout and remain within the installed ten-second command timeout.

## Ownership

- `server` owns project resolution, session lookup, signal lookup, ranking, deduplication, and response validation.
- `server/src/memory` owns startup context orchestration because it combines session and project memory data.
- `common` owns the shared HTTP request and response contracts when both server and Codex adapter import them.
- `codex` owns Codex hook input normalization, server invocation, and Codex stdout formatting.
- `cli` owns idempotent install, upgrade, and uninstall of the Codex hook configuration.
- `mcp` is unchanged.

## Implementation Dependency

The current `main` branch does not yet contain the complete scored project signal implementation used by this design. Implementation should begin from `main` after the project dreaming/session-signal work lands.

This feature must consume the existing project signal view and score ordering. It must not copy the implementation from another branch, introduce a temporary score, or add compatibility behavior for older snapshot shapes.

## Test Strategy

### Server selection tests

- returns the five newest valid session snapshots with `contextId`, title, and summary;
- keeps only one latest snapshot per session;
- orders recent signals by newest supporting turn time;
- returns at most seven recent instructions and fills instructions to twenty by score;
- returns at most three recent skills and fills skills to ten by score;
- fills a recent-source shortfall from the same project signal kind;
- never borrows instruction capacity for skills or skill capacity for instructions;
- prefers recent signals during cross-source deduplication;
- strips evidence labels and all ranking/provenance metadata;
- returns deterministic ordering for ties;
- returns empty arrays for a project with no memory.

### HTTP tests

- accepts a valid `cwd` and returns `application/json`;
- rejects a missing or invalid `cwd` through the standard server error response;
- resolves aliases and nested directories to the canonical project;
- returns exactly the public startup response schema.

### Codex tests

- accepts the official `SessionStart` input shape;
- calls the server only for `source: "startup"`;
- ignores `resume`, `clear`, and `compact`;
- formats `additionalContext` with `JSON.stringify(response, null, 2)`;
- emits no extra stdout;
- exits successfully and emits no context when the server is unavailable or malformed.

### CLI configuration tests

- fresh install adds the `startup` matcher and preserves the existing Stop hook;
- repeated install is idempotent;
- upgrade replaces only an obsolete Muninn-owned entry;
- uninstall removes only Muninn-owned entries;
- unrelated user `SessionStart` and `Stop` hooks remain unchanged.

## Acceptance Criteria

- Starting a new Codex session in a project with Muninn history injects valid formatted JSON developer context.
- The JSON contains at most five recent sessions, twenty instructions, and ten skills.
- Every returned session includes a public `session:*` `contextId`, title, and summary.
- Recent instruction and skill quotas are selected by supporting-turn time, not score.
- Remaining instruction and skill slots are selected by the existing project score ordering.
- No signal provenance, score, timestamp, support turn, internal id, or full skill detail reaches model context.
- `resume`, `clear`, and `compact` do not invoke startup recall.
- Muninn failure does not prevent Codex from starting the session.
