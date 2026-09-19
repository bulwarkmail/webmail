'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRightLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useAccountStore } from '@/stores/account-store';
import type { Email } from '@/lib/jmap/types';
import type { TransferMessage } from '@/lib/email-transfer';
import { AccountTransferDialog, resolveTransferSelection } from './account-transfer-dialog';

export function AccountTransferButton({ emails, expectedCount }: { emails: Email[]; expectedCount?: number }) {
  const t = useTranslations('account_transfer');
  const count = useAccountStore(s => s.accounts.length);
  const [selection, setSelection] = useState<TransferMessage[] | null>(null);
  if (count < 2 || !emails.length) return null;
  return <>
    <Button variant="ghost" size="sm" title={t('open')} aria-label={t('open')} onClick={() => {
      if (expectedCount !== undefined && new Set(emails.map(email => email.id)).size !== expectedCount) {
        toast.error(t('selection_changed')); return;
      }
      try { setSelection(resolveTransferSelection(emails)); }
      catch { toast.error(t('disconnected')); }
    }}><ArrowRightLeft className="h-4 w-4" /></Button>
    {selection && <AccountTransferDialog selection={selection} onClose={() => setSelection(null)} />}
  </>;
}
