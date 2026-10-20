// The app frame (direction §4.4): a left rail of surfaces, a 48 px top bar, and the content. Panels are separated
// by rules, not shadows or nested cards. Surfaces appear in the rail as their plan steps build them.
import { Link } from '@tanstack/react-router';
import { BookOpen, Moon, Sun, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { applyTheme, safeStorage, storedTheme, type Theme } from '@/lib/theme';

export interface NavItem {
  readonly to: '/';
  readonly label: string;
  readonly icon: LucideIcon;
}

/** The surfaces built so far (PRD §4); later steps add Review, Positions, Issues, Dashboard, Import and more. */
export const NAV: readonly NavItem[] = [{ to: '/', label: 'Overview', icon: BookOpen }];

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => storedTheme(safeStorage()));
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        applyTheme(next, document.documentElement, safeStorage());
        setTheme(next);
      }}
    >
      {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </Button>
  );
}

export function AppFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-cols-[56px_1fr] grid-rows-[48px_1fr] lg:grid-cols-[224px_1fr]">
      <header className="col-span-2 flex items-center justify-between border-b border-rule bg-surface px-4">
        <Link to="/" className="font-semibold tracking-tight">
          Bhav<span className="text-primary">Book</span>
        </Link>
        <ThemeToggle />
      </header>
      <nav aria-label="Main" className="border-r border-rule bg-surface py-3">
        <ul className="space-y-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <Link
                to={to}
                aria-label={label}
                className="flex h-8 items-center gap-3 rounded-sm px-2 text-ink-muted hover:bg-muted hover:text-ink data-[status=active]:bg-accent data-[status=active]:text-accent-foreground"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span className="hidden lg:inline">{label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className="min-w-0 px-6 py-5">
        {children}
      </main>
    </div>
  );
}
