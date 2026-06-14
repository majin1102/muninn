import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

export type DoctorCheck = { name: string; ok: boolean; detail: string };

type Probe = { ok: boolean; detail: string };

type DoctorOptions = {
  platform?: NodeJS.Platform | string;
  nodeVersion?: string;
  commandExists?: (name: string) => boolean | Promise<boolean>;
  fetchHealth?: () => Promise<Probe>;
  loadNative?: () => Promise<Probe>;
};

export async function runDoctorChecks(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const platform = options.platform ?? process.platform;
  const nodeVersion = options.nodeVersion ?? process.version;
  const commandExists = options.commandExists ?? pathCommandExists;
  const fetchHealth = options.fetchHealth ?? defaultFetchHealth;
  const loadNative = options.loadNative ?? defaultLoadNative;

  const platformOk = platform === 'darwin' || platform === 'linux';
  const nodeMajor = parseNodeMajor(nodeVersion);
  const nodeOk = nodeMajor >= 20;
  const cargoExists = await commandExists('cargo');
  const protocExists = await commandExists('protoc');
  const native = await loadNative();
  const health = await fetchHealth();

  return [
    {
      name: 'platform',
      ok: platformOk,
      detail: platformOk ? `${platform} supported` : `${platform} unsupported`,
    },
    {
      name: 'node',
      ok: nodeOk,
      detail: nodeOk ? `${nodeVersion} supported` : `${nodeVersion} unsupported; node 20+ required`,
    },
    {
      name: 'cargo',
      ok: cargoExists,
      detail: cargoExists ? 'cargo found' : 'cargo not found in PATH',
    },
    {
      name: 'protoc',
      ok: protocExists,
      detail: protocExists ? 'protoc found' : 'protoc not found in PATH',
    },
    { name: 'native addon', ...native },
    { name: 'server health', ...health },
  ];
}

export function renderDoctorChecks(checks: DoctorCheck[]): string {
  return `${checks
    .map((check) => `${check.ok ? 'ok' : 'fail'} ${check.name}: ${check.detail}`)
    .join('\n')}\n`;
}

async function pathCommandExists(name: string): Promise<boolean> {
  const searchPath = process.env.PATH ?? '';
  const dirs = searchPath.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      await access(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Keep searching PATH.
    }
  }
  return false;
}

async function defaultFetchHealth(): Promise<Probe> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch('http://127.0.0.1:8080/health', { signal: controller.signal });
    return {
      ok: response.ok,
      detail: response.ok ? 'ok' : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function defaultLoadNative(): Promise<Probe> {
  try {
    const server = await import('@muninn/server') as {
      probeNativeAddon?: unknown;
      default?: { probeNativeAddon?: unknown };
    };
    const probe = typeof server.probeNativeAddon === 'function'
      ? server.probeNativeAddon
      : server.default?.probeNativeAddon;
    if (typeof probe !== 'function') {
      return { ok: false, detail: 'probeNativeAddon export not found' };
    }
    probe();
    return { ok: true, detail: 'ok' };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseNodeMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number(match[1]) : 0;
}
