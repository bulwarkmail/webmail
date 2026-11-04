import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useRefreshGesture } from '@/hooks/use-refresh-gesture';
import { mergedDesktopState, resetDesktopCommands, runDesktopCommand } from '@/lib/desktop/commands';

/**
 * pim-p2-9 (2026-11-04): in the desktop app View > Refresh (F9) was Mail's "Check
 * for new mail" and greyed in Calendar, Contacts and Files. Each screen's own
 * refresh (the one F5 and pull-to-refresh run) now answers the menu.
 */

function Screen({ onRefresh, enabled = true }: { onRefresh: () => void; enabled?: boolean }) {
  const { indicator } = useRefreshGesture({ onRefresh, enabled });
  return <div>{indicator}</div>;
}

describe('useRefreshGesture in the desktop app', () => {
  beforeEach(() => {
    resetDesktopCommands();
    (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', menu: { setState: vi.fn(), onCommand: vi.fn() } };
  });
  afterEach(() => {
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    resetDesktopCommands();
  });

  it('enables View > Refresh and runs the screen refresh from it', async () => {
    const onRefresh = vi.fn();
    render(<Screen onRefresh={onRefresh} />);
    expect(mergedDesktopState()['view.refresh']).toBe(true);
    await act(async () => {
      expect(runDesktopCommand('view.refresh')).toBe(true);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('offers nothing while the screen can not refresh', () => {
    render(<Screen onRefresh={vi.fn()} enabled={false} />);
    expect(mergedDesktopState()['view.refresh']).toBeUndefined();
    expect(runDesktopCommand('view.refresh')).toBe(false);
  });
});
