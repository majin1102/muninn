# Agent E2E Design

## Goal

Muninn needs repeatable E2E coverage for Codex and Claude integrations that verifies the full local workflow without polluting a user's real Muninn data.

The E2E suite must verify, for each supported agent:

- baseline session import
- recall of imported baseline facts
- hook-driven live capture
- recall of hook-captured live facts
- session deletion
- project deletion
- no live capture after the project capture policy is removed
- no recall of facts removed by session/project cleanup

The suite must support both CI-safe mock drivers and opt-in real local clients.

## Non-Goals

- Do not run real Codex or Claude Code in CI.
- Do not require user login state for the default E2E suite.
- Do not write to the user's normal Muninn home.
- Do not auto-install Codex or Claude Code unless a future explicit host command asks for it.
- Do not simulate Muninn's hook implementation by POSTing directly to `/api/v1/turn/capture`.

## Command Surface

Package-level commands are the primary entry points:

```sh
pnpm --filter @muninn/codex test:e2e
pnpm --filter @muninn/claude test:e2e
```

Root-level aliases provide short commands:

```sh
pnpm codex:e2e
pnpm claude:e2e
pnpm test:e2e
```

Host-only commands are opt-in and must not run in CI:

```sh
pnpm --filter @muninn/codex test:e2e:host
pnpm --filter @muninn/claude test:e2e:host
pnpm codex:e2e:host
pnpm claude:e2e:host
```

`test:e2e` uses mock client drivers. `test:e2e:host` uses real local clients when supported.

## Driver Matrix

| Agent | CI Driver | Host Driver | Notes |
| --- | --- | --- | --- |
| Codex | mock Codex CLI + real `muninn-codex-hook` | real Codex client + real `muninn-codex-hook` | Real host mode must verify that the selected Codex invocation path actually triggers lifecycle hooks. `codex exec` is not assumed to trigger hooks. |
| Claude | mock Claude Code CLI + real `muninn-claude-hook` | skipped until real Claude Code automation is usable | The mock driver still exercises the real Muninn Claude hook and parser. |

Mock drivers do not mock Muninn. They only replace the external agent client. Each mock driver creates realistic transcript files and sends a real Stop hook payload to the built hook binary through stdin.

## Isolation

Each E2E run creates temporary directories:

- temporary `MUNINN_HOME`
- temporary `HOME` when needed for `~/.codex` and `~/.claude/projects` fixture source roots
- temporary project directory

The temporary project should use a canonical project identity, such as a local git repository with an `origin` URL that normalizes to `github.com/muninn/e2e-fixture`. This matters because live hook capture is gated by canonical project capture policy.

The test server always points at the temporary Muninn home. Cleanup removes the temporary directories after the run. If the process exits early, the test output prints the paths so they can be inspected manually.

## E2E Round

Each agent E2E run performs the same round:

1. Build required packages.
2. Create temporary home, Muninn home, project, and transcript source tree.
3. Start a temporary Muninn server on a free local port.
4. Generate one baseline transcript session.
5. Import the baseline session through `POST /api/v1/ui/import/:agent/sessions`.
6. Verify the imported session appears in imported sessions/projects.
7. Verify baseline turns are readable from Muninn.
8. Verify baseline facts are recallable through `GET /api/v1/recall`.
9. Verify import enabled capture policy for the project.
10. Generate one live transcript session through the selected driver.
11. Trigger the real hook.
12. Wait until the live session appears in Muninn.
13. Finalize memory processing and verify the live hook fact is recallable.
14. Verify live capture fields: agent, ingest, project, session id, prompt, response, source turn sequence.
15. Delete the live session.
16. Verify the live session, its turns, and its recall hits are gone.
17. Delete the project.
18. Verify the project, sessions, turns, capture policy, and baseline recall hits are gone.
19. Trigger another hook event for the deleted project.
20. Verify no new session, turn, or recall hit is captured after project deletion.
21. Stop the server and clean temporary directories.

## Required API Changes

Existing APIs cover import, project deletion, capture policy, and live capture:

```http
POST /api/v1/ui/import/:agent/sessions
DELETE /api/v1/ui/import/:agent/project
PUT /api/v1/ui/import/:agent/capture-policy
POST /api/v1/turn/capture
```

The suite also needs a focused session deletion API because project deletion is too coarse to prove single-session cleanup:

