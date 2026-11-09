'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Search, Star, FileText, Settings } from '@/components/icons';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useTemplateStore } from '@/stores/template-store';
import { useAuthStore } from '@/stores/auth-store';
import { useTemplateSources } from '@/hooks/use-template-sources';
import {
  filterTemplates,
  getPlaceholdersFromTemplate,
  getAutoFilledPlaceholders,
} from '@/lib/template-utils';
import type { TemplateSource } from '@/lib/templates/template-sources';
import { builtInTemplates } from '@/lib/templates/built-in-templates';
import { refreshAccountTemplates, resolveAccountId } from '@/lib/templates/personal-templates';
import { refreshTeamTemplates } from '@/lib/templates/team-templates';
import { PlaceholderFillModal } from './placeholder-fill-modal';
import { TemplateManagerModal } from './template-manager-modal';
import type { EmailTemplate } from '@/lib/template-types';

interface TemplatePickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (template: EmailTemplate, filledValues: Record<string, string>) => void;
  /**
   * The signed-in account the message is written from: its own templates,
   * its team templates and its organisation library. The active one when
   * left out.
   */
  accountId?: string | null;
}

export function TemplatePicker({ isOpen, onClose, onSelect, accountId }: TemplatePickerProps) {
  const t = useTranslations('templates');
  const tOrg = useTranslations('org_templates');
  const locale = useLocale();

  const recordUsage = useTemplateStore((s) => s.recordUsage);
  const recentTemplateIds = useTemplateStore((s) => s.recentTemplateIds);
  const { primaryIdentity } = useAuthStore();
  const { sources } = useTemplateSources(accountId);
  // The examples that come with the app (an accessible layout), read-only.
  const examples = useMemo(() => builtInTemplates((key) => t(`builtin.${key}`)), [t]);
  const examplesSource: TemplateSource = useMemo(
    () => ({ key: 'examples', kind: 'personal', templates: examples, editable: false, locked: false }),
    [examples],
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [showFillModal, setShowFillModal] = useState(false);

  // What another device or a team member changed shows up when the picker opens.
  useEffect(() => {
    if (!isOpen) return;
    refreshAccountTemplates(accountId);
    const id = resolveAccountId(accountId);
    if (id) refreshTeamTemplates(id);
  }, [isOpen, accountId]);

  // "Manage templates" (MAIL-31): the template manager in place of the
  // picker, which comes back when it closes.
  const [showManager, setShowManager] = useState(false);

  const handleSelectTemplate = (template: EmailTemplate, source: TemplateSource) => {
    const placeholders = getPlaceholdersFromTemplate(template);
    // Recently used lists the user's own templates only.
    if (source.kind === 'personal' && source !== examplesSource) recordUsage(template.id);

    if (placeholders.length > 0) {
      setSelectedTemplate(template);
      setShowFillModal(true);
    } else {
      onSelect(template, {});
    }
  };

  const finishSelection = (values: Record<string, string>) => {
    if (selectedTemplate) {
      onSelect(selectedTemplate, values);
    }
    setShowFillModal(false);
    setSelectedTemplate(null);
  };

  if (!isOpen) return null;

  const autoFilled = getAutoFilledPlaceholders({
    senderName: primaryIdentity?.name,
    locale,
  });

  const renderTemplateItem = (template: EmailTemplate, source: TemplateSource) => (
    <button
      key={`${source.key}:${template.id}`}
      type="button"
      onClick={() => handleSelectTemplate(template, source)}
      className="w-full text-start p-3 rounded-md hover:bg-muted transition-colors group"
    >
      <div className="flex items-center gap-2 min-w-0">
        {source.kind === 'personal' && template.isFavorite && source !== examplesSource && (
          <Star className="w-3 h-3 fill-amber-400 text-amber-400 flex-shrink-0" />
        )}
        <span className="text-sm font-medium text-foreground truncate">
          {template.name}
        </span>
        {template.category && (
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium flex-shrink-0 max-w-[40%] truncate">
            {template.category}
          </span>
        )}
      </div>
      {/* Not the name a second time ("Meeting follow-up / Meeting follow-up"). */}
      {template.subject && template.subject.trim() !== template.name.trim() && (
        <p className="text-xs text-muted-foreground truncate mt-1">
          {template.subject}
        </p>
      )}
      {/* Who the template addresses, before it is put into the message. */}
      {(template.defaultRecipients?.to?.length || template.defaultRecipients?.cc?.length) ? (
        <p className="text-xs text-muted-foreground truncate mt-1" data-testid="template-recipients">
          {[
            template.defaultRecipients?.to?.length ? tOrg('preview_to', { list: template.defaultRecipients.to.join(', ') }) : null,
            template.defaultRecipients?.cc?.length ? tOrg('preview_cc', { list: template.defaultRecipients.cc.join(', ') }) : null,
          ].filter(Boolean).join(' · ')}
        </p>
      ) : null}
    </button>
  );

  const renderSection = (title: string, items: EmailTemplate[], source: TemplateSource, withHeading = true) => {
    if (items.length === 0) return null;
    return (
      <div className="mb-4" key={`${source.key}:${title}`}>
        {withHeading && (
          <h3 className="text-xs font-semibold text-muted-foreground mb-1 px-3">
            {title}
          </h3>
        )}
        <div className="space-y-0.5">{items.map((item) => renderTemplateItem(item, source))}</div>
      </div>
    );
  };

  const sourceTitle = (source: TemplateSource) =>
    source.kind === 'organisation' ? tOrg('section_organisation')
      : source.kind === 'team' ? (source.name ?? '')
        : tOrg('section_personal');

  // The user's own templates keep their favourites, recently used and
  // categories. With team or organisation templates next to them, the
  // whole block gets a heading of its own.
  const renderPersonal = (source: TemplateSource, withHeading: boolean) => {
    const templates = source.templates;
    const favorites = templates.filter((tpl) => tpl.isFavorite);
    const favoriteIds = new Set(favorites.map((f) => f.id));
    const recent = recentTemplateIds
      .map((id) => templates.find((tpl) => tpl.id === id))
      .filter((tpl): tpl is EmailTemplate => !!tpl && !favoriteIds.has(tpl.id));
    const shownIds = new Set([...favoriteIds, ...recent.map((r) => r.id)]);
    const byCategory: Record<string, EmailTemplate[]> = {};
    for (const tpl of templates) {
      if (shownIds.has(tpl.id)) continue;
      (byCategory[tpl.category || ''] ??= []).push(tpl);
    }
    const body = (
      <>
        {renderSection(t('section_favorites'), favorites, source)}
        {renderSection(t('section_recent'), recent, source)}
        {Object.entries(byCategory)
          .filter(([cat]) => cat !== '')
          .map(([cat, items]) => renderSection(cat, items, source))}
        {/* "Other" only sets them apart from favourites, recent or categories. */}
        {renderSection(t('section_uncategorized'), byCategory[''] ?? [], source,
          favorites.length > 0 || recent.length > 0 || Object.keys(byCategory).some((cat) => cat !== ''))}
      </>
    );
    if (!withHeading) return <div key={source.key}>{body}</div>;
    if (templates.length === 0) return null;
    return (
      <section key={source.key} data-testid="template-source-personal" aria-label={sourceTitle(source)} className="mb-2">
        <h2 className="text-sm font-semibold text-foreground px-3 pt-1 pb-2">{sourceTitle(source)}</h2>
        {body}
      </section>
    );
  };

  const renderShared = (source: TemplateSource, items: EmailTemplate[]) => {
    if (items.length === 0) return null;
    return (
      <section key={source.key} data-testid={`template-source-${source.kind}`} aria-label={sourceTitle(source)} className="mb-2">
        <h2 className="text-sm font-semibold text-foreground px-3 pt-1 pb-2 truncate">{sourceTitle(source)}</h2>
        <div className="space-y-0.5 mb-4">{items.map((item) => renderTemplateItem(item, source))}</div>
      </section>
    );
  };

  // Under a heading of the same level as the categories, after everything else.
  const renderExamples = (items: EmailTemplate[]) => {
    if (items.length === 0) return null;
    return (
      <section key="examples" data-testid="template-source-examples" aria-label={t('section_examples')} className="mb-2">
        <h3 className="text-xs font-semibold text-muted-foreground mb-1 px-3">{t('section_examples')}</h3>
        <div className="space-y-0.5">{items.map((item) => renderTemplateItem(item, examplesSource))}</div>
      </section>
    );
  };

  const total = sources.reduce((n, source) => n + source.templates.length, 0);
  // Only the user's own templates: the picker looks as it always did.
  const onlyPersonal = sources.every((source) => source.kind === 'personal' || source.templates.length === 0);

  const results = searchQuery
    ? sources.map((source) => ({ source, items: filterTemplates(source.templates, searchQuery) }))
    : null;
  const exampleResults = searchQuery ? filterTemplates(examples, searchQuery) : examples;
  const resultCount = (results?.reduce((n, r) => n + r.items.length, 0) ?? 0) + exampleResults.length;

  return (
    <>
      <Dialog
        isOpen={!showFillModal && !showManager}
        onClose={onClose}
        title={t('picker_title')}
        className="max-h-[70vh]"
        bodyClassName="px-0 pb-0 mt-3 border-t border-border"
        footer={
          <Button variant="outline" size="sm" className="me-auto mt-3 gap-2" onClick={() => setShowManager(true)}>
            <Settings className="w-4 h-4" />
            {t('manage')}
          </Button>
        }
      >
        {/* The mail shortcuts behind the dialog must not see its keys. */}
        <div onKeyDown={(e) => e.stopPropagation()}>

          <div className="px-4 py-2 border-b border-border">
            <div className="relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                aria-label={t('search_placeholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('search_placeholder')}
                className="ps-9 h-9"
                autoFocus
              />
            </div>
          </div>

          <div className="overflow-y-auto max-h-[calc(70vh-120px)] p-2">
            {total === 0 && (
              <div className="flex flex-col items-center py-8 text-muted-foreground">
                <FileText className="w-8 h-8 mb-2 opacity-40" />
                <p className="text-sm">{t('no_templates')}</p>
              </div>
            )}

            {results ? (
              resultCount > 0 ? (
                onlyPersonal ? (
                  <div className="space-y-0.5">
                    {results.flatMap(({ source, items }) => items.map((item) => renderTemplateItem(item, source)))}
                  </div>
                ) : (
                  results.map(({ source, items }) => renderShared(source, items))
                )
              ) : (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  {t('no_results')}
                </div>
              )
            ) : (
              sources.map((source) => source.kind === 'personal'
                ? renderPersonal(source, !onlyPersonal)
                : renderShared(source, source.templates))
            )}
            {(!results || resultCount > 0) && renderExamples(exampleResults)}
          </div>
        </div>
      </Dialog>

      {showManager && <TemplateManagerModal isOpen accountId={accountId} onClose={() => setShowManager(false)} />}

      {showFillModal && selectedTemplate && (
        <PlaceholderFillModal
          template={selectedTemplate}
          placeholders={getPlaceholdersFromTemplate(selectedTemplate)}
          autoFilled={autoFilled}
          onConfirm={finishSelection}
          onSkip={() => finishSelection({})}
          onClose={() => {
            setShowFillModal(false);
            setSelectedTemplate(null);
          }}
        />
      )}
    </>
  );
}
