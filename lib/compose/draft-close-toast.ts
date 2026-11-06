import { toast, useToastStore } from "@/stores/toast-store";
import { UNDO_TOAST_DURATION } from "@/lib/email-action-toast";
import { useOfflineStore } from "@/lib/offline/state";

export interface DiscardToastLabels {
  discarded: string;
  undo: string;
}

export interface DraftSavedToastLabels extends DiscardToastLabels {
  saved: string;
  discard: string;
  /** "Open": the draft back in a composer. Without it the toast has Discard only. */
  open?: string;
}

/**
 * "Draft discarded" with Undo. `discard` runs once the toast is gone without
 * an Undo (or the page goes away), so Undo needs nothing from the server:
 * the draft is still there. `restore` puts back what the caller took off
 * screen.
 */
export function discardWithUndo(discard: () => void, labels: DiscardToastLabels, restore?: () => void): void {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const commit = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    window.removeEventListener("pagehide", commit);
    discard();
  };
  const id = toast.success(labels.discarded, {
    action: {
      label: labels.undo,
      onClick: () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        window.removeEventListener("pagehide", commit);
        restore?.();
      },
    },
    duration: UNDO_TOAST_DURATION,
    // The toast and the delete end together: a pause on hover would leave
    // an Undo on screen for a draft that is already gone.
    pauseOnHover: false,
  });
  const shown = useToastStore.getState().toasts.find((t) => t.id === id)?.duration;
  timer = setTimeout(commit, shown && shown > 0 ? shown : UNDO_TOAST_DURATION);
  window.addEventListener("pagehide", commit);
}

/**
 * After a composer closed and kept its draft: "Draft saved", with Open and
 * Discard. Open brings the draft back in a composer (see openKeptDraft).
 */
export function showDraftSavedToast(discard: () => void, labels: DraftSavedToastLabels, open?: () => void): void {
  toast.success(labels.saved, {
    action: { label: labels.discard, onClick: () => discardWithUndo(discard, labels) },
    secondaryAction: open && labels.open ? { label: labels.open, onClick: open } : undefined,
  });
}

/**
 * Open a kept draft in the mail page's composer, the way the outbox and the
 * draft list do: the mail page fetches it and opens it as an edited draft
 * (mail-app's draftToOpen). Off the mail page the caller goes there, and
 * the page opens it once it is up.
 */
export function openKeptDraft(draftId: string, where: { accountId?: string; localAccountId?: string } = {}): void {
  useOfflineStore.setState({ draftToOpen: { id: draftId, jmap: where.accountId ?? "", account: where.localAccountId ?? "" } });
}
