import type { Artifact } from '@muninn/common';

export type ArtifactPresentation = {
  href: string;
  label: string;
  meta: string;
  mode: 'image' | 'markdown' | 'external' | 'file';
  icon: 'image' | 'document' | 'html' | 'file';
  text?: string;
};

export function artifactPresentation(artifact: Artifact): ArtifactPresentation {
  const href = artifactHref(artifact);
  const label = artifact.name ?? artifact.key;
  const meta = artifactMeta(artifact);
  if (artifact.kind === 'image') {
    return { href, label, meta, mode: 'image', icon: 'image' };
  }
  if (isHtmlArtifact(artifact)) {
    return { href, label, meta, mode: 'external', icon: 'html' };
  }
  if (isInlineTextArtifact(artifact)) {
    return { href, label, meta, mode: 'markdown', icon: 'document', text: artifact.content };
  }
  return { href, label, meta, mode: 'file', icon: 'file' };
}

export function artifactHref(artifact: Artifact): string {
  if (!artifact.uri) {
    return '#';
  }
  if (artifact.uri.startsWith('artifact://')) {
    return `/app/artifacts/${encodeURIComponent(artifact.uri.slice('artifact://'.length))}`;
  }
  return artifact.uri;
}

function artifactMeta(artifact: Artifact): string {
  const parts = [
    artifact.mimeType,
    artifact.sizeBytes !== undefined ? formatBytes(artifact.sizeBytes) : undefined,
  ].filter(Boolean);
  return parts.join(' · ') || artifact.kind;
}

function isHtmlArtifact(artifact: Artifact): boolean {
  return artifact.mimeType === 'text/html'
    || artifact.name?.toLowerCase().endsWith('.html') === true
    || artifact.name?.toLowerCase().endsWith('.htm') === true;
}

function isInlineTextArtifact(artifact: Artifact): artifact is Artifact & { content: string } {
  if (!artifact.content) {
    return false;
  }
  return artifact.mimeType?.startsWith('text/') === true
    || artifact.mimeType === 'application/json'
    || artifact.name?.toLowerCase().endsWith('.md') === true
    || artifact.name?.toLowerCase().endsWith('.txt') === true
    || artifact.name?.toLowerCase().endsWith('.json') === true;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
