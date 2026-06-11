import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Per-agent, per-project capture allowlist. A project is auto-captured by the
 * live hook only when explicitly enabled here (default off). Stored as a small
 * JSON file under MUNINN_HOME; the board reads/writes it and the sidecar capture
 * endpoint consults it (same process). Manual imports bypass this entirely.
 */
type PolicyFile = Record<string, Record<string, boolean>>;

function policyPath(): string {
  const home = process.env.MUNINN_HOME ?? path.join(os.homedir(), '.muninn');
  return path.join(home, 'capture-policy.json');
}

async function readPolicy(): Promise<PolicyFile> {
  try {
    const parsed = JSON.parse(await readFile(policyPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as PolicyFile : {};
  } catch {
    return {};
  }
}

async function writePolicy(policy: PolicyFile): Promise<void> {
  const file = policyPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(policy, null, 2));
}

export async function getCapturePolicy(agent: string): Promise<Record<string, boolean>> {
  return (await readPolicy())[agent] ?? {};
}

export async function isCaptureEnabled(agent: string, projectKey: string): Promise<boolean> {
  return (await readPolicy())[agent]?.[projectKey] === true;
}

export async function setCaptureEnabled(agent: string, projectKey: string, enabled: boolean): Promise<void> {
  const policy = await readPolicy();
  const forAgent = policy[agent] ?? {};
  forAgent[projectKey] = enabled;
  policy[agent] = forAgent;
  await writePolicy(policy);
}
