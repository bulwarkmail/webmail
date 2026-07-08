"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useAuthStore, redirectToLogin } from "@/stores/auth-store";
import { useAccountStore } from "@/stores/account-store";
import { useEmailStore } from "@/stores/email-store";
import { useFileStore } from "@/stores/file-store";
import { toast } from "@/stores/toast-store";
import { cn, formatFileSize } from "@/lib/utils";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { useIsMobile } from "@/hooks/use-media-query";
import { useRefreshGesture } from "@/hooks/use-refresh-gesture";
import { usePolicyStore } from "@/stores/policy-store";
import { FileBrowser } from "@/components/files/file-browser";
import type { FileNodeRights } from "@/lib/jmap/types";
import { ImagePreviewModal } from "@/components/files/image-preview-modal";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { loadFilesSettings } from "@/components/files/files-settings-dialog";
import type { FolderLayout } from "@/components/files/files-settings-dialog";
import { AppTopBannerSlot } from "@/components/plugins/app-top-banner-slot";
import { AlertTriangle, Loader2 } from "lucide-react";

export default function FilesPage() {
  const router = useRouter();
  const t = useTranslations("files");
  const filesEnabled = usePolicyStore((s) => s.isFeatureEnabled('filesEnabled'));
  const { isAuthenticated, logout, checkAuth, isLoading: authLoading, client } = useAuthStore();
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const getClientForAccount = useAuthStore((s) => s.getClientForAccount);
  const accounts = useAccountStore((s) => s.accounts);
  const { showAppsModal, inlineApp, loadedApps, handleManageApps, handleInlineApp, closeInlineApp, closeAppsModal } = useSidebarApps();
  const [initialCheckDone, setInitialCheckDone] = useState(() => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client);
  const { quota, isPushConnected } = useEmailStore();
  const {
    currentPath,
    resources,
    isLoading,
    error,
    supportsFiles,
    selectedResources,
    uploadProgress,
    migrationProgress,
    clipboard,
    initClient,
    checkSupport,
    migrateLegacyFlatNodes,
    navigate,
    navigateByPath,
    refresh,
    createDirectory,
    uploadFile: _uploadFile,
    uploadFiles,
    uploadFolder,
    deleteResource,
    deleteResources,
    renameResource,
    downloadResource,
    getImageUrl,
    getFileContent,
    createTextFile,
    duplicateResource,
    downloadResources,
    moveToFolder,
    moveToParent,
    cutResources,
    copyResources,
    pasteResources,
    selectResource,
    toggleSelect,
    selectAll,
    clearSelection,
    setSelection,
    listPath,
    listByParentId,
    favorites,
    recentFiles,
    toggleFavorite,
    addRecentFile,
    cancelUpload,
    undoLastAction,
    lastAction,
    shareResource,
  } = useFileStore();

  const isMobile = useIsMobile();
  const isEmbedded = useIsEmbedded();
  const [folderLayout, setFolderLayout] = useState<FolderLayout>(() => loadFilesSettings().folderLayout);
  const hasFetched = useRef(false);

  // Sync folderLayout when settings change
  useEffect(() => {
    const reload = () => setFolderLayout(loadFilesSettings().folderLayout);
    const handleStorage = (e: StorageEvent) => { if (e.key === "files-settings") reload(); };
    window.addEventListener("storage", handleStorage);
    window.addEventListener("files-settings-changed", reload);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("files-settings-changed", reload);
    };
  }, []);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [detailName, setDetailName] = useState<string | null>(null);

  const detailResource = detailName ? resources.find(r => r.name === detailName) || null : null;

  // Check auth on mount – skip when already authenticated so that navigating
  // between routes doesn't retrigger checkAuth's transient `{ client: null,
  // isLoading: true }` reset, which was flashing the spinner on every nav.
  useEffect(() => {
    const state = useAuthStore.getState();
    if (state.isAuthenticated && state.client) {
      setInitialCheckDone(true);
      return;
    }
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

  // Redirect if not authenticated
  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      try { sessionStorage.setItem('redirect_after_login', window.location.pathname); } catch { /* ignore */ }
      redirectToLogin();
    }
  }, [initialCheckDone, isAuthenticated, authLoading]);

  // Initialize JMAP files client. In the Pro shell, all connected accounts
  // are surfaced as top-level folders at the root, so we *don't* auto-attach
  // to the active account - the user picks one explicitly.
  useEffect(() => {
    if (!isAuthenticated || !client || hasFetched.current) return;
    hasFetched.current = true;
    if (isEmbedded) {
      useFileStore.getState().clearClient();
    } else {
      initClient(client, activeAccountId);
    }
  }, [isAuthenticated, client, initClient, activeAccountId, isEmbedded]);

  // Intercept browser refresh gestures (F5, Ctrl/Cmd+R, pull-to-refresh)
  // and refresh files via JMAP instead of reloading the page.
  useRefreshGesture({
    enabled: isAuthenticated && !!client && supportsFiles === true,
    onRefresh: async () => {
      await refresh();
    },
  });

  // Check support and load root after client is initialized
  const storeClient = useFileStore(s => s.client);
  useEffect(() => {
    if (storeClient && supportsFiles === null) {
      checkSupport().then(async (supported) => {
        if (supported) {
          // Upgrade any files created by older builds (flat path-encoded names)
          // into the real FileNode hierarchy before the first listing.
          await migrateLegacyFlatNodes();
          navigate(null);
        }
      });
    }
  }, [storeClient, supportsFiles, checkSupport, migrateLegacyFlatNodes, navigate]);

  const handleNavigate = useCallback((path: string, resourceId?: string | null) => {
    // Pro shell only: the Account breadcrumb segment signals "go to this
    // account's filesystem root" via a sentinel, distinguishing it from a
    // Home click (which detaches the account and returns to the picker).
    if (resourceId === '__account_root__') {
      void navigate(null);
      return;
    }
    if (isEmbedded && path === '/' && resourceId === undefined) {
      useFileStore.getState().clearClient();
      return;
    }
    if (resourceId !== undefined) {
      // Direct ID-based navigation (directory click, breadcrumb dropdown folder)
      navigate(resourceId, path.split('/').pop() || '');
    } else {
      // Path-based navigation (breadcrumbs, favorites, recent files)
      navigateByPath(path);
    }
  }, [navigate, navigateByPath, isEmbedded]);

  const handleCreateFolder = useCallback(async (name: string) => {
    try {
      await createDirectory(name);
      toast.success(t("create_folder_success"));
    } catch (err) {
      console.error("Failed to create folder:", err);
      toast.error(t("create_folder_error"));
    }
  }, [createDirectory, t]);

  const maxSizeUpload = client?.getMaxSizeUpload() || 0;

  const handleUploadFiles = useCallback(async (files: File[]) => {
    if (maxSizeUpload > 0) {
      const oversized = files.filter(f => f.size > maxSizeUpload);
      files = files.filter(f => f.size <= maxSizeUpload);
      if (oversized.length > 0) {
        toast.error(t("file_too_large", { name: oversized[0].name, max: formatFileSize(maxSizeUpload) }));
      }
    }
    if (files.length === 0) return;
    try {
      await uploadFiles(files);
      toast.success(t("upload_success", { count: files.length }));
    } catch (err) {
      console.error("Failed to upload files:", err);
      toast.error(t("upload_error"));
    }
  }, [uploadFiles, t, maxSizeUpload]);

  const handleUploadFolder = useCallback(async (files: File[]) => {
    if (maxSizeUpload > 0) {
      const oversized = files.filter(f => f.size > maxSizeUpload);
      files = files.filter(f => f.size <= maxSizeUpload);
      if (oversized.length > 0) {
        toast.error(t("file_too_large", { name: oversized[0].name, max: formatFileSize(maxSizeUpload) }));
      }
    }
    if (files.length === 0) return;
    try {
      await uploadFolder(files);
      toast.success(t("upload_success", { count: files.length }));
    } catch (err) {
      console.error("Failed to upload folder:", err);
      toast.error(t("upload_error"));
    }
  }, [uploadFolder, t, maxSizeUpload]);

  const handleDelete = useCallback(async (name: string) => {
    const confirmed = await confirmDialog({
      title: t("delete_confirm_title"),
      message: t("delete_confirm_message", { name }),
      confirmText: t("delete"),
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      await deleteResource(name);
      toast.success(t("delete_success"));
    } catch (err) {
      console.error("Failed to delete:", err);
      toast.error(t("delete_error"));
    }
  }, [deleteResource, confirmDialog, t]);

  const handleBatchDelete = useCallback(async (names: string[]) => {
    const confirmed = await confirmDialog({
      title: t("delete_confirm_title"),
      message: t("batch_delete_confirm_message", { count: names.length }),
      confirmText: t("delete"),
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      await deleteResources(names);
      toast.success(t("batch_delete_success", { count: names.length }));
    } catch (err) {
      console.error("Failed to batch delete:", err);
      toast.error(t("delete_error"));
    }
  }, [deleteResources, confirmDialog, t]);

  const handleUndo = useCallback(async () => {
    try {
      await undoLastAction();
      toast.success(t("undo_success"));
    } catch (err) {
      console.error("Failed to undo:", err);
      toast.error(t("undo_error"));
    }
  }, [undoLastAction, t]);

  const handleRename = useCallback(async (oldName: string, newName: string) => {
    try {
      await renameResource(oldName, newName);
      toast.success(t("rename_success"), {
        action: { label: t("undo"), onClick: handleUndo },
      });
    } catch (err) {
      console.error("Failed to rename:", err);
      toast.error(t("rename_error"));
    }
  }, [renameResource, t, handleUndo]);

  const findResourceId = useCallback((name: string) => {
    const r = resources.find(res => res.name === name);
    return r?.id || name;
  }, [resources]);

  const handleDownload = useCallback(async (name: string) => {
    try {
      await downloadResource(name);
      addRecentFile(name, findResourceId(name));
    } catch (err) {
      console.error("Failed to download:", err);
      toast.error(t("download_error"));
    }
  }, [downloadResource, addRecentFile, findResourceId, t]);

  const handleBatchDownload = useCallback(async (names: string[]) => {
    try {
      await downloadResources(names);
    } catch (err) {
      console.error("Failed to batch download:", err);
      toast.error(t("download_error"));
    }
  }, [downloadResources, t]);

  const handleCreateTextFile = useCallback(async (name: string) => {
    try {
      await createTextFile(name);
      toast.success(t("create_file_success"));
    } catch (err) {
      console.error("Failed to create file:", err);
      toast.error(t("create_file_error"));
    }
  }, [createTextFile, t]);

  const handleDuplicate = useCallback(async (name: string) => {
    try {
      await duplicateResource(name);
      toast.success(t("duplicate_success"));
    } catch (err) {
      console.error("Failed to duplicate:", err);
      toast.error(t("duplicate_error"));
    }
  }, [duplicateResource, t]);

  const handleMoveToFolder = useCallback(async (names: string[], targetFolder: string) => {
    try {
      await moveToFolder(names, targetFolder);
      toast.success(t("move_success", { count: names.length }), {
        action: { label: t("undo"), onClick: handleUndo },
      });
    } catch (err) {
      console.error("Failed to move:", err);
      toast.error(t("move_error"));
    }
  }, [moveToFolder, t, handleUndo]);

  const handleMoveToParent = useCallback(async (names: string[]) => {
    try {
      await moveToParent(names);
      toast.success(t("move_success", { count: names.length }), {
        action: { label: t("undo"), onClick: handleUndo },
      });
    } catch (err) {
      console.error("Failed to move:", err);
      toast.error(t("move_error"));
    }
  }, [moveToParent, t, handleUndo]);

  const handlePaste = useCallback(async () => {
    try {
      await pasteResources();
      toast.success(t("paste_success"), {
        action: lastAction ? { label: t("undo"), onClick: handleUndo } : undefined,
      });
    } catch (err) {
      console.error("Failed to paste:", err);
      toast.error(t("paste_error"));
    }
  }, [pasteResources, t, lastAction, handleUndo]);

  const handlePreviewImage = useCallback((name: string) => {
    setPreviewImage(name);
    addRecentFile(name, findResourceId(name));
  }, [addRecentFile, findResourceId]);

  const handlePreviewFile = useCallback((name: string) => {
    setPreviewFile(name);
    addRecentFile(name, findResourceId(name));
  }, [addRecentFile, findResourceId]);

  const handleShowDetails = useCallback((name: string) => {
    setDetailName(name);
    setShowDetails(true);
  }, []);

  const handleToggleDetails = useCallback(() => {
    setShowDetails(v => !v);
  }, []);

  const currentFilesAccountId = useFileStore((s) => s.currentAccountId);

  // Sharing: the browsing client (store-attached) drives the principal picker
  // and share mutations. supportsPrincipals() gates the whole Share affordance.
  const sharingEnabled = !!storeClient?.supportsPrincipals();
  const filesAccountId = storeClient?.getFilesAccountId() ?? null;
  const handleShare = useCallback(async (id: string, principalId: string, rights: FileNodeRights | null) => {
    await shareResource(id, principalId, rights);
  }, [shareResource]);

  // Pro shell only: all connected accounts are equal top-level entries at
  // the root. The root path "/" itself is a cross-account picker - no
  // account's files are shown until the user enters one.
  const accountFolders = isEmbedded
    ? accounts
        .filter((a) => a.isConnected)
        .map((a) => ({
          accountId: a.id,
          label: a.label || a.email,
          email: a.email,
          avatarColor: a.avatarColor,
        }))
    : [];
  const isAccountPicker = isEmbedded && currentFilesAccountId === null;
  const currentAccountLabel = isEmbedded && currentFilesAccountId
    ? (accounts.find((a) => a.id === currentFilesAccountId)?.label
        || accounts.find((a) => a.id === currentFilesAccountId)?.email
        || null)
    : null;

  const handleSelectAccount = useCallback((accountId: string) => {
    const nextClient = getClientForAccount(accountId);
    if (!nextClient) return;
    const store = useFileStore.getState();
    store.initClient(nextClient, accountId);
    // Reset supportsFiles so the existing checkSupport effect re-runs for
    // the freshly-attached client and triggers the initial navigate(null).
    useFileStore.setState({ supportsFiles: null });
  }, [getClientForAccount]);

  if (!isAuthenticated) return null;

  return (
    <div className={cn("flex flex-col bg-background overflow-hidden pt-[env(safe-area-inset-top)]", isEmbedded ? "h-full" : "h-dvh")}>
      <AppTopBannerSlot />
      <div className="flex flex-1 min-h-0 overflow-hidden">
      {!isMobile && !isEmbedded && (
        <div className="w-14 bg-secondary flex flex-col flex-shrink-0" style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}>
          <NavigationRail
            collapsed
            quota={quota}
            isPushConnected={isPushConnected}
            onLogout={logout}
            onManageApps={handleManageApps}
            onInlineApp={handleInlineApp}
            onCloseInlineApp={closeInlineApp}
            activeAppId={inlineApp?.id ?? null}
          />
        </div>
      )}

      <div className="flex flex-col flex-1 min-w-0">
        {inlineApp && (
          <InlineAppView apps={loadedApps} activeAppId={inlineApp!.id} onClose={closeInlineApp} />
        )}
        <div className={cn("flex flex-1 min-h-0", inlineApp && "hidden")}>
          <div className="flex-1 min-w-0 flex flex-col">
            {folderLayout !== "sidebar" && !isEmbedded && (
              <div className={cn("p-4 border-b border-border", isMobile && "px-3 py-3")}>
                <div className="flex items-center justify-between">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => router.push("/")}
                    className="justify-start"
                  >
                    <ArrowLeft className="w-4 h-4 me-2" />
                    {t("title")}
                  </Button>
                </div>
              </div>
            )}

            <div className="flex-1 min-h-0 flex flex-col">
              {!filesEnabled ? (
                <div className="flex items-center justify-center h-full">
                  <div className="max-w-lg text-center space-y-3 px-4">
                    <AlertTriangle className="w-10 h-10 text-yellow-500 mx-auto" />
                    <p className="text-sm font-medium">{t("disabled_title")}</p>
                    <p className="text-xs text-muted-foreground">{t("disabled_description")}</p>
                  </div>
                </div>
              ) : supportsFiles === false ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-muted-foreground">{t("not_available")}</p>
                </div>
              ) : (
                <div className="flex flex-col flex-1 min-h-0">
                  <div className="mx-4 mt-3 mb-1 flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
                    <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-yellow-700 dark:text-yellow-400">{t("stability_warning")}</p>
                  </div>
                <FileBrowser
                  currentPath={currentPath}
                  resources={resources}
                  isLoading={isLoading}
                  error={error}
                  selectedResources={selectedResources}
                  uploadProgress={uploadProgress}
                  clipboard={clipboard}
                  onNavigate={handleNavigate}
                  onCreateFolder={handleCreateFolder}
                  onUploadFiles={handleUploadFiles}
                  onUploadFolder={handleUploadFolder}
                  onCancelUpload={cancelUpload}
                  onDelete={handleDelete}
                  onBatchDelete={handleBatchDelete}
                  onRename={handleRename}
                  onDownload={handleDownload}
                  onBatchDownload={handleBatchDownload}
                  onRefresh={refresh}
                  onSelectResource={selectResource}
                  onToggleSelect={toggleSelect}
                  onSelectAll={selectAll}
                  onClearSelection={clearSelection}
                  onSetSelection={setSelection}
                  onCut={cutResources}
                  onCopy={copyResources}
                  onPaste={handlePaste}
                  onMoveToFolder={handleMoveToFolder}
                  onMoveToParent={handleMoveToParent}
                  onPreviewImage={handlePreviewImage}
                  onPreviewFile={handlePreviewFile}
                  onShowDetails={handleShowDetails}
                  onCreateTextFile={handleCreateTextFile}
                  onDuplicate={handleDuplicate}
                  getImageUrl={getImageUrl}
                  listPath={listPath}
                  listByParentId={listByParentId}
                  favorites={favorites}
                  recentFiles={recentFiles}
                  onToggleFavorite={toggleFavorite}
                  showDetails={showDetails}
                  onToggleDetails={handleToggleDetails}
                  detailResource={detailResource}
                  accountFolders={accountFolders}
                  onSelectAccount={handleSelectAccount}
                  accountPickerMode={isAccountPicker}
                  accountLabel={currentAccountLabel}
                  client={storeClient}
                  ownAccountId={filesAccountId}
                  sharingEnabled={sharingEnabled}
                  onShare={handleShare}
                />
                </div>
              )}
            </div>
          </div>
        </div>

        {isMobile && !isEmbedded && (
          <NavigationRail
            orientation="horizontal"
            onManageApps={handleManageApps}
            onInlineApp={handleInlineApp}
            onCloseInlineApp={closeInlineApp}
            activeAppId={inlineApp?.id ?? null}
          />
        )}
      </div>

      {/* Image preview modal */}
      {previewImage && (
        <ImagePreviewModal
          name={previewImage}
          onClose={() => setPreviewImage(null)}
          onDownload={handleDownload}
          getImageUrl={getImageUrl}
        />
      )}

      {/* File preview modal (text, PDF, audio, video, markdown) */}
      {previewFile && (
        <FilePreviewModal
          name={previewFile}
          onClose={() => setPreviewFile(null)}
          onDownload={() => handleDownload(previewFile)}
          getFileContent={() => getFileContent(previewFile)}
        />
      )}

      {/* Legacy file migration progress (issue #379) */}
      {migrationProgress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-[22rem] max-w-[90vw] rounded-lg border border-border bg-background p-6 shadow-xl">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-primary animate-spin shrink-0" />
              <div>
                <p className="text-sm font-medium">{t("migration_title")}</p>
                <p className="text-xs text-muted-foreground">{t("migration_description")}</p>
              </div>
            </div>
            <div className="mt-4 h-1.5 bg-primary/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: migrationProgress.total > 0
                  ? `${(migrationProgress.current / migrationProgress.total) * 100}%`
                  : '0%' }}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground tabular-nums text-end">
              {migrationProgress.current} / {migrationProgress.total}
            </p>
          </div>
        </div>
      )}

      <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
      <ConfirmDialog {...confirmDialogProps} />
      </div>
    </div>
  );
}
