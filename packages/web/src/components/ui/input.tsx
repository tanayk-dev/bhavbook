// shadcn/ui's Input (new-york), owned source, with the direction's 2 px accent focus ring.
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-surface px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] placeholder:text-ink-muted disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
