import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

// The admin policy's archiveActionEnabled gate (#1257): off, the settings offer
// no archive mode, no archive hover or swipe action and no archive after an
// export, and a stored 'archive' shows as the choice that now applies.
// vitest.setup.ts renders labels as their raw keys.

const { ReadingSettings } = await import('../reading-settings');
const { DownloadsSettings } = await import('../downloads-settings');
const { usePolicyStore } = await import('@/stores/policy-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const initial = { policy: usePolicyStore.getState(), settings: useSettingsStore.getState() };
afterEach(() => {
  usePolicyStore.setState(initial.policy, true);
  useSettingsStore.setState(initial.settings, true);
});

function setArchiveGate(on: boolean) {
  usePolicyStore.setState((state) => ({
    policy: { ...state.policy, features: { ...state.policy.features, archiveActionEnabled: on } },
  }));
}

function selectFor(optionKey: string): HTMLSelectElement {
  const option = screen.getAllByRole('option').find((o) => o.textContent === optionKey);
  if (!option) throw new Error(`no option ${optionKey}`);
  return option.closest('select') as HTMLSelectElement;
}

describe('the settings and the Archive action gate', () => {
  it('reading: archive mode, archive hover and swipe actions while the gate is on', () => {
    useSettingsStore.setState({ swipeRightAction: 'archive' } as never);
    render(<ReadingSettings />);
    expect(screen.getByText('archive_mode.label')).toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: 'swipe_actions.archive' })).toHaveLength(2);
    expect(screen.getByText('hover_actions.archive')).toBeInTheDocument();
    expect(selectFor('swipe_actions.archive').value).toBe('archive');
  });

  it('reading: none of them with the gate off, a stored archive swipe shown as none', () => {
    setArchiveGate(false);
    useSettingsStore.setState({ swipeRightAction: 'archive' } as never);
    render(<ReadingSettings />);
    expect(screen.queryByText('archive_mode.label')).toBeNull();
    expect(screen.queryAllByRole('option', { name: 'swipe_actions.archive' })).toHaveLength(0);
    expect(screen.queryByText('hover_actions.archive')).toBeNull();
    const swipeSelects = screen.getAllByRole('option', { name: 'swipe_actions.none' }).map((o) => o.closest('select') as HTMLSelectElement);
    expect(swipeSelects.map((s) => s.value)).toContain('none');
    expect(useSettingsStore.getState().swipeRightAction).toBe('archive');
  });

  it('downloads: archive after export while the gate is on', () => {
    useSettingsStore.setState({ postExportAction: 'archive' } as never);
    render(<DownloadsSettings />);
    expect(selectFor('after_export.archive').value).toBe('archive');
  });

  it('downloads: no archive after export with the gate off, a stored one shown as keep', () => {
    setArchiveGate(false);
    useSettingsStore.setState({ postExportAction: 'archive' } as never);
    render(<DownloadsSettings />);
    expect(screen.queryByRole('option', { name: 'after_export.archive' })).toBeNull();
    expect(selectFor('after_export.keep').value).toBe('keep');
  });
});
