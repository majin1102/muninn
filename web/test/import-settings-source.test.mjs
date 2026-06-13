import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('import settings separates project and session import pickers', async () => {
  const source = await readFile(new URL('../src/components/ImportSettings.tsx', import.meta.url), 'utf8');

  assert.match(source, /function ProjectImportPicker/);
  assert.match(source, /function SessionImportPicker/);
  assert.match(source, />Import projects\.\.\.</);
  assert.match(source, /placeholder="Search projects\.\.\."/);
  assert.match(source, /placeholder="Search sessions\.\.\."/);
  assert.doesNotMatch(source, /Import projects and sessions/);
  assert.doesNotMatch(source, /Import \{agentLabel\} sessions/);
});

test('project import picker uses project rows with right-side checks', async () => {
  const source = await readFile(new URL('../src/components/ImportSettings.tsx', import.meta.url), 'utf8');
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
  const componentSource = await readFile(new URL('../src/components/ImportSettings.tsx', import.meta.url), 'utf8');
  const apiSource = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');

  const pickerStart = componentSource.indexOf('function ProjectImportPicker');
  const pickerEnd = componentSource.indexOf('function SessionImportPicker', pickerStart);
  const pickerSource = componentSource.slice(pickerStart, pickerEnd);

  assert.match(apiSource, /importProjects\(agent: string, projects: string\[\]\): Promise<ImportProjectsResponse>/);
  assert.match(pickerSource, /selectedProjectImports/);
  assert.match(pickerSource, /projectImportSelections/);
  assert.doesNotMatch(componentSource, /projectImportNotice/);
  assert.doesNotMatch(componentSource, /import-notice-row/);
  assert.doesNotMatch(pickerSource, /projectSourcePaths/);
  assert.doesNotMatch(pickerSource, /sourcePath/);
});

test('session import picker keeps current relative time formatting', async () => {
  const source = await readFile(new URL('../src/components/ImportSettings.tsx', import.meta.url), 'utf8');

  assert.match(source, /className=\{`import-pick import-session-pick/);
  assert.match(source, /<AgentLogoIcon logo=\{logoForAgent\(agent\)\} variant="agent" \/>/);
  assert.match(source, /title=\{session\.promptPreview \?\? session\.title\}/);
  assert.match(source, /title=\{formatTimestamp\(session\.updatedAt\)\}/);
  assert.match(source, /\{formatRelativeTime\(session\.updatedAt\)\}/);
  assert.doesNotMatch(source, /<span className="import-tag">captured<\/span>/);
});

test('project capture uses aggregated imported projects with project-level actions and flat sessions', async () => {
  const source = await readFile(new URL('../src/components/ImportSettings.tsx', import.meta.url), 'utf8');

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
  const apiSource = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const typeSource = await readFile(new URL('../../common/src/api.ts', import.meta.url), 'utf8');

  assert.match(typeSource, /export interface DeleteImportedProjectResponse/);
  assert.match(apiSource, /deleteImportedProject\(agent: string, project: string\): Promise<DeleteImportedProjectResponse>/);
  assert.match(apiSource, /DELETE/);
});

test('imported project list is exposed as a single aggregated API', async () => {
  const apiSource = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const demoSource = await readFile(new URL('../src/demo/provider.ts', import.meta.url), 'utf8');
  const typeSource = await readFile(new URL('../../common/src/api.ts', import.meta.url), 'utf8');

  assert.match(typeSource, /export interface ImportedProjectsResponse/);
  assert.match(apiSource, /listImportedProjects\(\): Promise<ImportedProjectsResponse>/);
  assert.match(apiSource, /fetchJson<ImportedProjectsResponse>\('\/api\/v1\/ui\/import\/projects'\)/);
  assert.match(demoSource, /export async function getDemoImportedProjects/);
});

test('import session identity uses shared project agent session identity', async () => {
  const componentSource = await readFile(new URL('../src/components/ImportSettings.tsx', import.meta.url), 'utf8');
  const identitySource = await readFile(new URL('../../common/src/session_identity.ts', import.meta.url), 'utf8');

  assert.match(identitySource, /export type SessionIdentity/);
  assert.match(identitySource, /project: string;/);
  assert.match(identitySource, /agent: string;/);
  assert.match(identitySource, /sessionId: string;/);
  assert.match(componentSource, /importedSessionKeys/);
  assert.match(componentSource, /sessionIdentityKey/);
  assert.doesNotMatch(componentSource, /function sessionImportKey/);
  assert.doesNotMatch(componentSource, /importedSessionIds\.has\(session\.sessionId\)/);
});

test('project import uses project scan instead of session scan', async () => {
  const componentSource = await readFile(new URL('../src/components/ImportSettings.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(componentSource, /ProjectImportPicker[\s\S]*ensureScan/);
});
