"use client";

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings-store';
import { isSmartFolder } from '@/lib/smart-folder-schema';
import type { SmartFolder, SmartFolderCondition } from '@/lib/smart-folder-types';

const inputClass = 'w-full rounded border border-border bg-background px-2 py-1.5 text-foreground';
const fields = ['hasAttachment', 'from', 'subject', 'after', 'before'] as const;

export function SmartFolderEditor({ folder, onClose }: { folder?: SmartFolder; onClose: () => void }) {
  const t = useTranslations('smart_folders');
  const save = useSettingsStore((s) => s.saveSmartFolder);
  const remove = useSettingsStore((s) => s.removeSmartFolder);
  const [draft, setDraft] = useState<SmartFolder>(() => folder ?? {
    id: crypto.randomUUID(), name: '', enabled: true,
    order: Math.max(-1, ...useSettingsStore.getState().smartFolders.map((f) => f.order)) + 1,
    scope: 'active-account', match: 'all', conditions: [{ field: 'hasAttachment', value: true }],
  });
  const [error, setError] = useState(false);
  const condition = (index: number, next: SmartFolderCondition) => setDraft((d) => ({
    ...d, conditions: d.conditions.map((c, i) => i === index ? next : c),
  }));
  return <Dialog isOpen onClose={onClose} title={folder ? t('edit') : t('create')} size="lg"
    onSubmit={(event) => {
      event.preventDefault();
      const next = { ...draft, name: draft.name.trim() };
      if (!isSmartFolder(next) || !save(next)) { setError(true); return; }
      onClose();
    }}
    footer={<>
      {folder && <Button type="button" variant="outline" onClick={() => { remove(folder.id); onClose(); }}>{t('delete')}</Button>}
      <Button type="button" variant="outline" onClick={onClose}>{t('cancel')}</Button>
      <Button type="submit">{t('save')}</Button>
    </>}>
    <p className="text-sm text-muted-foreground mb-3">{t('description')}</p>
    <label className="block mb-3">{t('name')}
      <input className={inputClass} required maxLength={100} value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
    </label>
    <label className="block mb-3">{t('match')}
      <select className={inputClass} value={draft.match} onChange={(e) => setDraft({ ...draft, match: e.target.value as SmartFolder['match'] })}>
        {(['all', 'any', 'not'] as const).map((match) => <option key={match} value={match}>{t(match)}</option>)}
      </select>
    </label>
    <div className="space-y-2">
      {draft.conditions.map((c, index) => <div key={index} className="flex gap-2">
        <select className={inputClass} aria-label={t('condition')} value={c.field} onChange={(e) => {
          const field = e.target.value as SmartFolderCondition['field'];
          condition(index, field === 'hasAttachment' ? { field, value: true } : { field, value: '' });
        }}>
          {fields.map((field) => <option key={field} value={field}>{t(field)}</option>)}
        </select>
        {c.field === 'hasAttachment'
          ? <select className={inputClass} aria-label={t('value')} value={String(c.value)}
              onChange={(e) => condition(index, { field: 'hasAttachment', value: e.target.value === 'true' })}>
              <option value="true">{t('yes')}</option><option value="false">{t('no')}</option>
            </select>
          : <input className={inputClass} aria-label={t('value')} required maxLength={500}
              type={c.field === 'after' || c.field === 'before' ? 'date' : 'text'} value={c.value}
              onChange={(e) => condition(index, { field: c.field, value: e.target.value })} />}
        <Button type="button" variant="outline" aria-label={t('remove_condition')} disabled={draft.conditions.length === 1}
          onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, i) => i !== index) })}>−</Button>
      </div>)}
    </div>
    <Button type="button" variant="outline" className="mt-3" disabled={draft.conditions.length >= 20}
      onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { field: 'hasAttachment', value: true }] })}>{t('add_condition')}</Button>
    {error && <p role="alert">{t('invalid')}</p>}
  </Dialog>;
}
