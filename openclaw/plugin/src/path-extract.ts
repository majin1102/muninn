export function extractDirectTargetPaths(toolName: string, params: Record<string, unknown>): string[] {
  switch (toolName) {
    case "write":
    case "edit":
    case "read":
      return collectExplicitPaths(params);
    case "apply_patch":
      return extractPathsFromPatch(params);
    case "exec":
      return extractPathsFromExec(params);
    default:
      return collectExplicitPaths(params);
  }
}

function collectExplicitPaths(params: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  for (const key of ["path", "file_path", "targetPath", "target_path"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      paths.add(value.trim());
    }
  }
  return [...paths];
}

function extractPathsFromPatch(params: Record<string, unknown>): string[] {
  const direct = collectExplicitPaths(params);
  const patch = typeof params.patch === "string"
    ? params.patch
    : typeof params.content === "string"
      ? params.content
      : "";
  const matches = [...patch.matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm)];
  for (const match of matches) {
    const filePath = match[1]?.trim();
    if (filePath) {
      direct.push(filePath);
    }
  }
  return [...new Set(direct)];
}

function extractPathsFromExec(params: Record<string, unknown>): string[] {
  const candidates = [
    params.output,
    params.stdout,
    params.stderr,
    params.result,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const paths = new Set<string>();
  for (const match of candidates.matchAll(PATH_PATTERN)) {
    const path = match[0]?.trim();
    if (looksLikeFilePath(path)) {
      paths.add(stripTrailingPunctuation(path));
    }
  }
  return [...paths];
}

const PATH_PATTERN = /(?:\.{0,2}\/)?[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+/g;

function looksLikeFilePath(value: string): boolean {
  return value.includes("/") || value.startsWith(".");
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.:;]+$/, "");
}
