import { render, act } from '@testing-library/react';
import { useState } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// The mail view renders on every open and every list update. The sidebar
// (the whole folder tree) only renders again when one of its props changes.

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn(), activeTour: null, endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/contexts/drag-drop-context', () => ({
  useDragDropContext: () => ({ isDragging: false }),
}));
// Called once per render of a folder row: the row render counter.
const useMailboxDrop = vi.fn((opts: { mailbox: { id: string } }) => { void opts; return { dropHandlers: {}, isValidDropTarget: false, isInvalidDropTarget: false }; });
vi.mock('@/hooks/use-mailbox-drop', () => ({ useMailboxDrop }));
vi.mock('@/hooks/use-tag-drop', () => ({
  useTagDrop: () => ({ dropHandlers: {}, isValidDropTarget: false }),
}));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));
// Called once per render of the sidebar itself: the render counter.
const useRouter = vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({ useRouter }));

const { Sidebar } = await import('../sidebar');
const { useSettingsStore } = await import('@/stores/settings-store');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true } },
  { id: 'sent', name: 'Sent', role: 'sent', parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true } },
  { id: 'drafts', name: 'Drafts', role: 'drafts', parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true } },
  { id: 'archive', name: 'Archive', role: 'archive', parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];
const onMailboxSelect = () => {};

describe('Sidebar re-renders', () => {
  beforeEach(() => {
    useSettingsStore.setState({ hideAccountSwitcher: true } as never);
  });

  it('skips a parent render that changes none of its props, and follows one that does', () => {
    let rerenderParent!: () => void;
    let selectFolder!: (id: string) => void;
    function Parent() {
      const [, setTick] = useState(0);
      const [selected, setSelected] = useState('inbox');
      rerenderParent = () => setTick((n) => n + 1);
      selectFolder = setSelected;
      return (
        <Sidebar mailboxes={mailboxes} selectedMailbox={selected} onMailboxSelect={onMailboxSelect} />
      );
    }
    render(<Parent />);
    const rendersAfterMount = useRouter.mock.calls.length;

    act(() => rerenderParent());
    expect(useRouter.mock.calls.length).toBe(rendersAfterMount);

    act(() => selectFolder('sent'));
    expect(useRouter.mock.calls.length).toBeGreaterThan(rendersAfterMount);
  });

  it('draws only the folder rows a click changes', () => {
    let selectFolder!: (id: string) => void;
    function Parent() {
      const [selected, setSelected] = useState('inbox');
      selectFolder = setSelected;
      return <Sidebar mailboxes={mailboxes} selectedMailbox={selected} onMailboxSelect={onMailboxSelect} />;
    }
    render(<Parent />);
    useMailboxDrop.mockClear();
    act(() => selectFolder('sent'));
    // The folder left and the folder opened; Drafts and Archive stay as drawn.
    expect(useMailboxDrop.mock.calls.map((c) => c[0].mailbox.id).sort()).toEqual(['inbox', 'sent']);
  });
});
