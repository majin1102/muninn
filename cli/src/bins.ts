import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { ResolvedCommand } from './model.js';

export function resolveCommand(name: string, options: {
  preferAbsolute?: boolean;
  envPath?: string;
  extraBinDirs?: string[];
  access?: (candidate: string) => boolean;
} = {}): ResolvedCommand {
  const envPath = options.envPath ?? process.env.PATH ?? '';
  const access = options.access ?? canExecute;
  const resolvedPath = findExecutable(name, {
    envPath,
    extraBinDirs: options.extraBinDirs ?? [],
    access,
  });
  if (!resolvedPath) {
    return {
      command: name,
      resolvedPath: null,
      isAbsolute: false,
    };
  }
  if (options.preferAbsolute) {
    return {
      command: resolvedPath,
      resolvedPath,
      isAbsolute: true,
    };
  }
  return {
    command: name,
    resolvedPath,
    isAbsolute: false,
  };
}

export function renderCommand(command: string): string {
  if (/[\s"']/u.test(command)) {
    return JSON.stringify(command);
  }
  return command;
}

function findExecutable(name: string, options: {
  envPath: string;
  extraBinDirs: string[];
  access: (candidate: string) => boolean;
}): string | null {
  if (path.isAbsolute(name)) {
    return options.access(name) ? name : null;
  }
  for (const segment of [
    ...options.extraBinDirs,
    ...options.envPath.split(path.delimiter),
  ]) {
    if (!segment) {
      continue;
    }
    const candidate = path.join(segment, name);
    if (options.access(candidate)) {
      return candidate;
    }
  }
  return null;
}

function canExecute(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
