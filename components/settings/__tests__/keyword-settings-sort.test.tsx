import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeywordSettings } from '../keyword-settings';
import { useSettingsStore, type KeywordDefinition } from '@/stores/settings-store';
import { sortKeywordsByName } from '@/lib/keyword-nesting';

// #1075: a one-off Sort A–Z for the tag list. It writes the same ordered
// emailKeywords list dragging does, and the toast offers Undo.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));
vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const tag = (id: string, label: string): KeywordDefinition => ({ id, label, color: 'blue' });
const ids = () => useSettingsStore.getState().emailKeywords.map((k) => k.id);

beforeEach(() => {
  toast.success.mockClear();
  useSettingsStore.setState({
    emailKeywords: [tag('urgent', 'urgent'), tag('ideas', 'Ideas'), tag('a10', 'Area 10'), tag('a2', 'Area 2'), tag('eclair', 'Éclair')],
    nestedTags: false,
  });
});

describe('Sort A–Z in the tag settings (#1075)', () => {
  it('sorts the tags by name once, and Undo puts the old order back', () => {
    render(<KeywordSettings />);
    fireEvent.click(screen.getByTestId('tags-sort-az'));
    expect(ids()).toEqual(['a2', 'a10', 'eclair', 'ideas', 'urgent']);
    expect(toast.success).toHaveBeenCalledWith('sorted', expect.objectContaining({ action: expect.anything() }));

    // Moving a tag afterwards is a manual order again.
    fireEvent.click(screen.getAllByTestId('move-down')[0]);
    expect(ids().slice(0, 2)).toEqual(['a10', 'a2']);

    const { action } = toast.success.mock.calls[0][1] as { action: { onClick: () => void } };
    action.onClick();
    expect(ids()).toEqual(['urgent', 'ideas', 'a10', 'a2', 'eclair']);
  });

  it('is off while the tags are already in order', () => {
    useSettingsStore.setState({ emailKeywords: [tag('a', 'Apple'), tag('b', 'banana')] });
    render(<KeywordSettings />);
    expect((screen.getByTestId('tags-sort-az') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is not offered for a single tag', () => {
    useSettingsStore.setState({ emailKeywords: [tag('a', 'Apple')] });
    render(<KeywordSettings />);
    expect(screen.queryByTestId('tags-sort-az')).toBeNull();
  });
});

describe('sortKeywordsByName', () => {
  it('sorts as the language does', () => {
    const list = [tag('z', 'Zebra'), tag('ae', 'Äpfel')];
    expect(sortKeywordsByName(list, 'de').map((k) => k.id)).toEqual(['ae', 'z']);
    // Swedish puts Ä after Z.
    expect(sortKeywordsByName(list, 'sv').map((k) => k.id)).toEqual(['z', 'ae']);
  });

  it('keeps nested tags under their parent, sorted there too', () => {
    const list = [tag('work/zeta', 'zeta'), tag('home', 'Home'), tag('work', 'Work'), tag('work/alpha', 'alpha')];
    const sorted = sortKeywordsByName(list, 'en').map((k) => k.id);
    expect(sorted.indexOf('work/alpha')).toBeLessThan(sorted.indexOf('work/zeta'));
    expect(sorted.indexOf('home')).toBeLessThan(sorted.indexOf('work'));
  });
});
