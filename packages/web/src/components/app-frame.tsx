// The app frame (direction §4.4): a skip link, a left rail of surfaces, a 48 px top bar, and the content. Panels are
// separated by rules, not shadows or nested cards. Surfaces appear in the rail as their plan steps build them.
// Touch targets grow to 44 px on the phone layout (direction §7).
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, FileUp, Inbox, Moon, Settings, Sun, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { issueSummaryQuery } from '@/lib/issues';
import { applyTheme, currentTheme, safeStorage, type Theme } from '@/lib/theme';

export interface NavItem {
  readonly to: '/' | '/issues' | '/import' | '/settings';
  readonly label: string;
  readonly icon: LucideIcon;
}

/** The surfaces built so far (PRD §4); later steps add Review, Positions, Issues, Dashboard and more. */
export const NAV: readonly NavItem[] = [
  { to: '/', label: 'Overview', icon: BookOpen },
  { to: '/issues', label: 'Issues', icon: Inbox },
  { to: '/import', label: 'Import', icon: FileUp },
  { to: '/settings', label: 'Settings', icon: Settings },
];

/** The open-issue count on the Issues link; nothing while there are none (or the count can't be read). */
function OpenIssues() {
  const summary = useQuery({ ...issueSummaryQuery, retry: false });
  const open = summary.data?.open ?? 0;
  if (open === 0) return null;
  return (
    <span className="figure ml-auto rounded-sm bg-attention/15 px-1.5 text-xs text-attention max-lg:absolute max-lg:top-0.5 max-lg:right-0.5">
      {open.toLocaleString('en-IN')}
      <span className="sr-only"> open</span>
    </span>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme(document.documentElement));
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="max-lg:size-11"
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
      <a
        href="#main"
        className="sr-only z-10 rounded-sm bg-surface px-3 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <header className="col-span-2 flex items-center justify-between border-b border-rule bg-surface px-4">
        <Link to="/" className="flex h-11 items-center font-serif text-[15px] font-semibold lg:h-auto">
          BhavBook
        </Link>
        <ThemeToggle />
      </header>
      <nav aria-label="Main" className="border-r border-rule bg-surface py-3">
        <ul className="space-y-0.5 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <Link
                to={to}
                title={label}
                className="relative flex h-11 items-center gap-3 rounded-sm px-2 text-ink-muted hover:bg-muted hover:text-ink data-[status=active]:bg-accent data-[status=active]:text-accent-foreground lg:h-8"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span className="sr-only lg:not-sr-only">{label}</span>
                {to === '/issues' ? <OpenIssues /> : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" tabIndex={-1} className="min-w-0 px-6 py-5 outline-none">
        {children}
      </main>
    </div>
  );
}
