"use client";

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FolderSearch, Plus, Pencil } from '@/components/icons';
import { useSettingsStore } from '@/stores/settings-store';
import { smartFolderMailboxId, type SmartFolder } from '@/lib/smart-folder-types';
import { SmartFolderEditor } from '@/components/mail/smart-folder-editor';

export function SmartFolderSection({ selectedMailbox, onSelect, collapsed }: {
  selectedMailbox: string | null; onSelect?: (id: string) => void; collapsed: boolean;
}) {
  const t = useTranslations('smart_folders');
  const folders = useSettingsStore((s) => s.smartFolders);
  const [editor, setEditor] = useState<SmartFolder | 'new' | null>(null);
  const visible = [...folders].sort((a, b) => a.order - b.order);
  return <>
    {visible.length > 0 && <section aria-label={t('title')} className="mt-3">
      {!collapsed && <h2 className="px-3 py-1 text-sm font-medium text-muted-foreground">{t('title')}</h2>}
      {visible.map((folder) => <div key={folder.id} className="flex items-center px-2">
        <button type="button" disabled={!folder.enabled} title={folder.name}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-sm hover:bg-accent aria-[current=page]:bg-accent"
          aria-current={selectedMailbox === smartFolderMailboxId(folder.id) ? 'page' : undefined}
          onClick={() => onSelect?.(smartFolderMailboxId(folder.id))}>
          <FolderSearch className="size-4 shrink-0" />{!collapsed && <span className="truncate">{folder.name}</span>}
        </button>
        {!collapsed && <button type="button" className="rounded p-2 hover:bg-accent" aria-label={t('edit_named', { name: folder.name })}
          onClick={() => setEditor(folder)}><Pencil className="size-3" /></button>}
      </div>)}
    </section>}
    <button type="button" className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
      title={t('create')} onClick={() => setEditor('new')} aria-label={t('create')}>
      <Plus className="size-4" />{!collapsed && t('create')}
    </button>
    {editor && <SmartFolderEditor folder={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} />}
  </>;
}
