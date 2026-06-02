import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

export function ScrollArea({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn('ui-scroll-area', className)} {...props}>
      {children}
    </div>
  );
}
