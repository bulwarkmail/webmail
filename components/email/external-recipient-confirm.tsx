'use client';

import { useEffect, useId, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Building } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { registerExternalRecipientCheck } from '@/lib/outgoing/external-recipients';
import { useExternalRecipientConfirmStore } from '@/stores/external-recipient-confirm-store';
import { ModalWindow } from '@/components/ui/dialog-surface';

/**
 * "Send outside your organisation?", asked once per send with every
 * external recipient listed. Mounted once in the app layout; while it is
 * mounted the pre-send check is registered, so the composer and quick reply
 * both ask through it. Sits above the composer like the plugin dialogs.
 */
export function ExternalRecipientConfirmHost() {
  const t = useTranslations('external_mail');
  const pending = useExternalRecipientConfirmStore((s) => s.pending);
  const answer = useExternalRecipientConfirmStore((s) => s.answer);
  const id = useId();

  useEffect(() => registerExternalRecipientCheck(), []);

  // A send can't be waiting on a dialog that is gone.
  useEffect(() => () => useExternalRecipientConfirmStore.getState().cancelAll(), []);

  // Escape is handled below with the other keys, not by the trap: one key, one answer.
  const dialogRef = useFocusTrap({ isActive: !!pending, restoreFocus: true });

  // Keys stay in the dialog: Escape must not also close the message behind
  // it, j/k must not move the list, Enter must not open a message. Enter and
  // Space press the focused button here, whatever a page listener did.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      answer(false);
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).tagName === 'BUTTON') {
      e.preventDefault();
      (e.target as HTMLButtonElement).click();
    }
  };

  if (!pending) return null;
  const { recipients } = pending;
  const field = { to: t('field_to'), cc: t('field_cc'), bcc: t('field_bcc') };

  return (
    <ModalWindow title={t('confirm_title')} onClose={() => answer(false)}>
      <div
        data-modal-backdrop="" className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px] animate-in fade-in duration-150"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) answer(false);
        }}
        onKeyDown={onKeyDown}
      >
        <div
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-message`}
          data-external-recipient-confirm=""
          className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl animate-in zoom-in-95 duration-200"
        >
          <div className="flex min-h-0 flex-1 flex-col px-5 pt-5 sm:px-6 sm:pt-6">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
                <Building className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id={`${id}-title`} className="text-lg font-semibold text-foreground">{t('confirm_title')}</h2>
                <p id={`${id}-message`} className="mt-1 text-sm text-muted-foreground">
                  {t('confirm_message', { count: recipients.length })}
                </p>
              </div>
            </div>
            <ul className="mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 text-sm" data-external-recipients="">
              {recipients.map((recipient) => (
                <li key={recipient.address} className="flex items-baseline gap-2">
                  <span className="w-8 flex-shrink-0 text-xs text-muted-foreground">{field[recipient.field]}</span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{recipient.address}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-4 sm:px-6">
            {/* Back comes first, so the focus trap puts the focus on it: sending outside takes a deliberate click. */}
            <Button variant="outline" onClick={() => answer(false)} data-external-recipient-back="">
              {t('back')}
            </Button>
            <Button onClick={() => answer(true)} data-external-recipient-send="">
              {t('send_anyway')}
            </Button>
          </div>
        </div>
      </div>
    </ModalWindow>
  );
}
