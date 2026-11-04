'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Mail, Pencil, Trash2, Plus, AlertTriangle, Star } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Dialog } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { IdentityForm } from './identity-form';
import {
  useIdentityStore, createIdentityWithHooks, updateIdentityWithHooks, deleteIdentityWithHooks,
} from '@/stores/identity-store';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';

function useSyncIdentities() {
  const syncIdentities = useAuthStore((state) => state.syncIdentities);
  return syncIdentities;
}

function useRefreshIdentities() {
  return useAuthStore((state) => state.refreshIdentities);
}
import type { Identity, EmailAddress } from '@/lib/jmap/types';
import { toast } from '@/stores/toast-store';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { useDiscardChanges } from '@/components/settings/use-discard-changes';
import { toUnicodeEmail } from '@/lib/idn';
import { getPlainTextSignature } from '@/lib/signature-utils';
import { sortIdentities } from '@/lib/identity-order';
import { useRestriction } from '@/hooks/use-restriction';

interface IdentityFormData {
  name: string;
  email: string;
  replyTo?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  textSignature?: string | null;
  htmlSignature?: string | null;
}

interface IdentityManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function IdentityManagerModal({ isOpen, onClose }: IdentityManagerModalProps) {
  const t = useTranslations('identities');
  const tAddr = useTranslations('uxs2_ident.addresses');
  const tNotif = useTranslations('notifications');
  // A locked or hidden signature: the identity's own isn't what it sends with.
  const signatureRestriction = useRestriction('signature');
  const showOwnSignature = !signatureRestriction.locked && !signatureRestriction.hidden;

  const client = useAuthStore((state) => state.client);
  const identities = useIdentityStore((state) => state.identities);
  const _preferredPrimaryId = useIdentityStore((state) => state.preferredPrimaryId);
  const setPreferredPrimary = useIdentityStore((state) => state.setPreferredPrimary);
  const syncIdentities = useSyncIdentities();

  const refreshIdentitiesFromServer = useRefreshIdentities();

