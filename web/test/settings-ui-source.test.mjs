import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('settings visual mode groups extractor under pipeline tabs', async () => {
  const source = await readFile(new URL('../src/components/SettingsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /type PipelineSettingsTab = 'extractor'/);
  assert.match(source, /const \[pipelineTab, setPipelineTab\] = useState<PipelineSettingsTab>\(\(\) => initialSettingsHashState\(\)\.pipelineTab\)/);
  assert.match(source, /<SettingsSection[\s\S]*title="Pipelines"[\s\S]*unframed[\s\S]*<PipelineTabs tab=\{pipelineTab\} onSelect=\{selectPipelineTab\} \/>[\s\S]*<PipelineSettings draft=\{draft\} tab=\{pipelineTab\} \/>/);
  assert.doesNotMatch(source, /<SettingsSection title="Extractor">/);
  assert.match(source, /function PipelineTabs/);
  assert.match(source, />\s*Extractor\s*</);
  assert.match(source, /settings-provider-capability-tabs/);
  assert.match(source, /settings-provider-capability-tab-active/);
});

test('settings tabs are restored from and persisted to the hash query', async () => {
  const source = await readFile(new URL('../src/components/SettingsPage.tsx', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../src/components/App.tsx', import.meta.url), 'utf8');

  assert.match(appSource, /const \[path\] = value\.split\('\?'/);
  assert.match(source, /initialSettingsHashState\(\)/);
  assert.match(source, /rawMode === 'visual' \|\| rawMode === 'json' \|\| rawMode === 'import' \? rawMode : 'import'/);
  assert.match(source, /writeSettingsHash\(\{ mode: nextMode \}\)/);
  assert.match(source, /writeSettingsHash\(\{ providerCapability: capability \}\)/);
  assert.match(source, /writeSettingsHash\(\{ pipelineTab: tab \}\)/);
  assert.match(source, /new URLSearchParams\(query/);
  assert.match(source, /params\.set\('pipeline', state\.pipelineTab\)/);
});

test('settings pipeline tabs keep extractor fields with stable paths', async () => {
  const source = await readFile(new URL('../src/components/SettingsPage.tsx', import.meta.url), 'utf8');

  assert.match(source, /description="extractor\.name" path=\{\['extractor', 'name'\]\}/);
  assert.match(source, /description="extractor\.llmProvider" path=\{\['extractor', 'llmProvider'\]\}/);
  assert.match(source, /description="extractor\.embeddingProvider" path=\{\['extractor', 'embeddingProvider'\]\}/);
  assert.match(source, /description="extractor\.recallMode" path=\{\['extractor', 'recallMode'\]\}/);
  assert.match(source, /description="extractor\.maxAttempts" path=\{\['extractor', 'maxAttempts'\]\}/);
  assert.match(source, /description="extractor\.activeWindowDays" path=\{\['extractor', 'activeWindowDays'\]\}/);
});
