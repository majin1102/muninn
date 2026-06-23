import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('timeline pane keeps extraction items collapsible like the old observation pane', async () => {
  const source = await readFile(new URL('../src/components/TimelinePane.tsx', import.meta.url), 'utf8');

  assert.match(source, /import \{ ChevronRight, MessageSquare \} from 'lucide-react';/);
  assert.match(source, /import \{ Collapsible, CollapsibleContent, CollapsibleTrigger \} from '\.\/ui\/collapsible\.js';/);
  assert.match(source, /const \[openItem, setOpenItem\] = useState<string \| null>\(null\);/);
  assert.match(source, /setOpenItem\(restoreTimelineId\);/);
  assert.match(source, /<Collapsible\s+open=\{open\}/);
  assert.match(source, /<CollapsibleTrigger className="timeline-trigger">/);
  assert.match(source, /<CollapsibleContent>/);
  assert.match(source, /onActiveTimelineChange\(item\.memoryId\)/);
});

test('timeline pane keeps extraction row spacing aligned with main observation styles', async () => {
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.match(styles, /\.timeline-list\s*\{\s*display: grid;\s*gap: 6px;\s*\}/);
  assert.match(styles, /\.timeline-item\s*\{\s*min-width: 0;\s*border-radius: 8px;\s*\}/);
  assert.match(styles, /\.timeline-item-active > \.ui-collapsible > \.timeline-trigger\s*\{\s*background: #f1f2f4;\s*color: #20242a;\s*\}/);
  assert.doesNotMatch(styles, /\.timeline-list\s*\{\s*display: grid;\s*gap: 10px;\s*\}/);
  assert.doesNotMatch(styles, /\.timeline-item\s*\{[^}]*padding: 8px 6px 10px;/s);
  assert.doesNotMatch(styles, /\.timeline-item-active\s*\{\s*background: #f5f6f8;/);
});

test('session loading state suppresses timeline empty state while turns load', async () => {
  const appSource = await readFile(new URL('../src/components/App.tsx', import.meta.url), 'utf8');
  const splitSource = await readFile(new URL('../src/components/SessionContentSplit.tsx', import.meta.url), 'utf8');
  const timelineSource = await readFile(new URL('../src/components/TimelinePane.tsx', import.meta.url), 'utf8');

  assert.match(appSource, /const timelinePromise = loadSessionTimeline\(session\);[\s\S]*const response = await client\.loadSessionTurns\(session\);/);
  assert.match(
    appSource,
    /loading=\{documentLoading \|\| locatingActiveTurn \|\| Boolean\(activeSession\?\.loading && !activeSession\.loaded\)\}/,
  );
  assert.match(appSource, /timelineLoading=\{Boolean\(activeSession\?\.timelineLoading && !activeSession\.timelineLoaded\)\}/);
  assert.match(splitSource, /<TimelinePane[\s\S]*loading=\{timelineLoading\}/);
  assert.match(timelineSource, /loading: boolean;/);
  assert.match(timelineSource, /const showLoading = useDelayedBoolean\(loading, 150\);/);
  assert.match(timelineSource, /export function TimelinePane\(\{[\s\S]*\bloading,[\s\S]*\}: TimelinePaneProps\)/);
  assert.match(
    timelineSource,
    /showLoading \? \(\s*<EmptyState className="timeline-loading-panel" icon=\{MessageSquare\} title="loading timeline\.\.\." \/>\s*\) : loading \? \(\s*null\s*\) : timeline\.length === 0 \? \(/,
  );
});
