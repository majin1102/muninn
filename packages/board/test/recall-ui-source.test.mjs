import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('recall UI runs search before optional streaming agent recall', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /client\.searchRecall/);
  assert.match(source, /provider === 'none'/);
  assert.match(source, /client\.streamAgentRecall/);
  assert.match(source, /setAnswerText\(\(current\) => `\$\{current\}\$\{agentEvent\.text\}`\)/);
  assert.doesNotMatch(source, /BotMessageSquare/);
});

test('recall state is restored from and persisted to the hash query', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../src/components/App.tsx', import.meta.url), 'utf8');

  assert.match(appSource, /const \[path\] = value\.split\('\?'/);
  assert.match(source, /controlsFromRecallHash\(\)/);
  assert.match(source, /writeRecallHash\(controls, provider\)/);
  assert.match(source, /restoreRecallSearchRef/);
  assert.match(source, /void submit\(\)/);
  assert.match(source, /new URLSearchParams\(query/);
  assert.match(source, /params\.set\('q', controls\.query\)/);
}
);

test('recall restored search waits for provider options to be validated', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /const \[providerReady, setProviderReady\] = useState\(false\)/);
  assert.match(source, /normalizeRecallProvider\(current, providers\)/);
  assert.match(source, /normalizeRecallProvider\(current, FALLBACK_PROVIDER_OPTIONS\)/);
  assert.match(source, /setProviderReady\(true\)/);
  assert.match(source, /if \(!providerReady \|\| !restoreRecallSearchRef\.current\)/);
  assert.match(source, /\}, \[providerReady\]\)/);
});

test('recall home title uses the Muninn logo with recalls copy', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.match(source, /import muninnLogo from '\.\.\/assets\/muninn-raven-logo\.png'/);
  assert.match(source, /<img src=\{muninnLogo\} alt="Muninn" \/>/);
  assert.doesNotMatch(source, /className="search-prompt-brand">Muninn</);
  assert.match(source, />recalls everything you worked on</);
  assert.doesNotMatch(source, /Recall everything you worked on/);
  assert.match(styles, /\.search-prompt-title img/);
  assert.match(styles, /\.search-prompt-brand/);
});

test('recall API stream reader gates events after abort', async () => {
  const source = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');

  assert.match(source, /readAgentRecallStream\(response, params\.onEvent, params\.signal\)/);
  assert.match(source, /signal\?\.aborted/);
});

test('recall search request is abortable and stale responses are ignored', async () => {
  const apiSource = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  const uiSource = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');

  assert.match(apiSource, /searchRecall\(params: \{[\s\S]*signal\?: AbortSignal/);
  assert.match(apiSource, /fetchJson<SearchResponse>\(`\/api\/v1\/ui\/recall\/search\?\$\{searchParams\.toString\(\)\}`,\s*\{ signal: params\.signal \}\)/);
  assert.match(uiSource, /signal: agentAbort\.signal/);
  assert.match(uiSource, /if \(agentAbort\.signal\.aborted\) \{[\s\S]*return;[\s\S]*\}[\s\S]*setResults\(response\.results\)/);
});

test('recall answer keeps thinking visible and does not render blank done state', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /await waitForPaint\(\)/);
  assert.match(source, /status === 'done' && !text\.trim\(\)/);
  assert.match(source, /search-answer-empty/);
});

test('recall split panes use page scrolling instead of internal vertical scrollbars', async () => {
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.doesNotMatch(styles, /\.search-qa-layout \{[^}]*max-height: calc\(100vh - 132px\)/);
  assert.doesNotMatch(styles, /\.search-answer-pane \{[^}]*overflow-y: auto/);
  assert.doesNotMatch(styles, /\.search-evidence-pane \{[^}]*overflow-y: auto/);
  assert.doesNotMatch(styles, /scrollbar-color: rgba\(31, 35, 40, 0\.2\) transparent/);
});

