'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, Pencil, Trash2, Star, Copy, CopyPlus, Search, Eye } from '@/components/icons';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { useDiscardChanges } from '@/components/settings/use-discard-changes';
import { TemplateForm } from './template-form';
import { TemplateBodyPreview } from './template-body-preview';
import { useTemplateSources } from '@/hooks/use-template-sources';
import { useTemplateSourceActions, type TemplateSaveResult } from '@/hooks/use-template-source-actions';
import { OrgLockedNote } from '@/components/settings/org-locked-note';
import { filterTemplates } from '@/lib/template-utils';
import { PERSONAL_SOURCE, type TemplateSource } from '@/lib/templates/template-sources';
import { refreshAccountTemplates, resolveAccountId } from '@/lib/templates/personal-templates';
import { refreshTeamTemplates } from '@/lib/templates/team-templates';
import type { EmailTemplate } from '@/lib/template-types';

interface TemplateManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The signed-in account whose templates are managed; the active one when left out. */
  accountId?: string | null;
}

type TemplateData = Omit<EmailTemplate, 'id' | 'createdAt' | 'updatedAt'>;

const PANEL_ID = 'template-source-panel';
const tabId = (key: string) => `template-source-tab-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

export function TemplateManagerModal({ isOpen, onClose, accountId }: TemplateManagerModalProps) {
  const t = useTranslations('templates');
  const tSettings = useTranslations('settings.templates');
  const tCommon = useTranslations('common');
  const tOrg = useTranslations('org_templates');

  const { sources, personalHidden } = useTemplateSources(accountId);
  const actions = useTemplateSourceActions(accountId);

  const [selectedKey, setSelectedKey] = useState<string>(PERSONAL_SOURCE);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirmDiscard, discardDialog } = useDiscardChanges();
  const { dialogProps: deleteDialogProps, confirm: confirmDelete } = useConfirmDialog();

  const source: TemplateSource | undefined = sources.find((s) => s.key === selectedKey) ?? sources[0];
  const personal = sources.find((s) => s.kind === 'personal');
  const formOpen = isCreating || !!editingId;

  const closeForm = () => {
    setIsCreating(false);
    setEditingId(null);
    setFormDirty(false);
    setError(null);
  };

  useEffect(() => {
    if (!isOpen) return;
    refreshAccountTemplates(accountId);
    const id = resolveAccountId(accountId);
    if (id) refreshTeamTemplates(id);
  }, [isOpen, accountId]);

  // Escape, the X and Cancel ask first while the form holds changes (R5).
  const requestClose = async () => {
    if (!(await confirmDiscard(formDirty))) return;
    closeForm();
    onClose();
  };
  const requestCloseForm = async () => {
    if (!(await confirmDiscard(formDirty))) return;
    closeForm();
  };

  const selectSource = (key: string) => {
    setSelectedKey(key);
    closeForm();
    setPreviewId(null);
  };

  const sourceTitle = (s: TemplateSource) =>
    s.kind === 'organisation' ? tOrg('section_organisation')
      : s.kind === 'team' ? (s.name ?? '')
        : tOrg('section_personal');

  const errorText = (result: TemplateSaveResult) =>
    result === 'too-large' ? tOrg('save_failed_too_large')
      : result === 'no-room' ? tOrg('save_failed_no_room')
        : result === 'forbidden' ? tOrg('save_failed_forbidden')
          : result === 'conflict' ? tOrg('save_failed_conflict')
            : tOrg('save_failed');

  // A failed save keeps the form open with what the user typed.
  const run = async (step: () => Promise<TemplateSaveResult>, after: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const result = await step();
      if (result === 'ok') after();
      else setError(errorText(result));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = (data: TemplateData) => {
    if (!source?.editable) return;
    if (editingId) void run(() => actions.update(source, editingId, data), closeForm);
    else void run(() => actions.add(source, data), closeForm);
  };

  const handleDelete = async (template: EmailTemplate) => {
    if (!source?.editable) return;
    const ok = await confirmDelete({
      title: t('delete_title'),
      message: t('delete_message', { name: template.name }),
      confirmText: tCommon('delete'),
      cancelText: tCommon('cancel'),
      variant: 'destructive',
    });
    if (ok) await run(() => actions.remove(source, template.id), () => {});
  };

  const templates = source?.templates ?? [];
  const filtered = searchQuery ? filterTemplates(templates, searchQuery) : templates;
  const editable = !!source?.editable;
  const isPersonal = source?.kind === 'personal';
  const showTabs = sources.length > 1 || personalHidden;

  let note: React.ReactNode = null;
  if (source?.kind === 'organisation') {
    note = <p className="text-xs text-muted-foreground">{tOrg('organisation_note')}</p>;
  } else if (source?.kind === 'team') {
    note = source.locked
      ? <OrgLockedNote />
      : <p className="text-xs text-muted-foreground">{source.editable ? tOrg('team_note', { name: source.name ?? '' }) : tOrg('team_read_only')}</p>;
  }

  return (
    <>
      <Dialog
        isOpen={isOpen}
        onClose={() => void requestClose()}
        title={tSettings('title')}
        size="lg"
        dirty={formDirty}
        testId="template-manager"
      >
        {/* The mail shortcuts behind the dialog must not see its keys. */}
        <div onKeyDown={(e) => e.stopPropagation()}>
        {showTabs && (
          <div
            role="tablist"
            aria-label={tOrg('sources_label')}
            className="flex flex-wrap gap-2 mb-3"
            data-testid="template-sources"
            onKeyDown={(e) => {
              // Arrow keys, Home and End move between the lists, as in any tab list.
              const index = sources.findIndex((s) => s.key === source?.key);
              const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? index + 1
                : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? index - 1
                  : e.key === 'Home' ? 0
                    : e.key === 'End' ? sources.length - 1
                      : null;
              if (next === null || sources.length === 0) return;
              e.preventDefault();
              const target = sources[(next + sources.length) % sources.length];
              selectSource(target.key);
              document.getElementById(tabId(target.key))?.focus();
            }}
          >
            {sources.map((s) => (
              <button
                key={s.key}
                id={tabId(s.key)}
                type="button"
                role="tab"
                aria-selected={s.key === source?.key}
                aria-controls={PANEL_ID}
                tabIndex={s.key === source?.key ? 0 : -1}
                data-testid={`template-source-tab-${s.kind}`}
                onClick={() => selectSource(s.key)}
                className={cn(
                  'max-w-full truncate rounded-full border px-3 py-1 text-sm transition-colors',
                  s.key === source?.key
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
              >
                {sourceTitle(s)} <span className="text-xs opacity-70">{s.templates.length}</span>
              </button>
            ))}
          </div>
        )}

        <div
          id={PANEL_ID}
          role={showTabs ? 'tabpanel' : undefined}
          aria-labelledby={showTabs && source ? tabId(source.key) : undefined}
        >
        {note && <div className="mb-4" data-testid="template-source-note">{note}</div>}

        {!source && (
          <EmptyState icon={FileText} title={tSettings('no_templates')} />
        )}

        {source && !formOpen && (
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="flex-1 min-w-40 relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('search_placeholder')}
                aria-label={t('search_placeholder')}
                className="ps-9"
              />
            </div>
            {editable && (
              <Button onClick={() => { setIsCreating(true); setError(null); }} size="sm">
                {tSettings('add')}
              </Button>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400" data-testid="template-save-error">{error}</p>
        )}

        {editable && isCreating && (
          <div className="mb-6 p-4 border border-border rounded-lg bg-muted/30">
            <h3 className="text-sm font-semibold mb-4">{tSettings('add')}</h3>
            <TemplateForm
              categorySource={templates}
              shared={!isPersonal}
              busy={busy}
              onSave={handleSave}
              onCancel={() => void requestCloseForm()}
              onDirtyChange={setFormDirty}
            />
          </div>
        )}

        {editable && editingId && (
          <div className="mb-6 p-4 border border-border rounded-lg bg-muted/30">
            <h3 className="text-sm font-semibold mb-4">{tSettings('edit')}</h3>
            <TemplateForm
              template={templates.find((tpl) => tpl.id === editingId)}
              categorySource={templates}
              shared={!isPersonal}
              busy={busy}
              onSave={handleSave}
              onCancel={() => void requestCloseForm()}
              onDirtyChange={setFormDirty}
            />
          </div>
        )}

        <div className="space-y-2">
          {source && filtered.map((template) => (
            <div key={template.id} className="rounded-md border border-border hover:bg-muted/50 transition-colors" data-testid="template-row">
              <div className="flex flex-wrap items-center gap-2 p-3 sm:flex-nowrap sm:gap-3">
                {isPersonal && (
                  <IconButton
                    label={tSettings('favorite')}
                    aria-pressed={!!template.isFavorite}
                    onClick={() => void actions.toggleFavorite(source, template.id)}
                    className="flex-shrink-0 -ms-1.5"
                  >
                    <Star
                      className={cn(
                        'w-4 h-4 transition-colors',
                        template.isFavorite ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground'
                      )}
                    />
                  </IconButton>
                )}

                {/* On a phone the actions go under the name instead of squeezing it. */}
                <div className="flex-1 min-w-0 max-sm:basis-[calc(100%-3rem)]">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate" dir="auto" title={template.name}>
                      {template.name}
                    </p>
                    {template.category && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium flex-shrink-0 max-w-[40%] truncate">
                        {template.category}
                      </span>
                    )}
                  </div>
                  {template.subject && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5" dir="auto" title={template.subject}>
                      {template.subject}
                    </p>
                  )}
                  {isPersonal && actions.localOnly[template.id] && (
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-1" data-testid="template-local-only">
                      {actions.localOnly[template.id] === 'too-large' ? tOrg('local_only_too_large') : tOrg('local_only_no_room')}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1 flex-shrink-0 max-sm:ms-auto">
                  {editable ? (
                    <>
                      <IconButton
                        label={tSettings('edit')}
                        onClick={() => { setEditingId(template.id); setIsCreating(false); setError(null); }}
                        disabled={formOpen}
                        className="pointer-coarse:h-11 pointer-coarse:w-11"
                      >
                        <Pencil />
                      </IconButton>
                      <IconButton
                        label={t('duplicate')}
                        onClick={() => void run(() => actions.duplicate(source, template.id, t('copy_suffix')), () => {})}
                        disabled={formOpen || busy}
                        className="pointer-coarse:h-11 pointer-coarse:w-11"
                      >
                        <CopyPlus />
                      </IconButton>
                      <IconButton
                        label={tCommon('delete')}
                        onClick={() => void handleDelete(template)}
                        disabled={formOpen || busy}
                        className="pointer-coarse:h-11 pointer-coarse:w-11"
                      >
                        <Trash2 />
                      </IconButton>
                    </>
                  ) : (
                    <>
                      <IconButton
                        label={t('preview')}
                        onClick={() => setPreviewId(previewId === template.id ? null : template.id)}
                        aria-expanded={previewId === template.id}
                        className="pointer-coarse:h-11 pointer-coarse:w-11"
                      >
                        <Eye />
                      </IconButton>
                      {personal?.editable && (
                        <IconButton
                          label={tOrg('copy_to_personal')}
                          onClick={() => void run(() => actions.copyToPersonal(template), () => {})}
                          disabled={busy}
                          className="pointer-coarse:h-11 pointer-coarse:w-11"
                        >
                          <Copy />
                        </IconButton>
                      )}
                    </>
                  )}
                </div>
              </div>
              {previewId === template.id && (
                <div className="border-t border-border px-3 py-2" data-testid="template-preview">
                  <TemplateBodyPreview template={template} />
                </div>
              )}
            </div>
          ))}

          {source && filtered.length === 0 && !isCreating && (
            <EmptyState
              icon={FileText}
              title={searchQuery ? t('no_results') : tSettings('no_templates')}
              actions={searchQuery || !editable ? undefined : (
                <Button size="sm" onClick={() => { setIsCreating(true); setError(null); }}>{tSettings('add')}</Button>
              )}
            />
          )}
        </div>

        {isPersonal && actions.storedInAccount && (
          <p className="mt-4 text-xs text-muted-foreground" data-testid="template-storage-note">{tOrg('personal_in_account')}</p>
        )}
        </div>
        </div>
      </Dialog>
      {discardDialog}
      <ConfirmDialog {...deleteDialogProps} />
    </>
  );
}
