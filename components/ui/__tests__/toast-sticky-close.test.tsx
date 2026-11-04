import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ToastItem } from '../toast';

const closeOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-toast-close]')!;

describe('the close button of a toast', () => {
  it('shows all the time on a toast that stays until closed', () => {
    const { container } = render(
      <ToastItem onClose={vi.fn()} toast={{ id: 's', type: 'info', title: 'Mail is kept on this device', duration: 0, action: { label: 'Open settings', onClick: () => {} } }} />,
    );
    expect(closeOf(container).className).toContain('opacity-100');
    expect(closeOf(container).className).not.toContain('opacity-0');
  });

  it('shows on hover or focus on a toast that goes by itself', () => {
    vi.useFakeTimers();
    const { container } = render(<ToastItem onClose={vi.fn()} toast={{ id: 't', type: 'success', title: 'Sent', duration: 5000 }} />);
    expect(closeOf(container).className).toContain('opacity-0');
    vi.useRealTimers();
  });
});
