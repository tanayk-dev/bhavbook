// S13a-1: money and provenance (direction §3, §4.2: never colour alone), and the content states (§6).
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Money } from '@/components/money';
import { Provenance } from '@/components/provenance';
import { EmptyState, ErrorState, LoadingRows, SessionEnded } from '@/components/states';

describe('Money', () => {
  it('shows a profit with a plus sign, a glyph, gain colour and spoken words', () => {
    const { container } = render(<Money valueMicro={1_234_560_000n} signed />);
    expect(screen.getByText('profit ₹1,234.56')).toHaveClass('sr-only');
    expect(container.textContent).toContain('▲');
    expect(container.textContent).toContain('+₹1,234.56');
    expect(container.firstElementChild).toHaveClass('text-gain', 'figure');
  });

  it('shows a loss with a true minus sign (U+2212) and a down glyph', () => {
    const { container } = render(<Money valueMicro={-312_400_000n} signed />);
    expect(container.textContent).toContain('▼');
    expect(container.textContent).toContain('−₹312.40');
    expect(screen.getByText('loss ₹312.40')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('text-loss');
  });

  it('shows zero and unsigned amounts plainly, with Indian grouping', () => {
    const { container } = render(
      <>
        <Money valueMicro={0n} signed />
        <Money valueMicro={123_456_780_000n} />
      </>,
    );
    expect(container.textContent).not.toMatch(/[▲▼]/);
    expect(container.textContent).toContain('₹1,23,456.78');
  });

  it('carries its provenance mark', () => {
    render(<Money valueMicro={5_000_000n} provenance="estimated" />);
    expect(screen.getByLabelText('Estimated by the fee engine')).toHaveTextContent('≈');
  });
});

describe('Provenance', () => {
  it.each([
    ['reconciled', '✓', "Reconciled with the broker's statement"],
    ['discrepancy', '!', "Differs from the broker's statement"],
    ['incomplete', '◐', 'Incomplete history'],
    ['inferred', 'ⓘ', 'Product type inferred'],
  ] as const)('%s is %s, named for screen readers', (kind, glyph, label) => {
    render(<Provenance kind={kind} />);
    expect(screen.getByLabelText(label)).toHaveTextContent(glyph);
  });

  it('adds detail such as the rule versions', () => {
    render(<Provenance kind="estimated" detail="nse/2024-10-01 + dhan/2024-04-01" />);
    expect(
      screen.getByTitle('Estimated by the fee engine: nse/2024-10-01 + dhan/2024-04-01'),
    ).toBeInTheDocument();
  });
});

describe('content states', () => {
  it('loading keeps rows in place and is announced', () => {
    render(<LoadingRows label="Loading trades" rows={4} />);
    expect(screen.getByRole('status', { name: 'Loading trades' }).children).toHaveLength(4);
  });

  it('empty says why', () => {
    render(<EmptyState title="Nothing to review">All caught up.</EmptyState>);
    expect(screen.getByRole('region', { name: 'Nothing to review' })).toHaveTextContent('All caught up.');
  });

  it('error offers a retry', async () => {
    const retry = vi.fn();
    render(<ErrorState message="Could not read the vault." onRetry={retry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
    render(<ErrorState message="No retry here." />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('an ended session says how to restart, never asks for a login', () => {
    render(<SessionEnded />);
    expect(screen.getByRole('alert')).toHaveTextContent('npx bhavbook');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
