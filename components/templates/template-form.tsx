'use client';

import { useState, useMemo, useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { Editor } from '@tiptap/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RichTextEditor, type InlineImageUpload } from '@/components/email/rich-text-editor';
import { Star, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { validateTemplateName } from '@/lib/template-utils';
import { sanitizeEmailHtml, plainTextToSafeHtml } from '@/lib/email-sanitization';
import { BUILT_IN_PLACEHOLDERS } from '@/lib/template-types';
import type { EmailTemplate } from '@/lib/template-types';
import { useTemplateStore } from '@/stores/template-store';
import { useAuthStore } from '@/stores/auth-store';
import { toast } from '@/stores/toast-store';

// Inline template images are stored as base64 data URIs inside the template
// (localStorage-backed). Cap each image so a couple of logos don't blow the
// ~5 MB localStorage budget. base64 inflates bytes ~33%.
const MAX_TEMPLATE_IMAGE_BYTES = 1024 * 1024; // 1 MB


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
  // Existing HTML templates load as-is; legacy plain-text bodies are converted
  // to safe HTML so they render in the rich editor. initialData (e.g. "save as
  // template" from the composer) is already HTML.
  const initialBodyHtml = template
    ? (template.bodyIsHtml ? template.body : plainTextToSafeHtml(template.body || ''))
    : (initialData?.body || '');
  const [body, setBody] = useState(initialBodyHtml);
  const editorRef = useRef<Editor | null>(null);
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
      body: sanitizeEmailHtml(body),
      bodyIsHtml: true,
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
    } else if (editorRef.current) {
      editorRef.current.chain().focus().insertContent(tag).run();
    } else {
      setBody((prev) => prev + tag);
    }
    setShowPlaceholderMenu(null);
  };

  const handleImageUpload = useCallback(
    async (file: File): Promise<InlineImageUpload | null> => {
      if (file.size > MAX_TEMPLATE_IMAGE_BYTES) {
        toast.error(tSettings('image_too_large'));
        return null;
      }
      const dataUrl = await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve((e.target?.result as string) ?? null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
      if (!dataUrl) {
        toast.error(tComposer('upload_failed', { filename: file.name }));
        return null;
      }
      // No cid: templates have no send context. The data URI is the image;
      // the compose/send path handles inlining when the template is used.
      return { src: dataUrl };
    },
    [tSettings, tComposer],
  );

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
        <div className="mt-1">
          <RichTextEditor
            content={body}
            onChange={setBody}
            onImageUpload={handleImageUpload}
            onEditorReady={(ed) => { editorRef.current = ed; }}
            placeholder={tSettings('body_placeholder')}
            className="min-h-[180px]"
          />
        </div>
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
