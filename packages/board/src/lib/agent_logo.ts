import claudeLogoUrl from '../assets/agent-claude.svg';
import codexLogoUrl from '../assets/agent-codex.svg';
import openclawLogoUrl from '../assets/agent-openclaw.svg';

export type AgentLogo = {
  key: string;
  label: string;
  src?: string;
  fallback?: boolean;
};

export const AGENT_LOGOS: Record<string, AgentLogo> = {
  claude: { key: 'claude', label: 'Claude Code', src: claudeLogoUrl },
  codex: { key: 'codex', label: 'Codex', src: codexLogoUrl },
  openclaw: { key: 'openclaw', label: 'OpenClaw', src: openclawLogoUrl },
  cursor: { key: 'cursor', label: 'Cursor', src: codexLogoUrl },
};

export function logoForAgent(agent: string): AgentLogo {
  const normalized = agent.toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized.includes('claude')) {
    return AGENT_LOGOS.claude;
  }
  if (normalized.includes('codex') || normalized.includes('openai')) {
    return AGENT_LOGOS.codex;
  }
  if (normalized.includes('openclaw') || normalized.includes('open_claw')) {
    return AGENT_LOGOS.openclaw;
  }
  if (normalized.includes('cursor')) {
    return AGENT_LOGOS.cursor;
  }
  return { key: `fallback:${normalized}`, label: agent || 'Unknown agent', fallback: true };
}
