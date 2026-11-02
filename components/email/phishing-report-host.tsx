'use client';

import { useId, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, ShieldAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { reportEmailsAsPhishing, undoPhishingReports, type PhishingReportOutcome } from '@/lib/phishing-report-flow';
import { usePhishingReportStore } from '@/stores/phishing-report-store';
import { toast } from '@/stores/toast-store';

/**
 * "Report phishing?" with the address the report goes to, then the
 * reports, one per message, and a toast with Undo. Mounted once in the app
 * layout; every menu asks through usePhishingReportStore.
 */
export function PhishingReportHost() {
  const t = useTranslations('phishing_report');
  const pending = usePhishingReportStore((s) => s.pending);
  const busy = usePhishingReportStore((s) => s.busy);
  const id = useId();
  const dialogRef = useFocusTrap({ isActive: !!pending, restoreFocus: false });

  const cancel = () => {
    if (!busy) usePhishingReportStore.getState().close();
  };

  const showOutcome = (outcome: PhishingReportOutcome) => {
    const { reported, failed, notMoved, moved } = outcome;
    const address = outcome.addresses.join(', ');
    if (reported.length > 0) {
      const undo = moved.length > 0
        ? {
            label: t('undo'),
            onClick: () => {
              void undoPhishingReports(outcome).then((back) => {
                if (back > 0) toast.info(t('undone', { count: back }));
                else toast.error(t('undo_failed'));
              });
            },
          }
        : undefined;
      if (notMoved.length > 0) {
        toast.warning(t('not_moved', { address, count: notMoved.length }), { action: undo });
      } else {
        toast.success(t('done', { address, count: reported.length }), { action: undo });
      }
    }
    if (failed.length > 0) {
      toast.error(t('failed', { count: failed.length }), {
        message: failed.map((email) => email.subject || t('no_subject')).join(', '),
      });
    }
  };

  const confirm = async () => {
    const state = usePhishingReportStore.getState();
    if (!state.pending || state.busy) return;
    state.setBusy(true);
    let outcome: PhishingReportOutcome | null = null;
    try {
      outcome = await reportEmailsAsPhishing(state.pending.emails);
    } catch {
      outcome = null;
    }
    const emails = state.pending.emails;
    usePhishingReportStore.getState().close();
    if (outcome) showOutcome(outcome);
    else toast.error(t('failed', { count: emails.length }));
  };

  // Keys stay in the dialog (Escape must not close the message behind it,
  // j/k must not move the list); Enter and Space press the focused button.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLButtonElement) {
      e.preventDefault();
      e.target.click();
    }
  };

  if (!pending) return null;
  const count = pending.emails.length;

  return (
    <div
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px] animate-in fade-in duration-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-message`}
        aria-busy={busy || undefined}
        data-testid="phishing-report-dialog"
        className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl animate-in zoom-in-95 duration-200"
      >
        <div className="px-5 pt-5 sm:px-6 sm:pt-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <ShieldAlert className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id={`${id}-title`} className="text-lg font-semibold text-foreground">{t('confirm_title')}</h2>
              <p id={`${id}-message`} className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {t('confirm_message', { address: pending.addresses.join(', '), count })}
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-4 sm:px-6">
          <Button variant="outline" onClick={cancel} disabled={busy} data-testid="phishing-report-cancel">
            {t('cancel')}
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy} data-testid="phishing-report-confirm">
            {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {busy ? t('sending') : t('confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
