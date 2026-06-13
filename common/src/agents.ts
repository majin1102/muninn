export const CODEX_AGENT = 'codex' as const;
export const CLAUDE_AGENT = 'claude-code' as const;

export type MuninnAgent = typeof CODEX_AGENT | typeof CLAUDE_AGENT;

export function agentLabel(agent: MuninnAgent): string {
  switch (agent) {
    case CODEX_AGENT:
      return 'Codex';
    case CLAUDE_AGENT:
      return 'Claude Code';
  }
}
