import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { ToastContainer } from '../toast';
import { useToastStore } from '@/stores/toast-store';
import { clearUndoHistory } from '@/lib/undo-history';
import { resetUndoDeck, showUndoCard } from '@/lib/undo-deck';

function Live() {
  const toasts = useToastStore((s) => s.toasts);
  return <ToastContainer toasts={toasts} onClose={(id) => useToastStore.getState().removeToast(id)} />;
}

const undo = () => ({ label: 'Undo', onClick: () => {} });

describe('the undo deck on screen', () => {
  beforeEach(() => {
    clearUndoHistory();
    resetUndoDeck();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('stacks each new action onto the deck that is showing', async () => {
    render(<Live />);
    await act(async () => { showUndoCard('Moved to Trash', undo(), 'First'); });
    await act(async () => { showUndoCard('Moved to Trash', undo(), 'Second'); });
    await act(async () => { showUndoCard('Moved to Trash', undo(), 'Third'); });

    expect(document.querySelectorAll('[data-deck-front]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-deck-card]')).toHaveLength(2);
  });

  it('keeps stacking once the undo history is full', async () => {
    render(<Live />);
    for (let i = 1; i <= 10; i++) await act(async () => { showUndoCard('Moved to Trash', undo(), `Old ${i}`); });
    await act(async () => { useToastStore.setState({ toasts: [] }); });
    await act(async () => { showUndoCard('Moved to Trash', undo(), 'First'); });
    await act(async () => { showUndoCard('Moved to Trash', undo(), 'Second'); });
    await act(async () => { showUndoCard('Moved to Trash', undo(), 'Third'); });

    expect(document.querySelectorAll('[data-deck-front]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-deck-card]')).toHaveLength(2);
  });
});
