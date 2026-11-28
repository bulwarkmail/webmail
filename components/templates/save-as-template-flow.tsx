'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog } from '@/components/ui/dialog';
import { QuickSaveTemplateDialog } from '@/components/templates/quick-save-template-dialog';
import { TemplateForm } from '@/components/templates/template-form';
import { useDiscardChanges } from '@/components/settings/use-discard-changes';
import { useTemplateSources } from '@/hooks/use-template-sources';
import { inlineImageDataUrl } from '@/lib/email-composer-utils';
import type { Email } from '@/lib/jmap/types';
import { isStoredInAccount, personalTemplatesFor } from '@/lib/templates/personal-templates';
import type { TemplateData } from '@/lib/templates/template-reducer';
import { isOwnMail, isTooLargeToSync, templateDraftFromEmail, type TemplateDraftFromEmail } from '@/lib/template-from-email';
import { debug } from '@/lib/debug';
import { stripSubjectPrefixes } from '@/lib/subject-prefix';
import { useAuthStore } from '@/stores/auth-store';
import { mailboxesInView, resolveEmailBlobContext, useEmailStore } from '@/stores/email-store';
import { useSaveAsTemplateStore } from '@/stores/save-as-template-store';
import { toast } from '@/stores/toast-store';

function folderRolesOf(email: Email): string[] {
  const mailboxes = mailboxesInView(useEmailStore.getState());
  return Object.keys(email.mailboxIds ?? {})
    .map((id) => mailboxes.find((box) => box.id === id || box.originalId === id)?.role)
    .filter((role): role is string => !!role);
}

/** What the quick dialog saves: no category, recipients or identity. */
function quickData({ subject, body, isHTML }: TemplateDraftFromEmail, name: string): TemplateData {
  return { name, subject, body, isHTML, category: '', isFavorite: false };
}

/**
 * Reads `email` in full from the login and account it is in, and makes the
 * template of it. The template goes to that login's personal templates,
 * as the composer keeps a template with the account the message is written from.
 */
async function readTemplateDraft(email: Email): Promise<{ draft: TemplateDraftFromEmail; accountId: string | null } | 'not_connected'> {
  const auth = useAuthStore.getState();
  const context = resolveEmailBlobContext(email, auth.client);
  const client = context.client;
  if (!client) return 'not_connected';
  let full = email;
  // The list has no body or parts.
  if (!full.bodyValues) {
    const read = await client.getEmail(email.id, context.accountId);
    if (!read) throw new Error('The message could not be read');
    full = read;
  }
  const ownAddresses = auth.identities.map((identity) => identity.email).filter(Boolean);
  const draft = await templateDraftFromEmail(full, {
    ownMail: isOwnMail(full, folderRolesOf(email), ownAddresses),
    loadImage: async (part) => {
      const buffer = await client.fetchBlobArrayBuffer(part.blobId, part.name || 'inline', part.type, context.accountId);
      return (await inlineImageDataUrl(buffer, part.type))?.dataUrl ?? null;
    },
  });
  return { draft, accountId: context.clientAccountId ?? auth.activeAccountId ?? null };
}

/**
 * "Save as template" on a message, from any of its menus: a name and Save,
 * the full template editor one click further, as from the composer.
 */
export function SaveAsTemplateFlow({ email }: { email: Email }) {
  const t = useTranslations('save_as_template');
  const tComposer = useTranslations('email_composer');
  const tSend = useTranslations('compose_send');
  const tNotifications = useTranslations('notifications');
  const close = useSaveAsTemplateStore((s) => s.close);
  const [read, setRead] = useState<{ draft: TemplateDraftFromEmail; accountId: string | null } | null>(null);
  // The name typed before "Edit details…" opened the full form; null while the quick dialog shows.
  const [details, setDetails] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const { confirmDiscard, discardDialog } = useDiscardChanges();
  const personalTemplates = useTemplateSources(read?.accountId).sources.find((source) => source.kind === 'personal')?.templates;

  useEffect(() => {
    let cancelled = false;
    readTemplateDraft(email)
      .then((result) => {
        if (cancelled) return;
        if (result === 'not_connected') {
          toast.error(tNotifications('not_connected'));
          close();
          return;
        }
        setRead(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        debug.error('Reading a message to save it as a template failed', error);
        toast.error(t('read_failed'));
        close();
      });
    return () => {
      cancelled = true;
    };
  }, [email, close, t, tNotifications]);

  const save = (data: TemplateData) => {
    if (!read) return;
    personalTemplatesFor(read.accountId).add(data);
    const dropped = read.draft.droppedImages;
    if (dropped > 0) toast.warning(tSend('template_saved'), { message: t('images_dropped', { count: dropped }) });
    else toast.success(tSend('template_saved'));
    close();
  };

  const closeDetails = async () => {
    if (!(await confirmDiscard(dirty))) return;
    close();
  };

  if (details === null || !read) {
    const defaultName = stripSubjectPrefixes(email.subject).trim();
    // Measured with the suggested name: a renamed template differs by a few bytes only.
    const staysInBrowser = !!read && isStoredInAccount(read.accountId) && isTooLargeToSync(quickData(read.draft, defaultName));
    return (
      <QuickSaveTemplateDialog
        defaultName={defaultName}
        busy={!read}
        notice={staysInBrowser ? t('too_large_to_sync') : undefined}
        onClose={close}
        onEditDetails={(name) => setDetails(name)}
        onSave={(name) => {
          if (read) save(quickData(read.draft, name));
        }}
      />
    );
  }

  const { draft } = read;
  return (
    <>
      <Dialog
        isOpen
        onClose={() => void closeDetails()}
        title={tComposer('save_as_template')}
        size="lg"
        dirty={dirty}
        testId="save-as-template"
      >
        <div className="pt-4">
          <TemplateForm
            categorySource={personalTemplates}
            initialData={{
              name: details,
              subject: draft.subject,
              body: draft.body,
              isHTML: draft.isHTML,
              to: draft.to,
              cc: draft.cc,
              bcc: draft.bcc,
            }}
            onSave={save}
            onCancel={() => void closeDetails()}
            onDirtyChange={setDirty}
          />
        </div>
      </Dialog>
      {discardDialog}
    </>
  );
}
