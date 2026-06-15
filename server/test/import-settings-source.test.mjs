import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('import settings separates project and session import pickers', async () => {
  const source = await readFile(new URL('../../web/src/components/ImportSettings.tsx', import.meta.url), 'utf8');

  assert.match(source, /function ProjectImportPicker/);
  assert.match(source, /function SessionImportPicker/);
  assert.match(source, />Import projects\.\.\.</);
  assert.match(source, /placeholder="Search projects\.\.\."/);
  assert.match(source, /placeholder="Search sessions\.\.\."/);
  assert.doesNotMatch(source, /Import projects and sessions/);
  assert.doesNotMatch(source, /Import \{agentLabel\} sessions/);
});

test('project import picker uses project rows with right-side checks', async () => {
  const source = await readFile(new URL('../../web/src/components/ImportSettings.tsx', import.meta.url), 'utf8');
  const rowStart = source.indexOf('className={`import-pick import-project-pick');
  const rowEnd = source.indexOf('</div>\n                );', rowStart);
  const projectRowSource = source.slice(rowStart, rowEnd);

  assert.match(source, /className=\{`import-pick import-project-pick/);
  assert.match(source, /className="import-pick-leading-check"/);
  assert.match(source, /className="import-pick-inline-check"/);
  assert.match(source, /selectedProjects/);
  assert.match(source, /selectedAgents/);
  assert.match(source, /ProjectImportCandidate/);
  assert.match(source, /onImportProjectSelections/);
  assert.match(source, /client\.importProjects\(agent, projects\)/);
  assert.match(source, /importedProjectPaths\.has\(project\.project\)/);
  assert.match(source, /project\.captureEnabled === true/);
  assert.doesNotMatch(source, /import-pick-group-head/);
  assert.doesNotMatch(projectRowSource, /AgentLogoIcon/);
});

test('project import registers projects without importing sessions', async () => {
  const componentSource = await readFile(new URL('../../web/src/components/ImportSettings.tsx', import.meta.url), 'utf8');
  const apiSource = await readFile(new URL('../../web/src/lib/api.ts', import.meta.url), 'utf8');
  const serverSource = await readFile(new URL('../src/web/routes.ts', import.meta.url), 'utf8');
  const capturePolicySource = await readFile(new URL('../src/web/capture_policy.ts', import.meta.url), 'utf8');

  const pickerStart = componentSource.indexOf('function ProjectImportPicker');
  const pickerEnd = componentSource.indexOf('function SessionImportPicker', pickerStart);
  const pickerSource = componentSource.slice(pickerStart, pickerEnd);

  assert.match(apiSource, /importProjects\(agent: string, projects: string\[\]\): Promise<ImportProjectsResponse>/);
  assert.match(serverSource, /webRoutes\.post\('\/api\/v1\/ui\/import\/:agent\/projects'/);
  assert.match(serverSource, /importProjects\(adapter, projects, generateRequestId\(\)\)/);
  assert.match(capturePolicySource, /export async function removeCapturePolicy/);
  assert.match(pickerSource, /selectedProjectImports/);
  assert.match(pickerSource, /projectImportSelections/);
  assert.doesNotMatch(componentSource, /projectImportNotice/);
  assert.doesNotMatch(componentSource, /import-notice-row/);
  assert.doesNotMatch(pickerSource, /projectSourcePaths/);
  assert.doesNotMatch(pickerSource, /sourcePath/);
});

test('session import writes turns in batch without synchronously flushing extraction', async () => {
  const importSource = await readFile(new URL('../src/web/import_core.ts', import.meta.url), 'utf8');

  assert.match(importSource, /import \{[^}]*captureTurns[^}]*\} from '\.\.\/memory\/index\.js'/s);
  assert.match(importSource, /const turnContents: TurnContent\[\] = \[\];/);
  assert.match(importSource, /turnContents\.push\(toTurnContent/);
  assert.match(importSource, /await captureTurns\(turnContents\);/);
  assert.doesNotMatch(importSource, /addMessage/);
  assert.doesNotMatch(importSource, /import \{[^}]*observer[^}]*\} from '\.\.\/memory\/index\.js'/s);
  assert.doesNotMatch(importSource, /observer\.flushPending\(\)/);
  assert.doesNotMatch(importSource, /observer\.finalize\(\)/);
});

test('capture settings are stored in muninn json and ignore legacy policy files', async () => {
  const capturePolicySource = await readFile(new URL('../src/web/capture_policy.ts', import.meta.url), 'utf8');

  assert.match(capturePolicySource, /resolveConfigPath/);
  assert.match(capturePolicySource, /getCaptureConfigFromConfig/);
  assert.match(capturePolicySource, /capture\.projects/);
  assert.doesNotMatch(capturePolicySource, /capture-policy\.json/);
  assert.doesNotMatch(capturePolicySource, /policyPath/);
});

test('session import picker keeps current relative time formatting', async () => {
  const source = await readFile(new URL('../../web/src/components/ImportSettings.tsx', import.meta.url), 'utf8');

  assert.match(source, /className=\{`import-pick import-session-pick/);
  assert.match(source, /<AgentLogoIcon logo=\{logoForAgent\(agent\)\} variant="agent" \/>/);
  assert.match(source, /title=\{session\.promptPreview \?\? session\.title\}/);
  assert.match(source, /title=\{formatTimestamp\(session\.updatedAt\)\}/);
  assert.match(source, /\{formatRelativeTime\(session\.updatedAt\)\}/);
  assert.doesNotMatch(source, /<span className="import-tag">captured<\/span>/);
});

test('project capture uses aggregated imported projects with project-level actions and flat sessions', async () => {
  const source = await readFile(new URL('../../web/src/components/ImportSettings.tsx', import.meta.url), 'utf8');

  assert.match(source, /function useImportedProjects/);
  assert.match(source, /count <= 1 \? 'session' : 'sessions'/);
  assert.match(source, /client\.listImportedProjects\(\)/);
  assert.match(source, /function hydrateProjectCapture/);
  assert.match(source, /importedProjects=\{importedProjects\}/);
  assert.doesNotMatch(source, /function ProjectAgentSection/);
  assert.doesNotMatch(source, /function groupProjectCapture/);
  assert.doesNotMatch(source, /agent\.data\.status === 'error'/);
  assert.doesNotMatch(source, /className="import-agent-project-row"/);
  assert.match(source, /className="import-proj-actions"/);
  assert.match(source, /aria-label=\{`Import sessions from \$\{name\}`\}/);
  assert.match(source, /aria-label=\{`Delete \$\{name\}`\}/);
  assert.match(source, /onImportProject=\{setSessionPicker\}/);
  assert.match(source, /onDeleteProject=\{setDeleteTarget\}/);
  assert.match(source, /group\.sessions\.map/);
});

test('import project delete API is wired through client and server', async () => {
  const apiSource = await readFile(new URL('../../web/src/lib/api.ts', import.meta.url), 'utf8');
  const serverSource = await readFile(new URL('../src/web/routes.ts', import.meta.url), 'utf8');
  const importSource = await readFile(new URL('../src/web/import_core.ts', import.meta.url), 'utf8');
  const typeSource = await readFile(new URL('../../common/src/api.ts', import.meta.url), 'utf8');

  assert.match(typeSource, /export interface DeleteImportedProjectResponse/);
  assert.match(apiSource, /deleteImportedProject\(agent: string, project: string\): Promise<DeleteImportedProjectResponse>/);
  assert.match(apiSource, /DELETE/);
  assert.match(serverSource, /webRoutes\.delete\('\/api\/v1\/ui\/import\/:agent\/project'/);
  assert.match(serverSource, /deleteImportedProject\(adapter, body\.project, generateRequestId\(\)\)/);
  assert.match(importSource, /export async function deleteImportedProject/);
  assert.match(importSource, /sessions\.refreshIndex\(\)/);
  assert.match(importSource, /removeCapturePolicy\(adapter\.agent, project\)/);
});

test('imported project list is exposed as a single aggregated API', async () => {
  const apiSource = await readFile(new URL('../../web/src/lib/api.ts', import.meta.url), 'utf8');
  const serverSource = await readFile(new URL('../src/web/routes.ts', import.meta.url), 'utf8');
  const demoSource = await readFile(new URL('../../web/src/demo/provider.ts', import.meta.url), 'utf8');
  const typeSource = await readFile(new URL('../../common/src/api.ts', import.meta.url), 'utf8');

  assert.match(typeSource, /export interface ImportedProjectsResponse/);
  assert.match(apiSource, /listImportedProjects\(\): Promise<ImportedProjectsResponse>/);
  assert.match(apiSource, /fetchJson<ImportedProjectsResponse>\('\/api\/v1\/ui\/import\/projects'\)/);
  assert.match(serverSource, /webRoutes\.get\('\/api\/v1\/ui\/import\/projects'/);
  assert.match(serverSource, /const response: ImportedProjectsResponse/);
  assert.match(serverSource, /getCapturePolicy\(adapter\.agent\)/);
  assert.match(serverSource, /sessionCount: 0/);
  assert.match(serverSource, /captureEnabled: true/);
  assert.match(demoSource, /export async function getDemoImportedProjects/);
});

test('import session identity uses shared project agent session identity', async () => {
  const componentSource = await readFile(new URL('../../web/src/components/ImportSettings.tsx', import.meta.url), 'utf8');
  const importSource = await readFile(new URL('../src/web/import_core.ts', import.meta.url), 'utf8');
  const codexImportSource = await readFile(new URL('../src/web/codex_import.ts', import.meta.url), 'utf8');
  const identitySource = await readFile(new URL('../../common/src/session_identity.ts', import.meta.url), 'utf8');

  assert.match(identitySource, /export type SessionIdentity/);
  assert.match(identitySource, /project: string;/);
  assert.match(identitySource, /agent: string;/);
  assert.match(identitySource, /sessionId: string;/);
  assert.match(importSource, /sessionIdentityKey/);
  assert.match(importSource, /importedSessionKeys/);
  assert.doesNotMatch(importSource, /function sessionImportKey/);
  assert.doesNotMatch(importSource, /\\0\\$\\{session\.cwd\\}/);
  assert.doesNotMatch(importSource, /importedIds\.has\(session\.sessionId\)/);
  assert.doesNotMatch(importSource, /new Set\(loaded\.map\(\(session\) => session\.sessionId\)\)/);
  assert.match(componentSource, /importedSessionKeys/);
  assert.match(componentSource, /sessionIdentityKey/);
  assert.doesNotMatch(componentSource, /function sessionImportKey/);
  assert.doesNotMatch(componentSource, /importedSessionIds\.has\(session\.sessionId\)/);
  assert.match(codexImportSource, /sessionIdentityKey/);
  assert.doesNotMatch(codexImportSource, /rawSessionIds/);
});

test('local import session scan is concurrency bounded', async () => {
  const importSource = await readFile(new URL('../src/web/import_core.ts', import.meta.url), 'utf8');
  const codexImportSource = await readFile(new URL('../src/web/codex_import.ts', import.meta.url), 'utf8');
  const claudeImportSource = await readFile(new URL('../src/web/claude_import.ts', import.meta.url), 'utf8');

  assert.match(importSource, /const LOCAL_SESSION_SCAN_CONCURRENCY = \d+/);
  assert.match(importSource, /mapConcurrent\(files, LOCAL_SESSION_SCAN_CONCURRENCY/);
  assert.match(importSource, /adapter\.readSessionSummary\(file\)/);
  assert.doesNotMatch(importSource, /Promise\.all\(files\.map\(\(file\) => adapter\.readSession/);
  assert.doesNotMatch(importSource, /adapter\.readSession\(file, \{ artifactStore, artifactMode: 'preview' \}/);
  assert.match(codexImportSource, /readSessionSummary: \(sourcePath\) => readCodexSessionSummary\(sourcePath\)/);
  assert.match(claudeImportSource, /readSessionSummary: \(sourcePath\) => readClaudeSessionSummary\(sourcePath\)/);
});

test('ordinary session import does not scan existing turns for duplicate detection', async () => {
  const importSource = await readFile(new URL('../src/web/import_core.ts', import.meta.url), 'utf8');
  const codexImportSource = await readFile(new URL('../src/web/codex_import.ts', import.meta.url), 'utf8');
  const importStart = importSource.indexOf('export async function importSelectedSessions');
  const importEnd = importSource.indexOf('export async function importProjects', importStart);
  const ordinaryImportSource = importSource.slice(importStart, importEnd);

  assert.doesNotMatch(importSource, /async function existingTurnSequences/);
  assert.doesNotMatch(ordinaryImportSource, /turns\.list/);
  assert.doesNotMatch(ordinaryImportSource, /existingTurnSequences/);

  assert.match(codexImportSource, /async function listCodexImportTurns/);
  assert.match(codexImportSource, /offset \+= TURN_PAGE_SIZE/);
  assert.match(codexImportSource, /page\.length < TURN_PAGE_SIZE/);
  assert.doesNotMatch(codexImportSource, /limit: 100_000/);
});

test('project import uses project scan instead of session scan', async () => {
  const componentSource = await readFile(new URL('../../web/src/components/ImportSettings.tsx', import.meta.url), 'utf8');
  const serverSource = await readFile(new URL('../src/web/routes.ts', import.meta.url), 'utf8');
  const importSource = await readFile(new URL('../src/web/import_core.ts', import.meta.url), 'utf8');

  assert.match(serverSource, /local-projects/);
  assert.match(importSource, /export async function listLocalProjects/);
  assert.doesNotMatch(componentSource, /ProjectImportPicker[\s\S]*ensureScan/);
});

test('local session listing is project scoped and does not scan turns for imported state', async () => {
  const importSource = await readFile(new URL('../src/web/import_core.ts', import.meta.url), 'utf8');
  const serverSource = await readFile(new URL('../src/web/routes.ts', import.meta.url), 'utf8');

  assert.match(serverSource, /c\.req\.query\('project'\)/);
  assert.doesNotMatch(importSource, /async function importedSessionKeys/);
  assert.doesNotMatch(importSource, /turns\.list\(\{ mode: \{ type: 'page'/);
});

test('ordinary import does not delete existing turns before import', async () => {
  const importSource = await readFile(new URL('../src/web/import_core.ts', import.meta.url), 'utf8');
  const importStart = importSource.indexOf('export async function importSelectedSessions');
  const importEnd = importSource.indexOf('export async function importProjects', importStart);
  const ordinaryImportSource = importSource.slice(importStart, importEnd);

  assert.match(ordinaryImportSource, /session already imported/);
  assert.match(ordinaryImportSource, /firstTurnSequence/);
  assert.doesNotMatch(ordinaryImportSource, /existingTurnSequences/);
  assert.doesNotMatch(ordinaryImportSource, /deleteExistingTurns/);
});
