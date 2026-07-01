import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CapturePolicyFile } from '@muninn/common/capture-policy';
import { isCanonicalProjectIdentity, resolveMuninnHome } from '../config.js';
export { captureTurn, captureTurns } from '../backend.js';

type CaptureState = Required<NonNullable<CapturePolicyFile['capture']>>;

function capturePolicyPath(): string {
  return path.join(resolveMuninnHome(), 'capture.json');
}

export async function getCapturePolicy(agent: string): Promise<Record<string, boolean>> {
  const capture = await readCaptureState();
  return { ...(capture.projects[agent] ?? {}) };
}

export async function isAgentCaptureEnabled(agent: string): Promise<boolean> {
  const capture = await readCaptureState();
  return capture.agents[agent] === true;
}

export async function isCaptureEnabled(agent: string, projectKey: string): Promise<boolean> {
  if (!isCanonicalProjectIdentity(projectKey)) {
    return false;
  }
  const capture = await readCaptureState();
  return capture.agents[agent] === true && capture.projects[agent]?.[projectKey] === true;
}

export async function setAgentCaptureEnabled(agent: string, enabled: boolean): Promise<void> {
  const policy = await readCapturePolicy();
  const capture = ensureCapture(policy);
  capture.agents[agent] = enabled;
  await writeCapturePolicy(policy);
}

export async function setCaptureEnabled(agent: string, projectKey: string, enabled: boolean): Promise<void> {
  if (!isCanonicalProjectIdentity(projectKey)) {
    throw new Error(`project must be a canonical project identity: ${projectKey}`);
  }
  const policy = await readCapturePolicy();
  const capture = ensureCapture(policy);
  capture.projects[agent] ??= {};
  capture.projects[agent][projectKey] = enabled;
  if (enabled && capture.agents[agent] === undefined) {
    capture.agents[agent] = true;
  }
  await writeCapturePolicy(policy);
}

export async function removeCapturePolicy(agent: string, projectKey: string): Promise<void> {
  const policy = await readCapturePolicy();
  const capture = ensureCapture(policy);
  delete capture.projects[agent]?.[projectKey];
  if (capture.projects[agent] && Object.keys(capture.projects[agent]).length === 0) {
    delete capture.projects[agent];
  }
  await writeCapturePolicy(policy);
}

async function readCaptureState(): Promise<CaptureState> {
  return ensureCapture(await readCapturePolicy());
}

async function readCapturePolicy(): Promise<CapturePolicyFile> {
  try {
    const parsed = JSON.parse(await readFile(capturePolicyPath(), 'utf8')) as CapturePolicyFile;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Missing or malformed capture.json defaults to disabled.
  }
  return {};
}

async function writeCapturePolicy(policy: CapturePolicyFile): Promise<void> {
  const file = capturePolicyPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(policy, null, 2)}\n`);
}

function ensureCapture(policy: CapturePolicyFile): CaptureState {
  policy.capture ??= {};
  policy.capture.agents ??= {};
  policy.capture.projects ??= {};
  policy.capture.sessions ??= {};
  return policy.capture as CaptureState;
}
