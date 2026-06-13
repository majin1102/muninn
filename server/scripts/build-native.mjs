import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const manifestPath = path.join(packageDir, 'native', 'Cargo.toml');
const nativeDir = path.join(packageDir, 'native');
const profile = process.env.MUNINN_NATIVE_PROFILE === 'debug' ? 'debug' : 'release';

try {
  execFileSync(
    'cargo',
    ['build', '--manifest-path', manifestPath, ...(profile === 'release' ? ['--release'] : [])],
    {
      cwd: packageDir,
      env: {
        ...process.env,
        ...(resolveProtocPath() ? { PROTOC: resolveProtocPath() } : {}),
      },
      stdio: 'inherit',
    },
  );
} catch (error) {
  throw new Error(buildFailureMessage(error));
}

const targetName = resolveTargetLibraryName();
const builtLibrary = path.join(nativeDir, 'target', profile, targetName);
const outputPath = path.join(nativeDir, 'muninn_native.node');

if (!existsSync(builtLibrary)) {
  throw new Error(
    `native build completed without producing ${targetName}; expected it at ${builtLibrary}`,
  );
}

mkdirSync(nativeDir, { recursive: true });
copyFileSync(builtLibrary, outputPath);
codesignIfNeeded(outputPath);

function resolveTargetLibraryName() {
  switch (os.platform()) {
    case 'darwin':
      return 'libmuninn_native.dylib';
    case 'linux':
      return 'libmuninn_native.so';
    case 'win32':
      return 'muninn_native.dll';
    default:
      throw new Error(`unsupported platform for native binding build: ${os.platform()}`);
  }
}

function resolveProtocPath() {
  if (process.env.PROTOC) {
    return process.env.PROTOC;
  }
  const homebrewProtoc = '/opt/homebrew/bin/protoc';
  return existsSync(homebrewProtoc) ? homebrewProtoc : undefined;
}

function buildFailureMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'failed to build the Muninn native addon.',
    'Make sure Rust, cargo, and protoc are installed and available in PATH.',
    'If Node was upgraded recently, rebuild the addon so the .node binary matches the current ABI.',
    `cargo error: ${message}`,
  ].join(' ');
}

function codesignIfNeeded(filePath) {
  if (os.platform() !== 'darwin') {
    return;
  }
  execFileSync('codesign', ['--force', '--sign', '-', filePath], {
    cwd: packageDir,
    stdio: 'inherit',
  });
}
