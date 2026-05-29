import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

export function Avatar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ui-avatar', className)} {...props} />;
}

export function AvatarFallback({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn('ui-avatar-fallback', className)} {...props}>
      {children}
    </div>
  );
}
