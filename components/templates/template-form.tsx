'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Star, Plus, Square, CheckSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { validateTemplateName } from '@/lib/template-utils';
import { BUILT_IN_PLACEHOLDERS } from '@/lib/template-types';
import type { EmailTemplate } from '@/lib/template-types';
import { useTemplateStore } from '@/stores/template-store';
import { useAuthStore } from '@/stores/auth-store';


interface TemplateFormProps {
  template?: EmailTemplate;
  initialData?: {
    subject?: string;
    body?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
  };
  onSave: (data: Omit<EmailTemplate, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onCancel: () => void;
}

export function TemplateForm({ template, initialData, onSave, onCancel }: TemplateFormProps) {
  const t = useTranslations('templates');
  const tSettings = useTranslations('settings.templates');
  const tComposer = useTranslations('email_composer');

  const { identities } = useAuthStore();
  const templates = useTemplateStore((s) => s.templates);

  const [name, setName] = useState(template?.name || '');
  const [category, setCategory] = useState(template?.category || '');
  const [subject, setSubject] = useState(template?.subject || initialData?.subject || '');
  const [body, setBody] = useState(template?.body || initialData?.body || '');
  const [isHTML, setIsHTML] = useState(template?.isHTML || false);
  const [toRecipients, setToRecipients] = useState(
    template?.defaultRecipients?.to?.join(', ') || initialData?.to?.join(', ') || ''
  );
  const [ccRecipients, setCcRecipients] = useState(
    template?.defaultRecipients?.cc?.join(', ') || initialData?.cc?.join(', ') || ''
  );
  const [bccRecipients, setBccRecipients] = useState(
    template?.defaultRecipients?.bcc?.join(', ') || initialData?.bcc?.join(', ') || ''
  );
  const [identityId, setIdentityId] = useState(template?.identityId || '');
  const [isFavorite, setIsFavorite] = useState(template?.isFavorite || false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [showPlaceholderMenu, setShowPlaceholderMenu] = useState<'subject' | 'body' | null>(null);

  const existingCategories = useMemo(() => {
    const cats = new Set(templates.map((t) => t.category).filter(Boolean));
    return Array.from(cats).sort();
  }, [templates]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const error = validateTemplateName(name);
    if (error) {
      setNameError(error);
      return;
    }

    const parseRecipients = (val: string) =>
      val.split(',').map((s) => s.trim()).filter(Boolean);

    const to = parseRecipients(toRecipients);
    const cc = parseRecipients(ccRecipients);
    const bcc = parseRecipients(bccRecipients);

    onSave({
      name: name.trim(),
      subject,
      body,
      isHTML,
      category: category.trim(),
      defaultRecipients: to.length || cc.length || bcc.length
        ? { to: to.length ? to : undefined, cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined }
        : undefined,
      identityId: identityId || undefined,
      isFavorite,
    });
  };

  const insertPlaceholder = (placeholder: string, field: 'subject' | 'body') => {
    const tag = `{{${placeholder}}}`;
    if (field === 'subject') {
      setSubject((prev) => prev + tag);
    } else {
      setBody((prev) => prev + tag);
    }
    setShowPlaceholderMenu(null);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="text-sm font-medium text-foreground">{tSettings('name')}</label>
        <Input
          value={name}
          onChange={(e) => { setName(e.target.value); setNameError(null); }}
          placeholder={tSettings('name_placeholder')}
          className={cn('mt-1', nameError && 'border-red-500')}
          autoFocus
        />
        {nameError && (
          <p className="text-xs text-red-600 dark:text-red-400 mt-1">
            {tSettings(`validation.${nameError}`)}
          </p>
        )}
      </div>

      <div>
        <label className="text-sm font-medium text-foreground">{tSettings('category')}</label>
        <Input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder={tSettings('category_placeholder')}
          className="mt-1"
          list="template-categories"
        />
        {existingCategories.length > 0 && (
          <datalist id="template-categories">
            {existingCategories.map((cat) => (
              <option key={cat} value={cat} />
            ))}
          </datalist>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-foreground">{tSettings('subject')}</label>
          <div className="relative">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setShowPlaceholderMenu(showPlaceholderMenu === 'subject' ? null : 'subject')}
            >
              <Plus className="w-3 h-3 me-1" />
              {t('placeholder')}
            </Button>
            {showPlaceholderMenu === 'subject' && (
              <PlaceholderDropdown
                onSelect={(p) => insertPlaceholder(p, 'subject')}
                onClose={() => setShowPlaceholderMenu(null)}
              />
            )}
          </div>
        </div>
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={tSettings('subject_placeholder')}
          className="mt-1"
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-foreground">{tSettings('body')}</label>
          <div className="relative">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setShowPlaceholderMenu(showPlaceholderMenu === 'body' ? null : 'body')}
            >
              <Plus className="w-3 h-3 me-1" />
              {t('placeholder')}
            </Button>
            {showPlaceholderMenu === 'body' && (
              <PlaceholderDropdown
                onSelect={(p) => insertPlaceholder(p, 'body')}
                onClose={() => setShowPlaceholderMenu(null)}
              />
            )}
          </div>
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={tSettings('body_placeholder')}
          rows={6}
          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary resize-y"
        />
        <button
          type="button"
          onClick={() => setIsHTML(!isHTML)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {isHTML ? <CheckSquare className={cn('w-4 h-4')}></CheckSquare> : <Square className={cn('w-4 h-4')}></Square>}
          HTML
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="text-sm font-medium text-foreground">{tComposer('to')}</label>
          <Input
            value={toRecipients}
            onChange={(e) => setToRecipients(e.target.value)}
            placeholder={tSettings('recipients_placeholder')}
            className="mt-1"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-foreground">{tComposer('cc')}</label>
          <Input
            value={ccRecipients}
            onChange={(e) => setCcRecipients(e.target.value)}
            placeholder={tSettings('recipients_placeholder')}
            className="mt-1"
          />
        </div>
        <div>
          <label className="text-sm font-medium text-foreground">{tComposer('bcc')}</label>
          <Input
            value={bccRecipients}
            onChange={(e) => setBccRecipients(e.target.value)}
            placeholder={tSettings('recipients_placeholder')}
            className="mt-1"
          />
        </div>
      </div>

      {identities.length > 1 && (
        <div>
          <label className="text-sm font-medium text-foreground">{tSettings('identity')}</label>
          <select
            value={identityId}
            onChange={(e) => setIdentityId(e.target.value)}
            className="mt-1 w-full px-3 py-2 text-sm rounded-md bg-background border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="">{tSettings('default_identity')}</option>
            {identities.map((id) => (
              <option key={id.id} value={id.id}>
                {id.name ? `${id.name} <${id.email}>` : id.email}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={() => setIsFavorite(!isFavorite)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <Star className={cn('w-4 h-4', isFavorite && 'fill-amber-400 text-amber-400')} />
          {tSettings('favorite')}
        </button>

        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {tSettings('cancel')}
          </Button>
          <Button type="submit" size="sm">
            {template ? tSettings('update') : tSettings('create')}
          </Button>
        </div>
      </div>
    </form>
  );
}

function PlaceholderDropdown({
  onSelect,
  onClose,
}: {
  onSelect: (name: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('templates');

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-md shadow-lg min-w-[180px]">
        <div className="p-1">
          {BUILT_IN_PLACEHOLDERS.map((p) => (
            <button
              key={p}
              type="button"
              className="w-full text-start px-3 py-1.5 text-sm rounded hover:bg-muted transition-colors"
              onClick={() => onSelect(p)}
            >
              <span className="font-mono text-xs text-primary">{`{{${p}}}`}</span>
              <span className="ms-2 text-muted-foreground">{t(`placeholders.${p}`)}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
