import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageListSettings } from '../message-list-settings';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';

const initial = { policy: usePolicyStore.getState(), settings: useSettingsStore.getState() };

beforeEach(() => {
  usePolicyStore.setState(initial.policy, true);
  useSettingsStore.setState(initial.settings, true);
});

afterEach(() => {
  usePolicyStore.setState(initial.policy, true);
  useSettingsStore.setState(initial.settings, true);
});

describe('attachment chips setting in MessageListSettings', () => {
  it('renders the show_attachment_chips toggle switch on by default', () => {
    render(<MessageListSettings />);
    const label = screen.getByText('show_attachment_chips.label');
    expect(label).toBeInTheDocument();

    const settingItem = label.closest('[data-search-label="show_attachment_chips.label"]');
    expect(settingItem).not.toBeNull();

    const toggle = settingItem!.querySelector('button[role="switch"]');
    expect(toggle).not.toBeNull();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('toggles showAttachmentChips off when clicked', () => {
    render(<MessageListSettings />);
    const label = screen.getByText('show_attachment_chips.label');
    const settingItem = label.closest('[data-search-label="show_attachment_chips.label"]');
    const toggle = settingItem!.querySelector('button[role="switch"]')!;

    act(() => {
      fireEvent.click(toggle);
    });

    expect(useSettingsStore.getState().showAttachmentChips).toBe(false);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('hides the setting when hidden by policy', () => {
    usePolicyStore.setState((state) => ({
      policy: {
        ...state.policy,
        restrictions: {
          ...state.policy.restrictions,
          showAttachmentChips: { hidden: true },
        },
      },
    }));

    render(<MessageListSettings />);
    expect(screen.queryByText('show_attachment_chips.label')).toBeNull();
  });

  it('locks the setting when locked by policy', () => {
    usePolicyStore.setState((state) => ({
      policy: {
        ...state.policy,
        restrictions: {
          ...state.policy.restrictions,
          showAttachmentChips: { locked: true },
        },
      },
    }));

    render(<MessageListSettings />);
    const label = screen.getByText('show_attachment_chips.label');
    const settingItem = label.closest('[data-search-label="show_attachment_chips.label"]');
    const toggleContainer = settingItem!.querySelector('div[inert]');
    expect(toggleContainer).not.toBeNull();
    expect(settingItem!.querySelector('.text-amber-700, .text-amber-400, [data-testid="org-locked"]')).toBeDefined();
  });
});