  // Refresh identities from server whenever the modal is opened
  useEffect(() => {
    if (isOpen) {
      refreshIdentitiesFromServer();
    }
  }, [isOpen, refreshIdentitiesFromServer]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  // Reopened, the dialog starts on the list, not on a form left open.
  useEffect(() => {
    if (isOpen) return;
    setIsCreating(false);
    setEditingId(null);
  }, [isOpen]);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();

  // Re-fetch all identities from server and update stores
  const refreshIdentities = useCallback(async () => {
    if (!client) return;
    try {
      const serverIdentities = await client.getIdentities();
      const username = useAuthStore.getState().username;
      const preferredPrimaryId = useIdentityStore.getState().preferredPrimaryId;
      const sorted = sortIdentities(serverIdentities, username || '');
      // Move preferred primary to front if set
      if (preferredPrimaryId) {
        const idx = sorted.findIndex((id) => id.id === preferredPrimaryId);
        if (idx > 0) {
          const [preferred] = sorted.splice(idx, 1);
          sorted.unshift(preferred);
        }
      }
      useIdentityStore.getState().setIdentities(sorted);
      syncIdentities();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to refresh identities';
      toast.error(message);
    }
  }, [client, syncIdentities]);

  // Unsaved input in the create or edit form is only dropped once the user
  // says so (R5); an outside click is ignored while there is some.
  const { confirmDiscard, discardDialog } = useDiscardChanges();
  const cancelForm = useCallback(async () => {
    if (!(await confirmDiscard(formDirty))) return;
    setIsCreating(false);
    setEditingId(null);
  }, [confirmDiscard, formDirty]);

  // Escape, the X and an outside click close the open form first, then the
  // dialog: the innermost layer only.
  const requestClose = useCallback(async () => {
    if (isCreating || editingId) {
      await cancelForm();
      return;
    }
    onClose();
  }, [isCreating, editingId, cancelForm, onClose]);

  const handleCreate = useCallback(async (data: IdentityFormData) => {
    if (!client) return;

    try {
      if (!(await createIdentityWithHooks(client, data))) return;

      await refreshIdentities();
      setIsCreating(false);
      toast.success(tAddr('added'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('validation_errors.unknown_error');
      toast.error(tNotif('identity_create_failed', { error: message }));
      throw error;
    }
  }, [client, refreshIdentities, t, tAddr, tNotif]);

  const handleUpdate = useCallback(async (identity: Identity, data: IdentityFormData) => {
    if (!client) return;

    try {
      const saved = await updateIdentityWithHooks(client, identity, {
        name: data.name,
        replyTo: data.replyTo,
        bcc: data.bcc,
        textSignature: data.textSignature,
        htmlSignature: data.htmlSignature,
      });
      if (!saved) return;

      await refreshIdentities();
      setEditingId(null);
      toast.success(tAddr('saved'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('validation_errors.unknown_error');
      toast.error(tNotif('identity_update_failed', { error: message }));
      throw error;
    }
  }, [client, refreshIdentities, t, tAddr, tNotif]);

  const handleDelete = useCallback(async (identity: Identity) => {
    if (!client) return;
    if (!identity.mayDelete) {
      toast.error(t('cannot_delete'));
      return;
    }

    const confirmed = await confirmDialog({
      title: tAddr('delete_title'),
      message: t('delete_confirm'),
      confirmText: t('delete_button'),
      variant: "destructive",
    });
    if (!confirmed) return;

    setDeletingId(identity.id);

    try {
      if (!(await deleteIdentityWithHooks(client, identity))) return;
      await refreshIdentities();
      toast.success(tAddr('deleted'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('validation_errors.unknown_error');
      toast.error(tNotif('identity_delete_failed', { error: message }));
    } finally {
      setDeletingId(null);
    }
  }, [client, refreshIdentities, t, tAddr, tNotif, confirmDialog]);

  const handleSetPrimary = useCallback((identity: Identity) => {
    setPreferredPrimary(identity.id);
    // Persist the choice per account in the synced settings store so it
    // survives clearing site data, follows the user across devices, and shows
    // up in exported settings (issue #507). JMAP identity ids are account-
    // scoped, so the default is keyed by the active account.
    const activeAccountId = useAccountStore.getState().activeAccountId;
    if (activeAccountId) {
      const current = useSettingsStore.getState().preferredIdentityIds;
      useSettingsStore.getState().updateSetting('preferredIdentityIds', {
        ...current,
        [activeAccountId]: identity.id,
      });
    }
    // Re-sort: move the preferred identity to the front
    const reordered = [identity, ...identities.filter((id) => id.id !== identity.id)];
    useIdentityStore.getState().setIdentities(reordered);
    syncIdentities();
    toast.success(tNotif('identity_set_primary'));
  }, [identities, setPreferredPrimary, syncIdentities, tNotif]);

  return (
    <>
    <Dialog
      isOpen={isOpen}
      onClose={() => void requestClose()}
      dirty={formDirty}
      size="lg"
      className="max-w-3xl max-h-[90vh]"
      title={
        <span className="flex items-center gap-3">
          <Mail className="w-5 h-5 text-muted-foreground" />
          {tAddr('modal_title')}
        </span>
      }
    >
        <div className="pt-4">
          {/* Create New Form */}
          {isCreating && (
            <div className="mb-6 p-4 border border-border rounded-lg bg-muted/30">
              <h3 className="text-sm font-semibold mb-4">{tAddr('add')}</h3>
              <IdentityForm
                onSave={handleCreate}
                onCancel={() => void cancelForm()}
                onDirtyChange={setFormDirty}
              />
            </div>
          )}

          {/* Create Button */}
          {!isCreating && !editingId && (
            <Button
              onClick={() => setIsCreating(true)}
              className="mb-6 w-full sm:w-auto"
            >
              <Plus className="w-4 h-4 me-2" />
              {tAddr('add')}
            </Button>
          )}

          {/* Identities List */}
          <div className="space-y-4">
            {identities.map((identity) => (
              <div
                key={identity.id}
                className="border border-border rounded-lg overflow-hidden"
              >
                {editingId === identity.id ? (
                  <div className="p-4 bg-muted/30">
                    <h3 className="text-sm font-semibold mb-4">
                      {tAddr('edit')}
                    </h3>
                    <IdentityForm
                      identity={identity}
                      onSave={(data) => handleUpdate(identity, data)}
                      onCancel={() => void cancelForm()}
                      onDirtyChange={setFormDirty}
                    />
                  </div>
                ) : (
                  <div className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 sm:flex-nowrap">
                      {/* On a phone the actions go under the name instead of squeezing it. */}
                      <div className="flex-1 min-w-0 max-sm:basis-full">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-foreground truncate" title={identity.name || toUnicodeEmail(identity.email)} dir="auto">
                            {identity.name || toUnicodeEmail(identity.email)}
                          </h3>
                          {identities[0]?.id === identity.id && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                              {t('primary_identity')}
                            </span>
                          )}
                        </div>
                        {identity.name && (
                          <p className="text-sm text-muted-foreground truncate" title={toUnicodeEmail(identity.email)}>
                            {toUnicodeEmail(identity.email)}
                          </p>
                        )}

                        {/* Additional Info */}
                        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                          {identity.replyTo && identity.replyTo.length > 0 && (
                            <p>
                              {t('display.reply_to')} {identity.replyTo.map((a) => toUnicodeEmail(a.email)).join(', ')}
                            </p>
                          )}
                          {identity.bcc && identity.bcc.length > 0 && (
                            <p>
                              {t('display.bcc')} {identity.bcc.map((a) => toUnicodeEmail(a.email)).join(', ')}
                            </p>
                          )}
                          {/* An HTML-only signature shows as its text, not as none. */}
                          {showOwnSignature && getPlainTextSignature(identity) && (
                            <p className="line-clamp-2">
                              {t('display.signature')} {getPlainTextSignature(identity)}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 max-sm:ms-auto">
                        {identities[0]?.id !== identity.id && identities.length > 1 && (
                          <IconButton
                            label={t('set_as_primary')}
                            onClick={() => handleSetPrimary(identity)}
                            disabled={!!editingId || isCreating}
                          >
                            <Star />
                          </IconButton>
                        )}
                        <IconButton
                          label={tAddr('edit')}
                          onClick={() => setEditingId(identity.id)}
                          disabled={!!editingId || isCreating}
                        >
                          <Pencil />
                        </IconButton>
                        {/* Read-only identities show no Delete (R11); the line below says why. */}
                        {identity.mayDelete && (
                          <IconButton
                            label={t('delete_button')}
                            onClick={() => handleDelete(identity)}
                            disabled={!!editingId || isCreating || deletingId === identity.id}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 />
                          </IconButton>
                        )}
                      </div>
                    </div>

                    {!identity.mayDelete && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        {t('cannot_delete')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}

            {identities.length === 0 && !isCreating && (
              <div className="text-center py-12 text-muted-foreground">
                <Mail className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">{tAddr('count', { count: 0 })}</p>
              </div>
            )}
          </div>
        </div>
    </Dialog>
    <ConfirmDialog {...confirmDialogProps} />
    {discardDialog}
    </>
  );
}
