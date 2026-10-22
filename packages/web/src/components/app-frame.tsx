// The app frame (direction §4.4): a skip link, a left rail of surfaces, a 48 px top bar, and the content. Panels are
// separated by rules, not shadows or nested cards. Surfaces appear in the rail as their plan steps build them.
// Touch targets grow to 44 px on the phone layout (direction §7).
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  BookOpen,
  ClipboardCheck,
  FileUp,
  GitFork,
  Inbox,
  Moon,
  Settings,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { issueSummaryQuery } from '@/lib/issues';
import { reviewCountQuery } from '@/lib/positions';
import { applyTheme, currentTheme, safeStorage, type Theme } from '@/lib/theme';

export interface NavItem {
  readonly to: '/' | '/review' | '/issues' | '/corporate-actions' | '/import' | '/settings';
  readonly label: string;
  readonly icon: LucideIcon;
}

/** The surfaces built so far (PRD §4); later steps add Review, Positions, Issues, Dashboard and more. */
export const NAV: readonly NavItem[] = [
  { to: '/', label: 'Overview', icon: BookOpen },
  { to: '/review', label: 'Review', icon: ClipboardCheck },
  { to: '/issues', label: 'Issues', icon: Inbox },
  { to: '/corporate-actions', label: 'Corporate actions', icon: GitFork },
  { to: '/import', label: 'Import', icon: FileUp },
  { to: '/settings', label: 'Settings', icon: Settings },
];

/** A count beside a link, for the eye; the link's accessible name says it in words. */
function Badge({ count }: { readonly count: number }) {
  if (count === 0) return null;
  return (
    <span
      aria-hidden="true"
      className="figure ml-auto rounded-sm bg-attention/15 px-1.5 text-xs text-attention max-lg:absolute max-lg:top-0.5 max-lg:right-0.5"
    >
      {count.toLocaleString('en-IN')}
    </span>
  );
}

/**
 * The counts on the rail: open issues and closed positions waiting for review. Nothing while there are none (or a
 * count can't be read).
 */
function useCounts(): Readonly<Partial<Record<NavItem['to'], { count: number; words: string }>>> {
  const issues = useQuery({ ...issueSummaryQuery, retry: false });
  const review = useQuery({ ...reviewCountQuery, retry: false });
  return {
    '/issues': { count: issues.data?.open ?? 0, words: 'open' },
    '/review': { count: review.data ?? 0, words: 'to review' },
  };
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
  const counts = useCounts();
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
          {NAV.map(({ to, label, icon: Icon }) => {
            const badge = counts[to];
            const count = badge?.count ?? 0;
            return (
              <li key={to}>
                <Link
                  to={to}
                  title={label}
                  aria-label={
                    count === 0 ? label : `${label}, ${count.toLocaleString('en-IN')} ${badge?.words ?? ''}`
                  }
                  className="relative flex h-11 items-center gap-3 rounded-sm px-2 text-ink-muted hover:bg-muted hover:text-ink data-[status=active]:bg-accent data-[status=active]:text-accent-foreground lg:h-8"
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="sr-only lg:not-sr-only">{label}</span>
                  <Badge count={count} />
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <main id="main" tabIndex={-1} className="min-w-0 px-6 py-5 outline-none">
        {children}
      </main>
    </div>
  );
}