test('recall split panes expose a draggable bounded splitter', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.match(source, /DEFAULT_SEARCH_SPLIT_RATIO = 52/);
  assert.match(source, /MIN_SEARCH_SPLIT_RATIO = 42/);
  assert.match(source, /MAX_SEARCH_SPLIT_RATIO = 62/);
  assert.match(source, /const \[splitRatio, setSplitRatio\]/);
  assert.match(source, /clampSearchSplitRatio/);
  assert.match(source, /role="separator"/);
  assert.match(source, /aria-valuenow=\{Math\.round\(splitRatio\)\}/);
  assert.match(source, /onPointerMove=\{dragSplit\}/);
  assert.match(source, /showAnswerPane \? \([\s\S]*search-qa-divider/);
  assert.match(styles, /--search-answer-ratio/);
  assert.match(styles, /cursor: col-resize/);
  assert.match(styles, /\.search-qa-divider::before/);
});

test('submitted recall layout omits the temporary mode label and aligns content column', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /submittedModeLabel/);
  assert.match(source, /search-header-row/);
  assert.doesNotMatch(styles, /\.search-header-label/);
  assert.match(styles, /\.search-page-submitted \{[\s\S]*--search-content-offset: 0px/);
  assert.match(styles, /\.search-header-row \{[\s\S]*display: block/);
  assert.match(styles, /\.search-page-submitted \.search-form \{[\s\S]*margin: 0/);
  assert.match(styles, /\.search-qa-layout \{[\s\S]*margin: 18px 0 0 var\(--search-content-offset\)/);
});

test('recall results render semantic snippets and expanded markdown boxes', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.match(source, /searchSnippet\(item\.content\)/);
  assert.match(source, /search-hit-content-box/);
  assert.match(source, /Referenced turns/);
  assert.match(styles, /\.search-hit-content h2/);
  assert.match(styles, /\.search-hit-content-box/);
  assert.doesNotMatch(styles, /\.search-hit-content \{[^}]*max-height: 90px/);
  assert.doesNotMatch(styles, /\.search-hit-content \{[^}]*white-space: pre-wrap/);
});

test('recall results use flat project session memory grouping', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.match(source, /groupResultsByProject\(results\)/);
  assert.match(source, /const key = result\.projectKey/);
  assert.match(source, /project\.cwds\.map/);
  assert.match(source, /className="search-project-cwd-trigger"/);
  assert.match(source, /\.\.\./);
  assert.match(source, /className="search-project-cwd-popover"/);
  assert.match(source, /className="search-project-cwd"/);
  assert.match(source, /memoryCountLabel\(result\.items\.length\)/);
  assert.match(source, /className="search-hit-label"/);
  assert.match(source, /searchExpandedContent\(item\.content\)/);
  assert.match(source, /formatHitDateTime\(item\.createdAt\)/);
  assert.match(styles, /\.search-project-heading h2/);
  assert.match(styles, /\.search-project-cwd-menu/);
  assert.match(styles, /\.search-project-cwd-trigger/);
  assert.match(styles, /\.search-project-cwd-popover/);
  assert.match(styles, /\.search-result-heading h3/);
  assert.match(styles, /\.search-hit-label/);
  assert.doesNotMatch(source, /Updated at \{formatHitTime/);
});

test('recall expanded content extracts only the Content section with nested headings', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /searchExpandedContent\(content: string\): string \{[\s\S]*markdownSection\(content, 'Content'\)/);
  assert.match(source, /const headingMatch = line\.trim\(\)\.match/);
  assert.match(source, /collecting && currentLevel <= sectionLevel/);
  assert.doesNotMatch(source, /if \(collecting\) \{[\s\S]*break;[\s\S]*\}[\s\S]*collecting = new RegExp/);
});

test('recall results hide item source labels and put turn references in the expanded box', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /Source: \{item\.source\}/);
  assert.match(source, /item\.references/);
  assert.equal(source.includes('#/session/${encodeURIComponent(reference)}'), true);
});

test('recall top control labels memory caps explicitly', async () => {
  const source = await readFile(new URL('../src/components/SearchPage.tsx', import.meta.url), 'utf8');

  assert.match(source, />Total memories</);
  assert.match(source, />Per session</);
  assert.doesNotMatch(source, />Global</);
});

test('demo recall search accepts scoped session filter values', async () => {
  const source = await readFile(new URL('../src/demo/provider.ts', import.meta.url), 'utf8');

  assert.match(source, /matchesDemoSessionScope\(result, sessionKeys\)/);
  assert.match(source, /const \[projectKey, _agent, rawSessionKey\] = sessionKey\.split\(SESSION_SCOPE_SEPARATOR\)/);
});
