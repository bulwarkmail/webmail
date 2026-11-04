import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InlineAppView } from '@/components/layout/inline-app-view';
import { CLOSE_MOVES_ATTRIBUTE, CONTROLS_ATTRIBUTE } from '@/lib/window-controls-overlay';

const root = document.documentElement;

afterEach(() => {
  cleanup();
  root.removeAttribute(CONTROLS_ATTRIBUTE);
});

function buttonsOfHeader(): HTMLElement[] {
  const header = document.querySelector<HTMLElement>('[data-window-top-row]')!;
  return Array.from(header.querySelectorAll('button'));
}

describe('a pane\'s close beside the window\'s', () => {
  const apps = [{ id: 'notes', name: 'Notes', url: 'https://notes.example.org' }] as never;

  it('is at the end of its row without window controls', () => {
    render(<InlineAppView apps={apps} activeAppId="notes" onClose={() => {}} />);
    const header = document.querySelector<HTMLElement>('[data-window-top-row]')!;
    expect(header.lastElementChild?.tagName).toBe('BUTTON');
  });

  it('moves to the start, in the page\'s order too, when the row ends at the window\'s controls', async () => {
    root.setAttribute(CONTROLS_ATTRIBUTE, '');
    render(<InlineAppView apps={apps} activeAppId="notes" onClose={() => {}} />);
    const header = document.querySelector<HTMLElement>('[data-window-top-row]')!;
    act(() => header.setAttribute(CLOSE_MOVES_ATTRIBUTE, ''));
    await waitFor(() => expect(header.firstElementChild?.tagName).toBe('BUTTON'));
    // Tab reaches it first, where it's seen.
    expect(buttonsOfHeader()[0]).toBe(screen.getByRole('button', { name: 'close' }));
    // The window narrows and the row no longer ends there: back to the end.
    act(() => header.removeAttribute(CLOSE_MOVES_ATTRIBUTE));
    await waitFor(() => expect(header.lastElementChild?.tagName).toBe('BUTTON'));
  });

  it('stays at the end when the window has no controls over the page, whatever the row says', async () => {
    render(<InlineAppView apps={apps} activeAppId="notes" onClose={() => {}} />);
    const header = document.querySelector<HTMLElement>('[data-window-top-row]')!;
    act(() => header.setAttribute(CLOSE_MOVES_ATTRIBUTE, ''));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(header.lastElementChild?.tagName).toBe('BUTTON');
  });
});
