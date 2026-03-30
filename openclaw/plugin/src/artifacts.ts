import { readFile } from "node:fs/promises";
import path from "node:path";

import type { LoggerLike } from "./logger.js";
import { logWarn } from "./logger.js";
import { extractDirectTargetPaths } from "./path-extract.js";

export async function collectArtifacts(params: {
  toolName: string;
  toolParams: Record<string, unknown>;
  workspaceDir?: string;
  logger: LoggerLike;
}): Promise<Record<string, string> | undefined> {
  if (params.toolName === "write") {
    const targetPath = extractDirectTargetPaths(params.toolName, params.toolParams)[0];
    const content = typeof params.toolParams.content === "string"
      ? params.toolParams.content
      : undefined;
    if (targetPath && content?.trim()) {
      return { [targetPath]: content };
    }
    return undefined;
  }

  const targetPaths = extractDirectTargetPaths(params.toolName, params.toolParams);
  if (targetPaths.length === 0) {
    return undefined;
  }

  const artifacts: Record<string, string> = {};
  for (const targetPath of targetPaths) {
    const content = await readArtifactFile(targetPath, params.workspaceDir, params.logger);
    if (content !== undefined) {
      artifacts[targetPath] = content;
    }
  }

  return Object.keys(artifacts).length > 0 ? artifacts : undefined;
}

async function readArtifactFile(
  targetPath: string,
  workspaceDir: string | undefined,
  logger: LoggerLike,
): Promise<string | undefined> {
  const resolvedPath = path.isAbsolute(targetPath)
    ? targetPath
    : workspaceDir
      ? path.resolve(workspaceDir, targetPath)
      : path.resolve(targetPath);

  try {
    const content = await readFile(resolvedPath, "utf8");
    return content.trim() ? content : undefined;
  } catch (error) {
    logWarn(logger, `artifact read failed for ${targetPath}`, error);
    return undefined;
  }
}
