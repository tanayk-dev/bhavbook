// shadcn/ui's Label (new-york), owned source: a plain <label> (Radix's adds nothing a native label lacks here).
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn('flex items-center gap-2 text-sm font-medium leading-none select-none', className)}
      {...props}
    />
  );
}
