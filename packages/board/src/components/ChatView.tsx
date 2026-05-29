import type { MemoryDocument } from '@muninn/types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User } from 'lucide-react';
import { transcriptMessages } from '../lib/transcript.js';
import { cn } from '../lib/utils.js';
import { Avatar, AvatarFallback } from './ui/avatar.js';
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

  return (
    <ScrollArea className="chat-scroll">
      <div className="chat-thread">
        {messages.map((message, index) => (
          <section key={`${message.role}-${index}`} className={cn('chat-message-row', message.role === 'agent' && 'chat-message-row-agent')}>
            <Avatar className={cn(message.role === 'agent' && 'chat-avatar-agent')}>
              <AvatarFallback>{message.role === 'user' ? <User /> : <Bot />}</AvatarFallback>
            </Avatar>
            <div className="chat-message-content">
              <div className="chat-message-meta">{message.label}</div>
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
