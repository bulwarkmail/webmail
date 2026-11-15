import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FloatingComposeButton } from '../floating-compose-button';

// On a desktop the floating Compose button has its label, and folds to the
// round icon while the list scrolls down so it covers less of the rows.

function renderInPane(kind: 'desktop' | 'phone') {
  const onCompose = vi.fn();
  render(
    <section>
      <div data-testid="list" style={{ overflowY: 'auto' }} />
      <FloatingComposeButton kind={kind} onCompose={onCompose} />
    </section>,
  );
  const list = screen.getByTestId('list');
  const scrollTo = (top: number) => act(() => {
    list.scrollTop = top;
    list.dispatchEvent(new Event('scroll'));
  });
  return { onCompose, scrollTo, button: () => screen.getByRole('button', { name: 'sidebar.compose' }) };
}

describe('FloatingComposeButton', () => {
  it('shows its label on a desktop and opens the composer', () => {
    const { button, onCompose } = renderInPane('desktop');
    expect(button().textContent).toBe('sidebar.compose');
    fireEvent.click(button());
    expect(onCompose).toHaveBeenCalledTimes(1);
  });

  it('folds while the list scrolls down and unfolds when it scrolls back up', () => {
    const { button, scrollTo } = renderInPane('desktop');
    scrollTo(200);
    expect(button().textContent).toBe('');
    scrollTo(400);
    expect(button().textContent).toBe('');
    scrollTo(300);
    expect(button().textContent).toBe('sidebar.compose');
    scrollTo(500);
    expect(button().textContent).toBe('');
    scrollTo(0);
    expect(button().textContent).toBe('sidebar.compose');
  });

  it('ignores a scroll of a few pixels', () => {
    const { button, scrollTo } = renderInPane('desktop');
    scrollTo(200);
    scrollTo(198);
    expect(button().textContent).toBe('');
  });

  it('stays the round icon on a phone', () => {
    const { button, scrollTo } = renderInPane('phone');
    expect(button().textContent).toBe('');
    scrollTo(0);
    expect(button().textContent).toBe('');
  });
});
