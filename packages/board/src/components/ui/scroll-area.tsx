import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '../../lib/utils.js';

export function ScrollArea({
  className,
  children,
  ref,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className={cn('ui-scroll-area', className)} {...props}>
      {children}
    </div>
  );
}
