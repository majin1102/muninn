export function projectDisplayLabel(project: string): string {
  const githubLabel = githubProjectLabel(project);
  if (githubLabel) {
    return githubLabel;
  }
  const segments = projectSegments(project);
  return segments.at(-1) ?? (project || '/');
}

export function projectDisplayLabels(projects: string[]): Map<string, string> {
  const uniqueProjects = [...new Set(projects)];
  const byBase = new Map<string, string[]>();

  for (const project of uniqueProjects) {
    const base = projectDisplayLabel(project);
    byBase.set(base, [...(byBase.get(base) ?? []), project]);
  }

  const labels = new Map<string, string>();
  for (const [base, sameBaseProjects] of byBase) {
    if (sameBaseProjects.length === 1) {
      labels.set(sameBaseProjects[0], base);
      continue;
    }

    for (const project of sameBaseProjects) {
      labels.set(project, shortestUniqueSuffix(project, sameBaseProjects) ?? project);
    }
  }

  return labels;
}

function shortestUniqueSuffix(project: string, projects: string[]): string | null {
  const segments = projectSegments(project);
  for (let length = 2; length <= segments.length; length += 1) {
    const suffix = rightSuffix(segments, length);
    const matches = projects.filter((candidate) => rightSuffix(projectSegments(candidate), length) === suffix);
    if (matches.length === 1) {
      return suffix;
    }
  }
  return null;
}

function rightSuffix(segments: string[], length: number): string {
  return segments.slice(-length).join('/');
}

function projectSegments(project: string): string[] {
  return project.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
}

function githubProjectLabel(project: string): string | null {
  const match = project.match(/^github\.com\/([^/\s]+)\/([^/\s]+)$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}
