import type { ComponentType } from 'react';
import { cn } from '../../lib/utils.js';

type EmptyStateTone = 'muted' | 'danger';
type EmptyStateVariant = 'default' | 'passive';

type EmptyStateIcon = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean;
}>;

type EmptyStateProps = {
  icon: EmptyStateIcon;
  title: string;
  description?: string;
  tone?: EmptyStateTone;
  variant?: EmptyStateVariant;
  className?: string;
};

export function EmptyState({ icon: Icon, title, description, tone = 'muted', variant = 'default', className }: EmptyStateProps) {
  return (
    <div className={cn('empty-state-block', `empty-state-block-${tone}`, `empty-state-block-${variant}`, className)}>
      <Icon className="empty-state-icon" aria-hidden />
      <div className="empty-state-copy">
        <p className="empty-state-title">{title}</p>
        {description ? <p className="empty-state-description">{description}</p> : null}
      </div>
    </div>
  );
}
