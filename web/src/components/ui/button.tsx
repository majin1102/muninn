import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

type ButtonVariant = 'default' | 'ghost' | 'outline';
type ButtonSize = 'default' | 'icon' | 'sm';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
};

export function Button({
  className,
  variant = 'default',
  size = 'default',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn('ui-button', `ui-button-${variant}`, `ui-button-${size}`, className)}
      {...props}
    >
      {children}
    </button>
  );
}
