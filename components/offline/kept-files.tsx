'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { formatFileSize } from '@/lib/utils';
import { useKeptFiles } from '@/hooks/use-kept-files';

/** The files this account keeps until told otherwise, in Settings > Backup & reset > Offline. */
export function KeptFiles({ account }: { account: string }) {
  const t = useTranslations('offlineStorage');
  const { pinned, unpin } = useKeptFiles(account);
  if (pinned.length === 0) return null;
  return (
    <div className="border-b border-border py-3 last:border-0" data-testid="offline-kept-files">
      <h4 className="text-sm font-medium text-foreground">{t('kept_files_title')}</h4>
      <ul className="mt-2 divide-y divide-border rounded-md border border-border" aria-label={t('kept_files_title')}>
        {pinned.map((file) => (
          <li key={`${file.jmap}:${file.id}`} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between" data-testid="offline-kept-file" data-kept={file.kept}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{file.name}</p>
              <p className="text-xs text-muted-foreground">
                {file.size !== null && <>{formatFileSize(file.size)} · </>}
                {file.kept ? t('kept_state_kept') : file.error ? t(`kept_error_${file.error}` as 'kept_error_download') : t('kept_state_waiting')}
              </p>
            </div>
            <Button variant="outline" size="sm" className="shrink-0" aria-label={t('unpin_label', { name: file.name })} onClick={() => void unpin(file)}>{t('unpin')}</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
