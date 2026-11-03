import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProofreadingStatus } from '../proofreading/proofreading-status';
import { ProofreadingNotice } from '../proofreading/proofreading-notice';
import { IssuePopup } from '../proofreading/issue-popup';
import type { Proofreading } from '../proofreading/use-proofreading';
import type { PlacedIssue, ProofreaderStatus } from '@/lib/proofreading/composer-proofreader';
import { useSettingsStore } from '@/stores/settings-store';
import { editorA11yAttributes } from '../rich-text-editor';

// next-intl is mocked in vitest.setup.ts: t(key) gives the key back.

const announce = vi.hoisted(() => vi.fn());
vi.mock('@/lib/announce', () => ({ announce }));

const issue = (over: Partial<PlacedIssue> = {}, ann: Partial<PlacedIssue['annotation']> = {}): PlacedIssue => ({
  key: 'lt/c|s1|9|3|R1', checkerKey: 'lt/c', pluginId: 'lt', checkerId: 'c', checkerLabel: 'LanguageTool',
  kind: 'grammar', from: 10, to: 13, alternatives: [],
  annotation: { segmentId: 's1', offset: 9, length: 3, kind: 'grammar', message: 'Did you mean "den"?', replacements: ['den'], ruleId: 'R1', text: 'dem', ...ann },
  ...over,
});

const status = (over: Partial<ProofreaderStatus> = {}): ProofreaderStatus => ({
  available: true, on: true, userOn: true, forced: false, lockedOff: false, paused: null, checking: false, trouble: null,
  count: 1, activeLabels: ['LanguageTool'], activePlugins: [{ pluginId: 'lt', label: 'LanguageTool' }],
  availablePlugins: [{ pluginId: 'lt', label: 'LanguageTool' }], ...over,
});

function proofreading(over: Partial<Proofreading> = {}): Proofreading {
  return {
    issues: [issue()], status: status(), composerOn: true, setComposerOn: vi.fn(), apply: vi.fn(() => true), dismiss: vi.fn(),
    browserSpellcheck: false, sendWarningIssues: () => [], popup: null, openPopup: vi.fn(), closePopup: vi.fn(),
    panel: null, setPanel: vi.fn(), navigate: vi.fn(() => true), jumpTo: vi.fn(), editorHandlers: { onOpen: vi.fn() },
    ...over,
  };
}

beforeEach(() => {
  announce.mockReset();
  useSettingsStore.getState().resetToDefaults();
});

