import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('session tree renders one top-level dreaming project with dreaming children', async () => {
  const treeSource = await readFile(new URL('../src/components/SessionTree.tsx', import.meta.url), 'utf8');
  const apiSource = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');

  assert.match(apiSource, /PROJECT_DREAMING_PROJECT_KEY = '\.dreaming'/);
  assert.match(apiSource, /PROJECT_DREAMING_SESSION_KEY = '\.dreaming'/);
  assert.match(apiSource, /listProjectDreamProjects\(\): Promise<ProjectDreamProjectView\[\]>/);
  assert.match(apiSource, /createProjectDreamingProject\(dreamProjects/);
  assert.doesNotMatch(apiSource, /sessions:\s*\[\s*createProjectDreamingSession\(project\),/);
  assert.match(treeSource, /isProjectDreamingSession\(session\)/);
  assert.match(treeSource, /isProjectDreamingProject\(project\)/);
  assert.equal(
    (treeSource.match(/<DreamingIcon className="tree-icon tree-icon-dreaming" aria-hidden="true" \/>/g) ?? []).length,
    1,
  );
  assert.match(treeSource, /isProjectDreamingProject\(project\) \? \(/);
  assert.match(treeSource, /isProjectDreamingSession\(session\)[\s\S]*?<ProjectDreamingIcon \/>/);
  assert.match(treeSource, /function ProjectDreamingIcon\(\)/);
  assert.match(treeSource, /<svg[\s\S]*?className="tree-icon"[\s\S]*?viewBox="0 0 24 24"[\s\S]*?aria-hidden="true"/);
  assert.match(treeSource, /<path[\s\S]*?strokeWidth="1\.8"/);
  assert.match(treeSource, /d="M18\.15 11\.75a3\.85 3\.85 0 0 0 4\.25 5\.88 5\.1 5\.1 0 1 1-4\.25-5\.88"/);
  assert.match(treeSource, /strokeWidth="1\.45"/);
  assert.doesNotMatch(treeSource, /tree-icon-project-dreaming-folder/);
  assert.doesNotMatch(treeSource, /tree-icon-project-dreaming-moon/);
  assert.doesNotMatch(treeSource, /tree-icon-project-dreaming-star/);
  assert.match(treeSource, /sortProjectsWithDreamingFirst/);
  assert.match(treeSource, /isProjectDreamingProject\(left\) \? -1/);
  assert.match(treeSource, /project\.sessions\.filter\(\(session\) => !isProjectDreamingSession\(session\)\)/);
  assert.doesNotMatch(treeSource, /const dreamingSessions = project\.sessions\.filter\(isProjectDreamingSession\)/);

  const cssSource = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(cssSource, /\.tree-trigger-main > span:not\(\.agent-logo-cluster\):not\(\.agent-logo-frame\):not\(\.tree-session-agent-icon\)/);
  assert.match(cssSource, /\.tree-icon \{[\s\S]*?width: 1\.15em;[\s\S]*?height: 1\.15em;/);
  assert.doesNotMatch(cssSource, /\.tree-icon-project-dreaming \{/);
  assert.doesNotMatch(cssSource, /\.tree-icon-project-dreaming[^}]*background:/);
  assert.doesNotMatch(cssSource, /\.tree-icon-project-dreaming-folder/);
  assert.doesNotMatch(cssSource, /\.tree-icon-project-dreaming-moon/);
});

test('project agent icons ignore synthetic dreaming sessions', async () => {
  const treeSource = await readFile(new URL('../src/components/SessionTree.tsx', import.meta.url), 'utf8');
  const projectAgents = treeSource.match(/function projectAgents\(project: ProjectNode\): AgentLogo\[\] \{[\s\S]*?\n\}/)?.[0] ?? '';

  assert.match(projectAgents, /isProjectDreamingSession\(session\)/);
  assert.match(projectAgents, /continue;/);
});

test('app opens dreaming content without loading session turns', async () => {
  const appSource = await readFile(new URL('../src/components/App.tsx', import.meta.url), 'utf8');
  const apiSource = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const contentSource = await readFile(new URL('../src/components/DreamingContent.tsx', import.meta.url), 'utf8');

  assert.match(appSource, /isProjectDreamingSession\(session\)/);
  assert.match(appSource, /client\.getProjectDream\(session\.projectKey\)/);
  assert.match(appSource, /error: null,\s*loading: true/);
  assert.match(appSource, /const message = asErrorMessage\(error\)/);
  assert.match(appSource, /error: message/);
  assert.match(apiSource, /listProjectDreamProjects\(\)/);
  assert.match(appSource, /<DreamingContent/);
  assert.match(appSource, /error=\{projectDreams\[activeSession\.projectKey\]\?\.error \?\? null\}/);
  assert.match(appSource, /onRetry=\{\(\) => openProjectDream\(activeSession\)\}/);
  assert.match(appSource, /return;/);
  assert.match(appSource, /const currentDream = projectDreams\[session\.projectKey\]/);
  assert.match(appSource, /if \(!currentDream\?\.loading && !currentDream\?\.dream && !currentDream\?\.error\)/);
  assert.match(contentSource, /Memories/);
  assert.match(contentSource, /Skills/);
  assert.match(contentSource, /error: string \| null;/);
  assert.match(contentSource, /onRetry: \(\) => void;/);
  assert.match(contentSource, /dreaming-error-panel/);
  assert.match(contentSource, /Failed to load project dreaming/);
  assert.match(contentSource, /Retry/);
  assert.match(contentSource, /loading && !dream \? null/);
  assert.doesNotMatch(contentSource, />Memory Signals</);
  assert.doesNotMatch(contentSource, /Open Questions/);
  assert.doesNotMatch(contentSource, /Latest dream/);
  assert.doesNotMatch(contentSource, /snapshot version/i);
});

test('dreaming content follows Muninn Web typography and tab standards', async () => {
  const contentSource = await readFile(new URL('../src/components/DreamingContent.tsx', import.meta.url), 'utf8');
  const cssSource = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.match(contentSource, /<div className="dreaming-content" aria-label=\{projectLabel\}>/);
  assert.match(cssSource, /\.dreaming-header/);
  assert.match(cssSource, /\.dreaming-error-panel/);
  assert.match(cssSource, /\.dreaming-error-action/);
  assert.doesNotMatch(contentSource, /dreaming-title/);
  assert.doesNotMatch(cssSource, /\.dreaming-title/);
  assert.match(cssSource, /\.dreaming-header\s*\{[^}]*border-bottom: 1px solid #ececec;/s);
  assert.match(cssSource, /\.dreaming-tabs/);
  assert.match(cssSource, /\.dreaming-tab-active \{\s*background: #f0f0f0;\s*color: #1a1c1f;\s*font-weight: 600;/);
  assert.match(cssSource, /\.dreaming-table \{\s*width: 100%;\s*min-width: 680px;\s*border-collapse: separate;/);
  assert.doesNotMatch(cssSource, /\.dreaming-table th:first-child,\s*\.dreaming-table td:first-child\s*\{[^}]*border-right:/s);
  assert.match(cssSource, /\.dreaming-skill-row-active \{\s*background: #f0f0f0;\s*color: #1a1c1f;/);
  assert.doesNotMatch(cssSource, /\.dreaming-tab-active::after/);
  assert.doesNotMatch(cssSource, /\.dreaming-[^{]+{[^}]*font-size: (18|20|22|24|28)px;/s);
  assert.doesNotMatch(cssSource, /\.dreaming-[^{]+{[^}]*font-weight: (700|750);/s);
  assert.doesNotMatch(cssSource, /\.dreaming-[^{]+{[^}]*#0a7cff/s);
  assert.doesNotMatch(cssSource, /\.dreaming-[^{]+{[^}]*#0068e5/s);
});

test('dreaming memories render signal before score without section title or vertical divider', async () => {
  const contentSource = await readFile(new URL('../src/components/DreamingContent.tsx', import.meta.url), 'utf8');
  const cssSource = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.doesNotMatch(contentSource, /<SignalTable title=/);
  assert.doesNotMatch(contentSource, /<h2>\{title\}<\/h2>/);
  assert.match(
    contentSource,
    /<colgroup>\s*<col className="dreaming-expand-col" \/>\s*<col className="dreaming-signal-col" \/>\s*<col className="dreaming-score-col" \/>\s*<col className="dreaming-time-col" \/>\s*<\/colgroup>/,
  );
  assert.match(
    contentSource,
    /<th className="dreaming-expand-column" aria-label="Expand evidence" \/>\s*<th>Signal<\/th>\s*<th className="dreaming-score-column">Score<\/th>\s*<th className="dreaming-time-column">Time<\/th>/,
  );
  assert.match(
    contentSource,
    /<td className="dreaming-signal-cell">\{row\.text\}<\/td>\s*<td className="dreaming-score-cell">\{formatSignalScore\(row\.score\)\}<\/td>\s*<td className="dreaming-time-cell">/,
  );
  assert.match(contentSource, /dreaming-memory-signal-toggle/);
  assert.match(contentSource, /<ChevronRight className="tree-chevron" aria-hidden="true" \/>/);
  assert.match(contentSource, /row\.supportTurns\.map\(\(support\) =>/);
  assert.match(contentSource, /<ClampedSupportContent text=\{support\.content \?\? 'Turn content unavailable'\} \/>/);
  assert.match(contentSource, /formatSignalScore\(support\.score\)/);
  assert.match(contentSource, /<Timestamp value=\{support\.createdAt\} \/>/);
  assert.doesNotMatch(contentSource, /dreaming-support-turn-id/);
  assert.doesNotMatch(contentSource, /dreaming-support-contribution/);
  assert.doesNotMatch(contentSource, /\+{support\.contribution}/);
  assert.match(contentSource, /\{formatRelativeTime\(value\)\}/);
  assert.match(contentSource, /title=\{formatTimestamp\(value\)\}/);
  const dreamingTableCss = cssSource.match(/\.dreaming-table \{[\s\S]*?\.dreaming-skills \{/)?.[0] ?? '';
  assert.doesNotMatch(dreamingTableCss, /border-right:/);
  assert.match(cssSource, /\.dreaming-section \{[\s\S]*?overflow-x: auto;/);
  assert.match(dreamingTableCss, /\.dreaming-table \{[\s\S]*?min-width: 680px;/);
  assert.match(dreamingTableCss, /\.dreaming-signal-col \{[\s\S]*?width: auto;/);
  assert.match(dreamingTableCss, /\.dreaming-score-col \{[\s\S]*?width: 104px;/);
  assert.match(dreamingTableCss, /\.dreaming-time-col \{[\s\S]*?width: 96px;/);
  assert.match(dreamingTableCss, /\.dreaming-score-column,\s*\.dreaming-score-cell \{[\s\S]*?text-align: left;/);
  assert.match(dreamingTableCss, /\.dreaming-time-column,\s*\.dreaming-time-cell \{[\s\S]*?text-align: left;/);
  assert.doesNotMatch(dreamingTableCss, /width: 176px;/);
  assert.doesNotMatch(dreamingTableCss, /width: 72px;/);
  assert.match(dreamingTableCss, /\.dreaming-signal-cell \{[\s\S]*?overflow-wrap: break-word;[\s\S]*?word-break: normal;/);
  assert.doesNotMatch(dreamingTableCss, /\.dreaming-signal-cell \{[^}]*overflow-wrap: anywhere;/);
  assert.match(dreamingTableCss, /\.dreaming-time-cell \{[^}]*color: #1a1c1f;/);
  assert.doesNotMatch(dreamingTableCss, /\.dreaming-time-cell \{[^}]*#8f9195/);
  assert.match(dreamingTableCss, /\.dreaming-table,\s*\.dreaming-table button,\s*\.dreaming-table time \{[\s\S]*?font-family: inherit;[\s\S]*?font-size: 13px;[\s\S]*?letter-spacing: 0;/);
  assert.match(dreamingTableCss, /\.dreaming-table \{[\s\S]*?border: 1px solid #ececec;[\s\S]*?line-height: 1\.55;/);
  assert.match(dreamingTableCss, /\.dreaming-table td \{[\s\S]*?font-weight: 400;/);
  assert.match(cssSource, /\.dreaming-memories \{[\s\S]*?padding: 24px 28px 40px;/);
  assert.match(dreamingTableCss, /\.dreaming-table th \{[\s\S]*?height: 46px;[\s\S]*?padding: 0 16px;/);
  assert.match(dreamingTableCss, /\.dreaming-table td \{[\s\S]*?padding: 14px 16px;[\s\S]*?line-height: 1\.55;[\s\S]*?vertical-align: top;/);
  assert.match(dreamingTableCss, /\.dreaming-expand-col \{[\s\S]*?width: 44px;/);
  assert.match(dreamingTableCss, /\.dreaming-table \.dreaming-expand-column,\s*\.dreaming-table \.dreaming-expand-cell \{[\s\S]*?width: 44px;[\s\S]*?padding: 0 10px 0 18px;[\s\S]*?vertical-align: middle;/);
  assert.match(dreamingTableCss, /\.dreaming-table \.dreaming-expand-column \+ th,\s*\.dreaming-table \.dreaming-signal-cell \{[\s\S]*?padding-left: 0;/);
  assert.match(dreamingTableCss, /\.dreaming-memory-signal-toggle \{[\s\S]*?width: 16px;[\s\S]*?height: 16px;[\s\S]*?background: transparent;[\s\S]*?color: #8f9195;/);
  assert.doesNotMatch(dreamingTableCss, /\.dreaming-memory-signal-toggle,\s*\.dreaming-memory-signal-toggle-placeholder \{[\s\S]*?position: absolute;/);
  assert.doesNotMatch(dreamingTableCss, /\.dreaming-memory-signal-toggle:hover/);
  assert.doesNotMatch(dreamingTableCss, /translateY\(-50%\)/);
  assert.match(dreamingTableCss, /\.dreaming-memory-signal-toggle\[aria-expanded="true"\] \.tree-chevron \{[\s\S]*?transform: rotate\(90deg\);/);
  assert.match(dreamingTableCss, /\.dreaming-support-row td \{[\s\S]*?padding-top: 10px;[\s\S]*?padding-bottom: 10px;/);
  assert.match(dreamingTableCss, /\.dreaming-support-content \{[\s\S]*?display: -webkit-box;[\s\S]*?padding-right: 3ch;[\s\S]*?-webkit-line-clamp: 2;/);
  assert.match(contentSource, /title=\{overflowing \? text : undefined\}/);
});

test('dreaming skills use inline weights and h2 detail sections', async () => {
  const contentSource = await readFile(new URL('../src/components/DreamingContent.tsx', import.meta.url), 'utf8');
  const cssSource = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.doesNotMatch(contentSource, /dreaming-skill-list-title/);
  assert.doesNotMatch(contentSource, />Skill Signals</);
  assert.match(contentSource, /<span className="dreaming-skill-heading">/);
  assert.match(contentSource, /<span className="dreaming-skill-name">\{skill\.name\}<\/span>\s*<span className="dreaming-skill-weight">\{formatSignalScore\(skill\.score\)\}<\/span>/);
  assert.match(contentSource, /<ClampedSkillSummary text=\{skill\.summary\} \/>/);
  assert.match(contentSource, /title=\{overflowing \? text : undefined\}/);
  assert.match(cssSource, /-webkit-line-clamp: 3;/);
  assert.match(cssSource, /padding-right: 3ch;/);
  assert.match(contentSource, /<h2>\s*<span>\{selectedSkill\.name\}<\/span>\s*<span className="dreaming-skill-weight">\{formatSignalScore\(selectedSkill\.score\)\}<\/span>\s*<\/h2>/);
  assert.match(contentSource, /h4: \(\{ children \}\) => <SkillDetailHeading>\{children\}<\/SkillDetailHeading>/);
  assert.match(contentSource, /<h2 className="dreaming-skill-section-heading">/);
  assert.doesNotMatch(contentSource, /<h3 className="dreaming-skill-section-heading">/);
});