```http
DELETE /api/v1/ui/import/:agent/session
Content-Type: application/json

{
  "project": "github.com/muninn/e2e-fixture",
  "sessionId": "e2e-codex-live-..."
}
```

Expected behavior:

- Validate known import agent.
- Require `project` and `sessionId`.
- Delete turns for that agent/project/session identity.
- Delete extraction and observation rows derived from those turns.
- Refresh the session index.
- Invalidate session tree cache.
- Return deleted session and turn counts.
- Do not remove project capture policy.

Project deletion keeps the existing behavior and removes project capture policy.

Both session and project deletion must remove recall-visible memory rows derived from deleted turns. The E2E round verifies this by querying for known fixture facts after deletion.

## Capture Disabled Assertion

After `DELETE /api/v1/ui/import/:agent/project`, the E2E run must trigger one more Stop hook for the same project.

The hook should still exit successfully because hooks are fail-soft. The server should ignore the live capture because `metadata.ingest` ends in `-hook`, the turn has a project, and the project is no longer enabled in capture policy.

The test passes only if session and turn counts do not increase and the disabled fact is not recallable.

## Logging

E2E logs should be line-oriented and readable in CI:

```text
[muninn:e2e] run=20260614-153000 agent=codex driver=mock phase=prepare status=ok home=/tmp/muninn-e2e-...
[muninn:e2e] run=20260614-153000 agent=codex driver=mock phase=import status=ok sessions=1 turns=2 project=github.com/muninn/e2e-fixture
[muninn:e2e] run=20260614-153000 agent=codex driver=mock phase=capture status=ok session=e2e-codex-live turns=1 ingest=codex-hook
[muninn:e2e] run=20260614-153000 agent=codex driver=mock phase=delete-session status=ok deletedSessions=1 deletedTurns=1
[muninn:e2e] run=20260614-153000 agent=codex driver=mock phase=delete-project status=ok deletedSessions=1 deletedTurns=2 captureEnabled=false
[muninn:e2e] run=20260614-153000 agent=codex driver=mock phase=capture-after-delete status=ok captured=0
```

Skip and failure logs must identify the failed layer:

```text
[muninn:e2e] agent=codex driver=real phase=detect status=skip reason=codex-command-not-found
[muninn:e2e] agent=codex driver=real phase=detect status=skip reason=codex-hook-mode-unsupported
[muninn:e2e] agent=claude driver=real phase=detect status=skip reason=real-claude-automation-unsupported
[muninn:e2e] agent=codex driver=mock phase=capture status=fail reason=timeout-waiting-for-session
```

## Real Codex Host Mode

Real Codex host mode is useful because it catches issues outside Muninn's fixture layer. It is intentionally not a CI requirement.

The host runner must:

- detect the real `codex` command
- create a disposable project
- point Codex hooks at the temporary Muninn server
- verify that the selected invocation path actually triggers `Stop`
- skip with a clear reason if hooks cannot be triggered non-interactively
- never rewrite the user's global Codex config unless a future explicit install command is added

The first implementation may support only the mock driver and include real Codex host mode as a documented skipped path if the current Codex CLI cannot trigger lifecycle hooks from a script.

## Implementation Shape

Add shared E2E utilities under a narrow test-support location, for example:

```text
scripts/e2e/
  agent-runner.mjs
  fixtures/codex.mjs
  fixtures/claude.mjs
  server.mjs
  assertions.mjs
```

Package-level runners stay small:

```text
codex/test/e2e/run.mjs
claude/test/e2e/run.mjs
```

The package runners pass agent-specific config into the shared runner:

- agent id
- import route key
- hook binary path
- transcript source layout
- fixture generator
- mock driver
- optional real driver

This keeps Codex and Claude behavior separate while avoiding duplicate orchestration code.

## Test Expectations

CI should run:

```sh
pnpm codex:e2e
pnpm claude:e2e
```

Host-only validation should be manual:

```sh
pnpm codex:e2e:host
pnpm claude:e2e:host
```

The E2E suite should fail if import, recall, capture, deletion, or capture-disabled assertions fail. Host mode may skip when the external real client is unavailable or unsupported.

## Open Decisions Resolved

- Baseline data is generated, not copied from local user history.
- Mock mode mocks only the external client, not Muninn hooks.
- Claude Code real mode is not required for the first implementation.
- Real Codex mode is opt-in and not part of CI.
- Session deletion is required and should be implemented as a narrow API instead of overloading project deletion.
