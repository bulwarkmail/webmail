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

const toggle = () =>
  screen.getByText('group_by_date.label')
    .closest('[data-search-label="group_by_date.label"]')!
    .querySelector('button[role="switch"]')!;

describe('Group by date in Settings → Message list', () => {
  it('is off by default and turns groupListByDate on', () => {
    render(<MessageListSettings />);
    expect(screen.getByText('group_by_date.description')).toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-checked', 'false');

    act(() => { fireEvent.click(toggle()); });

    expect(useSettingsStore.getState().groupListByDate).toBe(true);
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });

  it('follows a change made from the list menu', () => {
    render(<MessageListSettings />);
    act(() => { useSettingsStore.getState().updateSetting('groupListByDate', true); });
    expect(toggle()).toHaveAttribute('aria-checked', 'true');
  });

  it('is hidden when hidden by policy', () => {
    usePolicyStore.setState((state) => ({
      policy: { ...state.policy, restrictions: { ...state.policy.restrictions, groupListByDate: { hidden: true } } },
    }));
    render(<MessageListSettings />);
    expect(screen.queryByText('group_by_date.label')).toBeNull();
  });
});
