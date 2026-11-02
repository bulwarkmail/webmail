import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProofreadingSettings } from '../proofreading-settings';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import { resetCheckers, setPluginChecker } from '@/lib/plugin-sandbox/checkers';

// Settings > Composing > Proofreading as the user sees it under each admin choice.

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div data-testid="section">{children}</div>,
}));

const policy = (patch: Partial<SettingsPolicy>) =>
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, ...patch }, loaded: true, partial: false, subjectPending: false });

const register = (pluginId: string, pluginName: string) => setPluginChecker(pluginId, pluginName, {
  id: 'check', label: pluginName, kinds: ['spelling'], debounceMs: 800, languages: ['de-DE'], mode: 'typing', warnBeforeSend: false,
});

beforeEach(() => {
  useSettingsStore.getState().resetToDefaults();
  policy({});
  register('lt', 'LanguageTool');
});
afterEach(() => resetCheckers());

describe('ProofreadingSettings', () => {
  it('lets the user turn it on', () => {
    render(<ProofreadingSettings />);
    const toggle = screen.getByTestId('settings-proofreading');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().proofreading).toBe(true);
  });

  it('shows it on and locked when the organisation requires it, whatever the user stored', () => {
    policy({ restrictions: { proofreading: { locked: true, value: true } } });
    useSettingsStore.setState({ proofreading: false });
    const { container } = render(<ProofreadingSettings />);
    expect(screen.getByTestId('settings-proofreading').getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[data-org-locked]')).not.toBeNull();
  });

  it('hides the switch when the organisation turned it off and hid it', () => {
    policy({ restrictions: { proofreading: { locked: true, value: false, hidden: true } } });
    render(<ProofreadingSettings />);
    expect(screen.queryByTestId('settings-proofreading')).toBeNull();
    // The writing language stays.
    expect(screen.getByText('writing_language')).toBeInTheDocument();
  });

  it('has a switch per checker plugin when there are several', () => {
    register('ai', 'AI assistant');
    useSettingsStore.setState({ proofreading: true });
    render(<ProofreadingSettings />);
    fireEvent.click(screen.getByTestId('settings-proofreading-ai'));
    expect(useSettingsStore.getState().proofreadingPlugins).toEqual({ ai: false });
  });

  it('locks the writing language when the organisation set it', () => {
    policy({ restrictions: { writingLanguage: { locked: true, value: 'de-CH' } } });
    const { container } = render(<ProofreadingSettings />);
    expect(container.querySelectorAll('[data-org-locked]')).toHaveLength(1);
    expect(useSettingsStore.getState().writingLanguage).toBe('de-CH');
  });
});
