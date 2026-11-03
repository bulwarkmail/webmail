import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SubAddressHelper } from '../sub-address-helper';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

function open() {
  render(<SubAddressHelper baseEmail="nora@example.com" recipientEmails={[]} onSelectTag={() => {}} />);
  fireEvent.click(screen.getByTitle('button_tooltip'));
  return screen.getByRole('dialog', { name: 'popover_title' });
}

describe('SubAddressHelper', () => {
  it('closes on Escape', () => {
    const dialog = open();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps that Escape from what is around it, so the composer stays open', () => {
    const composerKey = vi.fn();
    render(
      <div onKeyDown={composerKey}>
        <SubAddressHelper baseEmail="nora@example.com" recipientEmails={[]} onSelectTag={() => {}} />
      </div>,
    );
    fireEvent.click(screen.getByTitle('button_tooltip'));

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'popover_title' }), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(composerKey).not.toHaveBeenCalled();
  });

  it('moves back on screen when its button is near the left edge', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: -80, right: 240 } as DOMRect);
    const dialog = open();
    expect(dialog.style.translate).toBe('88px');
    rect.mockRestore();
  });
});
