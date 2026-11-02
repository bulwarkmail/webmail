'use client';

import { useState, useMemo, useEffect, useId, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Star, Plus, Square, CheckSquare } from '@/components/icons';
import { ContextMenu, ContextMenuItem } from '@/components/ui/context-menu';
import { useContextMenu } from '@/hooks/use-context-menu';
import { cn } from '@/lib/utils';
import { validateTemplateName } from '@/lib/template-utils';
import { BUILT_IN_PLACEHOLDERS } from '@/lib/template-types';
import type { EmailTemplate } from '@/lib/template-types';
import { useTemplateStore } from '@/stores/template-store';
import { useAuthStore } from '@/stores/auth-store';
import { RichTextEditor } from '@/components/email/rich-text-editor';
import { plainTextToComposerBody } from '@/lib/email-composer-utils';
import { htmlToPlainText } from '@/lib/html-to-text';
import type { Editor } from '@tiptap/react';


interface TemplateFormProps {
  template?: EmailTemplate;
  initialData?: {
    subject?: string;
    body?: string;
    /** The body is the composer's HTML, not plain text (#1506). */
    isHTML?: boolean;
    to?: string[];
    cc?: string[];
    bcc?: string[];
  };
  onSave: (data: Omit<EmailTemplate, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onCancel: () => void;
  /**
   * A template others use too (a team's): no sending identity, since
   * identity ids are each member's own, and no favourite.
   */
  shared?: boolean;
  /** A save is under way: the save button waits. */
  busy?: boolean;
  /** The templates whose categories the category field suggests; the browser's list when left out. */
  categorySource?: EmailTemplate[];
  /** Told whenever the form gets or loses changes, so its host can ask before closing (R5). */
  onDirtyChange?: (dirty: boolean) => void;
}

export function TemplateForm({ template, initialData, onSave, onCancel, shared = false, busy = false, categorySource, onDirtyChange }: TemplateFormProps) {
  const t = useTranslations('templates');
  const tSettings = useTranslations('settings.templates');
  const tComposer = useTranslations('email_composer');
  // Ids that tie each visible label to its field.
  const labelIdBase = useId();
  const labelFor = (key: string) => `${labelIdBase}-${key}`;

  const { identities } = useAuthStore();
  const browserList = useTemplateStore((s) => s.templates);
  const templates = categorySource ?? browserList;

  const [name, setName] = useState(template?.name || '');
  const [category, setCategory] = useState(template?.category || '');
  const [subject, setSubject] = useState(template?.subject || initialData?.subject || '');
  const [body, setBody] = useState(template?.body || initialData?.body || '');
  const [isHTML, setIsHTML] = useState(template ? !!template.isHTML : !!initialData?.isHTML);
  // The rich editor, while the body is HTML: placeholders go in at its caret.
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
  const placeholderMenu = useContextMenu<'subject' | 'body'>();

  // Changed from what the form opened with.
  const snapshot = JSON.stringify([name, category, subject, body, isHTML, toRecipients, ccRecipients, bccRecipients, identityId, isFavorite]);
  const [initialSnapshot] = useState(snapshot);
  const dirty = snapshot !== initialSnapshot;
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  });
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

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
      identityId: shared ? undefined : identityId || undefined,
      isFavorite: shared ? false : isFavorite,
    });
  };

  const insertPlaceholder = (placeholder: string, field: 'subject' | 'body') => {
    const tag = `{{${placeholder}}}`;
    if (field === 'subject') {
      setSubject((prev) => prev + tag);
      return;
    }
    const editor = editorRef.current;
    if (isHTML && editor && !editor.isDestroyed) {
      editor.chain().focus().insertContent(tag).run();
      return;
    }
    setBody((prev) => prev + tag);
  };

  // Switching the body between plain text and HTML converts what is there,
  // so neither editor ever shows the other format's source (#1506).
  const toggleHTML = () => {
    if (isHTML) {
      editorRef.current = null;
      setBody((prev) => htmlToPlainText(prev, { paragraphSpacing: true }));
    } else {
      setBody((prev) => plainTextToComposerBody(prev));
    }
    setIsHTML(!isHTML);
  };

  const placeholderButton = (field: 'subject' | 'body') => (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-haspopup="menu"
      aria-expanded={placeholderMenu.contextMenu.isOpen && placeholderMenu.contextMenu.data === field}
      onClick={(e) => placeholderMenu.openContextMenuFrom(e.currentTarget, field, 'end')}
    >
      <Plus className="w-3.5 h-3.5 me-1" />
      {t('placeholder')}
    </Button>
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor={labelFor("name")} className="text-sm font-medium text-foreground">{tSettings('name')}</label>
        <Input
          id={labelFor("name")}
          value={name}
          onChange={(e) => { setName(e.target.value); setNameError(null); }}
          placeholder={tSettings('name_placeholder')}
          className={cn('mt-1', nameError && 'border-destructive')}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? labelFor("name-error") : undefined}
          autoFocus
        />
        {nameError && (
          <p id={labelFor("name-error")} className="text-xs text-red-600 dark:text-red-400 mt-1">
            {tSettings(`validation.${nameError}`)}
          </p>
        )}
      </div>

      <div>
        <label htmlFor={labelFor("category")} className="text-sm font-medium text-foreground">{tSettings('category')}</label>
        <Input
          id={labelFor("category")}
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
          <label htmlFor={labelFor("subject")} className="text-sm font-medium text-foreground">{tSettings('subject')}</label>
          {placeholderButton('subject')}
        </div>
        <Input
          id={labelFor("subject")}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={tSettings('subject_placeholder')}
          className="mt-1"
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label htmlFor={isHTML ? undefined : labelFor("body")} className="text-sm font-medium text-foreground">{tSettings('body')}</label>
          {placeholderButton('body')}
        </div>
        {isHTML ? (
          <div className="mt-1 rounded-md border border-border overflow-hidden" data-testid="template-body-editor">
            <RichTextEditor
              content={body}
              onChange={setBody}
              placeholder={tSettings('body_placeholder')}
              ariaLabel={tSettings('body')}
              onEditorReady={(editor) => { editorRef.current = editor; }}
            />
          </div>
        ) : (
          <textarea
            id={labelFor("body")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={tSettings('body_placeholder')}
            rows={6}
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden resize-y"
          />
        )}
        <button
          type="button"
          onClick={toggleHTML}
          aria-pressed={isHTML}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          {isHTML ? <CheckSquare className={cn('w-4 h-4')}></CheckSquare> : <Square className={cn('w-4 h-4')}></Square>}
          HTML
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label htmlFor={labelFor("to")} className="text-sm font-medium text-foreground">{tComposer('to')}</label>
          <Input
            id={labelFor("to")}
            value={toRecipients}
            onChange={(e) => setToRecipients(e.target.value)}
            placeholder={tSettings('recipients_placeholder')}
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor={labelFor("cc")} className="text-sm font-medium text-foreground">{tComposer('cc')}</label>
          <Input
            id={labelFor("cc")}
            value={ccRecipients}
            onChange={(e) => setCcRecipients(e.target.value)}
            placeholder={tSettings('recipients_placeholder')}
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor={labelFor("bcc")} className="text-sm font-medium text-foreground">{tComposer('bcc')}</label>
          <Input
            id={labelFor("bcc")}
            value={bccRecipients}
            onChange={(e) => setBccRecipients(e.target.value)}
            placeholder={tSettings('recipients_placeholder')}
            className="mt-1"
          />
        </div>
      </div>

      {!shared && identities.length > 1 && (
        <div>
          <label htmlFor={labelFor("identity")} className="text-sm font-medium text-foreground">{tSettings('identity')}</label>
          <select
            id={labelFor("identity")}
            value={identityId}
            onChange={(e) => setIdentityId(e.target.value)}
            className="mt-1 w-full px-3 py-2 text-sm rounded-md bg-background border border-border text-foreground focus:outline-hidden"
          >
            <option value="">{tSettings('default_identity')}</option>
            {identities.map((id) => (
              <option key={id.id} value={id.id} dir="ltr">
                {id.name ? `${id.name} <${id.email}>` : id.email}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        {shared ? <span /> : (
          <button
            type="button"
            onClick={() => setIsFavorite(!isFavorite)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <Star className={cn('w-4 h-4', isFavorite && 'fill-amber-400 text-amber-400')} />
            {tSettings('favorite')}
          </button>
        )}

        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {tSettings('cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {template ? tSettings('update') : tSettings('create')}
          </Button>
        </div>
      </div>
      <ContextMenu
        ref={placeholderMenu.menuRef}
        isOpen={placeholderMenu.contextMenu.isOpen}
        position={placeholderMenu.contextMenu.position}
        onClose={placeholderMenu.closeContextMenu}
      >
        {BUILT_IN_PLACEHOLDERS.map((p) => (
          <ContextMenuItem
            key={p}
            label={`{{${p}}}`}
            hint={t(`placeholders.${p}`)}
            onClick={() => {
              const field = placeholderMenu.contextMenu.data;
              placeholderMenu.closeContextMenu();
              if (field) insertPlaceholder(p, field);
            }}
          />
        ))}
      </ContextMenu>
    </form>
  );
}
