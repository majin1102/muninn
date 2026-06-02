import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { createContext, useContext, useMemo, useState } from 'react';
import { cn } from '../../lib/utils.js';

type CollapsibleContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const CollapsibleContext = createContext<CollapsibleContextValue | null>(null);

type CollapsibleProps = HTMLAttributes<HTMLDivElement> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
};

export function Collapsible({
  className,
  defaultOpen = false,
  open,
  onOpenChange,
  children,
  ...props
}: CollapsibleProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const resolvedOpen = open ?? internalOpen;
  const value = useMemo(() => ({
    open: resolvedOpen,
    setOpen(next: boolean) {
      setInternalOpen(next);
      onOpenChange?.(next);
    },
  }), [onOpenChange, resolvedOpen]);

  return (
    <CollapsibleContext.Provider value={value}>
      <div className={cn('ui-collapsible', className)} data-state={resolvedOpen ? 'open' : 'closed'} {...props}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

export function CollapsibleTrigger({
  className,
  children,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  const context = useContext(CollapsibleContext);
  if (!context) {
    throw new Error('CollapsibleTrigger must be used inside Collapsible');
  }

  return (
    <button
      className={cn('ui-collapsible-trigger', className)}
      aria-expanded={context.open}
      onClick={(event) => {
        onClick?.(event);
        context.setOpen(!context.open);
      }}
      {...props}
    >
      {children}
    </button>
  );
}

export function CollapsibleContent({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  const context = useContext(CollapsibleContext);
  if (!context || !context.open) {
    return null;
  }

  return (
    <div className={cn('ui-collapsible-content', className)} {...props}>
      {children}
    </div>
  );
}