describe('ProofreadingStatus', () => {
  it('shows nothing without a checker the user may use', () => {
    const { container } = render(<ProofreadingStatus proofreading={proofreading({ status: status({ available: false }) })} plainTextMode={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the count and reads it out once', () => {
    render(<ProofreadingStatus proofreading={proofreading()} plainTextMode={false} />);
    expect(screen.getByTestId('proofreading-status').textContent).toContain('status.issues');
    expect(announce).toHaveBeenCalledWith('announce_count', expect.objectContaining({ key: 'proofreading-count' }));
  });

  it('when off, explains what is sent before turning it on', () => {
    const p = proofreading({ status: status({ on: false, userOn: false, activePlugins: [] }), issues: [], panel: { focusKey: null } });
    render(<ProofreadingStatus proofreading={p} plainTextMode={false} />);
    expect(screen.getByTestId('proofreading-status').textContent).toContain('status.off');
    expect(screen.getByText('panel.notice')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('proofreading-turn-on'));
    expect(useSettingsStore.getState().proofreading).toBe(true);
    expect(useSettingsStore.getState().proofreadingNoticeSeen).toEqual({ lt: true });
  });

  it('offers this message\'s switch, but not when the organisation requires checking', () => {
    const p = proofreading({ panel: { focusKey: null } });
    const { rerender } = render(<ProofreadingStatus proofreading={p} plainTextMode={false} />);
    fireEvent.click(screen.getByTestId('proofreading-composer-switch'));
    expect(p.setComposerOn).toHaveBeenCalledWith(false);
    rerender(<ProofreadingStatus proofreading={proofreading({ panel: { focusKey: null }, status: status({ forced: true }) })} plainTextMode={false} />);
    expect(screen.queryByTestId('proofreading-composer-switch')).toBeNull();
    expect(screen.getByText('panel.required')).toBeInTheDocument();
  });

  it('says why nothing is checked for a protected message', () => {
    const p = proofreading({ panel: { focusKey: null }, status: status({ paused: { protected: true, reason: 'encrypt', pluginName: 'S/MIME' }, count: 0 }) });
    render(<ProofreadingStatus proofreading={p} plainTextMode={false} />);
    expect(screen.getByTestId('proofreading-status').textContent).toContain('status.paused');
    expect(screen.getByText('panel.paused_protected')).toBeInTheDocument();
    expect(screen.queryByTestId('proofreading-issue-list')).toBeNull();
  });

  it('lists issues that jump to the text, each read out with its first suggestion', () => {
    const p = proofreading({ panel: { focusKey: null } });
    render(<ProofreadingStatus proofreading={p} plainTextMode={false} />);
    const item = screen.getByRole('button', { name: /^list_item/ });
    fireEvent.click(item);
    expect(p.jumpTo).toHaveBeenCalledWith(expect.objectContaining({ key: issue().key }));
  });

  it('focuses the issue asked for when the list opens from the keyboard', () => {
    const p = proofreading({ panel: { focusKey: issue().key } });
    render(<ProofreadingStatus proofreading={p} plainTextMode={false} />);
    expect(document.activeElement?.getAttribute('data-issue-key')).toBe(issue().key);
  });

  it('names the control with what it is about, and groups each plain-text issue', () => {
    render(<ProofreadingStatus proofreading={proofreading({ panel: { focusKey: null } })} plainTextMode />);
    expect(screen.getByTestId('proofreading-status').getAttribute('aria-label')).toBe('status.issues, status.title');
    expect(screen.getByRole('group', { name: /list_item/ })).toBeInTheDocument();
  });

  it('does not read out "no issues" when a message opens with none', () => {
    render(<ProofreadingStatus proofreading={proofreading({ status: status({ count: 0 }), issues: [] })} plainTextMode={false} />);
    expect(announce).not.toHaveBeenCalled();
  });

  it('in plain text, puts the suggestions in the list', () => {
    const p = proofreading({ panel: { focusKey: null } });
    render(<ProofreadingStatus proofreading={p} plainTextMode />);
    fireEvent.click(screen.getByTestId('proofreading-replacement'));
    expect(p.apply).toHaveBeenCalledWith(expect.objectContaining({ key: issue().key }), 'den');
  });
});

describe('IssuePopup', () => {
  const props = (over: Partial<React.ComponentProps<typeof IssuePopup>> = {}) => ({
    state: { key: issue().key, anchor: new DOMRect(10, 10, 30, 16), via: 'click' as const },
    issue: issue(), anchor: () => null, onApply: vi.fn(() => true), onDismiss: vi.fn(), onClose: vi.fn(),
    onNavigate: vi.fn(), textRoot: () => null, container: document.body, ...over,
  });

  it('puts in a suggestion, and says so when the text changed meanwhile', () => {
    const p = props({ onApply: vi.fn(() => false) });
    render(<IssuePopup {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'popup.replace_with' }));
    expect(p.onApply).toHaveBeenCalledWith(expect.objectContaining({ key: issue().key }), 'den');
    expect(screen.getByRole('alert').textContent).toBe('popup.changed');
  });

  it('offers the dictionary for spelling only, and the rule only when there is one', () => {
    const { rerender } = render(<IssuePopup {...props()} />);
    expect(screen.queryByText('popup.add_to_dictionary')).toBeNull();
    expect(screen.getByText('popup.disable_rule')).toBeInTheDocument();
    rerender(<IssuePopup {...props({ issue: issue({ kind: 'spelling' }, { kind: 'spelling', ruleId: undefined }) })} />);
    expect(screen.getByText('popup.add_to_dictionary')).toBeInTheDocument();
    expect(screen.queryByText('popup.disable_rule')).toBeNull();
  });

  it('takes the focus when opened from the keyboard, moves with the arrows and closes on Escape', () => {
    const p = props({ state: { key: issue().key, anchor: null, via: 'keyboard' } });
    render(<IssuePopup {...p} />);
    const replacement = screen.getByRole('button', { name: 'popup.replace_with' });
    expect(document.activeElement).toBe(replacement);
    fireEvent.keyDown(replacement, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('popup.ignore');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(p.onClose).toHaveBeenCalledWith(true);
  });

  it('goes back to the text on Tab past its last button or Shift+Tab before its first', () => {
    const p = props({ state: { key: issue().key, anchor: null, via: 'keyboard' } });
    render(<IssuePopup {...p} />);
    const items = screen.getByTestId('proofreading-popup').querySelectorAll<HTMLElement>('[data-popup-item]');
    fireEvent.keyDown(items[0], { key: 'Tab', shiftKey: true });
    expect(p.onClose).toHaveBeenCalledWith(true);
    vi.mocked(p.onClose).mockClear();
    items[items.length - 1].focus();
    fireEvent.keyDown(items[items.length - 1], { key: 'Tab' });
    expect(p.onClose).toHaveBeenCalledWith(true);
  });

  it('steps to the next issue with the shortcut and is described by its message', () => {
    const p = props({ state: { key: issue().key, anchor: null, via: 'keyboard' } });
    render(<IssuePopup {...p} />);
    fireEvent.keyDown(document.activeElement!, { key: "'", code: 'Quote', ctrlKey: true });
    expect(p.onNavigate).toHaveBeenCalledWith(1);
    const dialog = screen.getByTestId('proofreading-popup');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toContain('Did you mean');
  });

  it('leaves the focus in the text when opened with the mouse', () => {
    render(<IssuePopup {...props()} />);
    expect(screen.getByTestId('proofreading-popup').contains(document.activeElement)).toBe(false);
  });
});

describe('ProofreadingNotice', () => {
  it('shows once per checker plugin, worded as the organisation\'s choice when required', () => {
    const { rerender, container } = render(<ProofreadingNotice status={status({ forced: true })} />);
    expect(screen.getByTestId('proofreading-notice').textContent).toContain('notice.forced');
    fireEvent.click(screen.getByText('notice.ok'));
    expect(useSettingsStore.getState().proofreadingNoticeSeen).toEqual({ lt: true });
    rerender(<ProofreadingNotice status={status({ forced: true })} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('editor attributes', () => {
  it('sets spellcheck and lang on the editing area', () => {
    expect(editorA11yAttributes({ spellcheck: false, lang: 'de-DE' })).toMatchObject({ spellcheck: 'false', lang: 'de-DE' });
    expect(editorA11yAttributes({})).toMatchObject({ spellcheck: 'true' });
    expect(editorA11yAttributes({})).not.toHaveProperty('lang');
  });
});
