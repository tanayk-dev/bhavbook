// S13a-1: money and provenance (direction §3, §4.2: never colour alone), and the content states (§6).
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Money } from '@/components/money';
import { Provenance } from '@/components/provenance';
import { Disconnected, EmptyState, ErrorState, LoadingRows } from '@/components/states';

describe('Money', () => {
  it('shows a profit with a plus sign and a glyph, and says "profit"', () => {
    const { container } = render(<Money valueMicro={1_234_560_000n} signed />);
    expect(screen.getByText('profit ₹1,234.56')).toBeInTheDocument();
    expect(container.textContent).toContain('▲+₹1,234.56');
  });

  it('shows a loss with a true minus sign (U+2212) and a down glyph, and says "loss"', () => {
    const { container } = render(<Money valueMicro={-312_400_000n} signed />);
    expect(container.textContent).toContain('▼−₹312.40');
    expect(screen.getByText('loss ₹312.40')).toBeInTheDocument();
  });

  it('never drops the sign of a negative plain amount', () => {
    const { container } = render(<Money valueMicro={-5_000_000n} />);
    expect(container.textContent).toContain('−₹5.00');
    expect(screen.getByText('minus ₹5.00')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[▲▼]/);
  });

  it('shows zero and positive plain amounts without a sign, with Indian grouping', () => {
    const { container } = render(
      <>
        <Money valueMicro={0n} signed />
        <Money valueMicro={123_456_780_000n} />
      </>,
    );
    expect(container.textContent).not.toMatch(/[▲▼+−]/);
    expect(container.textContent).toContain('₹1,23,456.78');
  });

  it('carries its provenance mark', () => {
    render(<Money valueMicro={5_000_000n} provenance="estimated" />);
    expect(screen.getByRole('img', { name: 'Estimated by the fee engine' })).toHaveTextContent('≈');
  });
});

describe('Provenance', () => {
  it.each([
    ['reconciled', '✓', "Reconciled with the broker's statement"],
    ['discrepancy', '!', "Differs from the broker's statement"],
    ['incomplete', '◐', 'Incomplete history'],
    ['inferred', 'ⓘ', 'Product type inferred'],
  ] as const)('%s is %s, named for screen readers and reachable by keyboard', async (kind, glyph, label) => {
    render(<Provenance kind={kind} />);
    const mark = screen.getByRole('img', { name: label });
    expect(mark).toHaveTextContent(glyph);
    await userEvent.tab();
    expect(mark).toHaveFocus();
  });

  it('adds detail such as the rule versions', () => {
    render(<Provenance kind="estimated" detail="nse/2024-10-01 + dhan/2024-04-01" />);
    expect(
      screen.getByRole('img', { name: 'Estimated by the fee engine: nse/2024-10-01 + dhan/2024-04-01' }),
    ).toBeInTheDocument();
  });
});

describe('content states', () => {
  it('loading keeps rows in place and announces what is loading', () => {
    render(<LoadingRows label="Loading trades" rows={4} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading trades');
    expect(status).toHaveAttribute('aria-busy', 'true');
  });

  it('empty says why', () => {
    render(<EmptyState title="Nothing to review">All caught up.</EmptyState>);
    expect(screen.getByRole('region', { name: 'Nothing to review' })).toHaveTextContent('All caught up.');
  });

  it('error offers a retry, and shows when one is in flight', async () => {
    const retry = vi.fn();
    const { rerender } = render(<ErrorState message="Could not read the vault." onRetry={retry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
    rerender(<ErrorState message="Could not read the vault." onRetry={retry} retrying />);
    expect(screen.getByRole('button', { name: 'Trying again…' })).toBeDisabled();
    rerender(<ErrorState message="No retry here." />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['ended', 'This BhavBook session has ended'],
    ['refused', 'BhavBook does not accept this address'],
    ['stopped', 'BhavBook is not running'],
  ] as const)('%s: says what happened and how to restart, never asks for a login', (reason, title) => {
    render(<Disconnected reason={reason} />);
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('npx bhavbook');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
