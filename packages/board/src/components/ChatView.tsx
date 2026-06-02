import type { MemoryDocument } from '@muninn/types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot } from 'lucide-react';
import claudeLogoUrl from '../assets/agent-claude.svg';
import codexLogoUrl from '../assets/agent-codex.svg';
import openclawLogoUrl from '../assets/agent-openclaw.svg';
import userAvatarUrl from '../assets/user-avatar.png';
import { transcriptMessages } from '../lib/transcript.js';
import { cn } from '../lib/utils.js';
import { Avatar } from './ui/avatar.js';
import { ScrollArea } from './ui/scroll-area.js';

type ChatViewProps = {
  document: MemoryDocument | null;
  loading: boolean;
  error: string | null;
};

export function ChatView({ document, loading, error }: ChatViewProps) {
  if (loading) {
    return <div className="empty-state">Loading conversation...</div>;
  }

  if (error) {
    return <div className="error-state">{error}</div>;
  }

  if (!document) {
    return (
      <div className="chat-empty">
        <p>Select a turn from the project tree.</p>
      </div>
    );
  }

  const messages = transcriptMessages(document);
  const agentLogo = logoForAgent(document.agent ?? document.observer ?? '');

  return (
    <ScrollArea className="chat-scroll">
      <div className="chat-thread">
        {messages.map((message, index) => (
          <section key={`${message.role}-${index}`} className={cn('chat-message-row', message.role === 'agent' && 'chat-message-row-agent')}>
            <Avatar className={cn('chat-avatar', message.role === 'agent' && 'chat-avatar-agent')}>
              {message.role === 'user' ? (
                <img src={userAvatarUrl} alt="User" className="chat-avatar-image" />
              ) : (
                <AgentAvatar logo={agentLogo} />
              )}
            </Avatar>
            <div className={cn('chat-message-content', isLongMessage(message.body) && 'chat-message-content-long')}>
              <div className="chat-bubble">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown>
              </div>
            </div>
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}

function isLongMessage(body: string): boolean {
  return body.length > 48 || body.includes('\n');
}

type AgentLogo = {
  label: string;
  src?: string;
};

function logoForAgent(agent: string): AgentLogo {
  const normalized = agent.toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized.includes('claude')) {
    return { label: 'Claude Code', src: claudeLogoUrl };
  }
  if (normalized.includes('codex') || normalized.includes('openai')) {
    return { label: 'Codex', src: codexLogoUrl };
  }
  if (normalized.includes('openclaw') || normalized.includes('open_claw')) {
    return { label: 'OpenClaw', src: openclawLogoUrl };
  }
  if (normalized.includes('cursor')) {
    return { label: 'Cursor', src: codexLogoUrl };
  }
  return { label: agent || 'Agent' };
}

function AgentAvatar({ logo }: { logo: AgentLogo }) {
  if (logo.src) {
    return <img src={logo.src} alt={logo.label} className="chat-agent-image" />;
  }
  return <Bot className="chat-agent-fallback" aria-label={logo.label} />;
}
