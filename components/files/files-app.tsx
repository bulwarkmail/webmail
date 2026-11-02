"use client";

import { useState, useEffect, useRef, useCallback, useMemo, useId } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useAuthStore, redirectToLogin, saveRedirectAfterLogin } from '@/stores/auth-store';
import { useAccountStore } from "@/stores/account-store";
import { useEmailStore } from "@/stores/email-store";
import { useFileStore, deletesToTrash, isSharedLocation, linkedPreviewResource, resourceServerRef, resourceToView, type UploadReport } from "@/stores/file-store";
import { isTrashLocation } from "@/lib/files-trash";
import { fileErrorKind, isPartialCopy } from "@/lib/file-errors";
import { toast } from "@/stores/toast-store";
import { cn, formatFileSize } from "@/lib/utils";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { AppMain, SkipLink } from "@/components/layout/app-landmarks";
import { useIsFocusedProTab } from "@/hooks/use-pane-context";
import { useIsMobile } from "@/hooks/use-media-query";
import { useRefreshGesture } from "@/hooks/use-refresh-gesture";
import { usePolicyStore } from "@/stores/policy-store";
import { FileBrowser } from "@/components/files/file-browser";
import type { FileNodeRights } from "@/lib/jmap/types";
import { ImagePreviewModal } from "@/components/files/image-preview-modal";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { WopiEditor } from "@/components/files/wopi-editor";
import { useWopiStatus, canWopiOpen, fileExtension } from "@/hooks/use-wopi-status";
import { apiFetch } from "@/lib/browser-navigation";
import { AppTopBannerSlot } from "@/components/plugins/app-top-banner-slot";
import { useStrictestDevices } from "@/hooks/use-device-policy";
import { AlertTriangle, Loader2 } from "@/components/icons";
import { isFilePreviewable } from "@/lib/file-preview";
import { isImageFile } from "@/components/files/file-icons";
import { appPath, buildFilesPath, buildSharedFilesPath, parseFilesPath, type FilesDeepLink } from "@/lib/deep-links";
import { consumePendingDeepLinkEntry, subscribePendingDeepLink } from "@/lib/deep-link-handoff";
import { useDeepLinkUrl } from "@/hooks/use-deep-link-url";
import { useProInterfaceActive } from "@/components/pro/pro-interface-redirect";
import { useLiteLinkSegments } from "@/hooks/use-lite-link-segments";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { MvTopBar } from "@/components/layout/mv-top-bar";
import { useMountainViewShell } from "@/hooks/use-mountain-view-shell";

export interface FilesAppProps {
  /** Path segments after `/files` - the folder path, one segment per level. */
  linkSegments?: string[];
}

export function FilesApp({ linkSegments: routeSegments }: FilesAppProps = {}) {
  // Static Lite build: the route params are empty, read the link from the URL.
  const linkSegments = useLiteLinkSegments('files', routeSegments);
  const t = useTranslations("files");
  const tSidebar = useTranslations("sidebar");
  const tShell = useTranslations("shell");
  useDocumentTitle(tSidebar("files"));
  const tDeepLink = useTranslations("deep_link");
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
    createFile,
    duplicateResource,
    downloadResources,
    downloadZip,
    moveToFolderId,
    moveNode,
    cutResources,
    copyResources,
    pasteResources,
    toggleSelect,
    clearSelection,
    setSelection,
    favorites,
    recentFiles,
    toggleFavorite,
    addRecentFile,
    revealNode,
    renameNode,
    deleteNode,
    downloadNode,
    removeRecentFile,
    cancelUpload,
    undoLastAction,
    lastAction,
    shareResource,
    openSharedNode,
    trashResources,
    trashNode,
    restoreResources,
    purgeResources,
    emptyTrash,
  } = useFileStore();

  const isMobile = useIsMobile();
  const isEmbedded = useIsEmbedded();
  // Mountain View's desktop chrome: its top bar in place of the left rail.
  const mvShell = useMountainViewShell(isEmbedded);
  // The account the files client was last initialised for (`undefined` = never).
  // Tracked so a Pro-shell account switch re-initialises instead of showing the
  // previous account's files until a manual Home click.
  const initedAccountRef = useRef<string | null | undefined>(undefined);
  const filesBootstrapRef = useRef(false);

  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  // WOPI document editing (#425): name of the file open in the editor overlay.
  const [editFile, setEditFile] = useState<string | null>(null);
  const wopiStatus = useWopiStatus(filesEnabled);
  const isOfficeEditable = useCallback((name: string) => canWopiOpen(wopiStatus, name), [wopiStatus]);

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
      saveRedirectAfterLogin();
      redirectToLogin();
    }
  }, [initialCheckDone, isAuthenticated, authLoading]);

  // Initialize JMAP files client. In the Pro shell, all connected accounts
  // are surfaced as top-level folders at the root, so we *don't* auto-attach
  // to the active account - the user picks one explicitly.
  useEffect(() => {
    if (!isAuthenticated || !client) return;
    // Re-run when the ACTIVE account changes (Pro multi-account switch), not
    // just once - otherwise the previous account's files linger until a manual
    // Home click.
    if (initedAccountRef.current === activeAccountId) return;
    const switched = initedAccountRef.current !== undefined;
    initedAccountRef.current = activeAccountId;
    if (isEmbedded) {
      useFileStore.getState().clearClient();
    } else {
      if (switched) {
        // Drop the previous account's attached view so its files don't linger,
        // and let the bootstrap effect below re-list for the new account.
        useFileStore.getState().clearClient();
        filesBootstrapRef.current = false;
      }
      initClient(client, activeAccountId);
    }
  }, [isAuthenticated, client, initClient, activeAccountId, isEmbedded]);

  // Intercept browser refresh gestures (F5, Ctrl/Cmd+R, pull-to-refresh)
  // and refresh files via JMAP instead of reloading the page.
  const { indicator: refreshIndicator } = useRefreshGesture({
    enabled: isAuthenticated && !!client && supportsFiles === true,
    onRefresh: async () => {
      await refresh();
    },
  });

  // ---- Deep links (#733) ---------------------------------------------------
  // `/files/<folder>/<sub>` walks the drive to that folder; `?preview=<name>`
  // opens a file there once the listing arrives. The link is parked on mount
  // and claimed by whichever of the two paths below gets there first: the
  // bootstrap that runs after a capability check on a cold load, or the effect
  // for when the store already knows files are supported.
  const filesLinkRef = useRef<FilesDeepLink | null>(null);
  // The file to preview once its listing arrives: `name`, and for a link
  // into a shared drive the id the link names (`?shared=`), see the preview
  // effect below.
  const pendingPreviewRef = useRef<{ name: string; sharedId?: string } | null>(null);
  useEffect(() => {
    // Inside the Pro shell the route is /pro, so the segments arrive through
    // the handoff the redirect parked rather than as route params.
    const entry = linkSegments ? { segments: linkSegments } : consumePendingDeepLinkEntry('files');
    if (!entry) return;
    const link = parseFilesPath(entry.segments, new URLSearchParams(entry.search ?? window.location.search));
    // Never overwrite with null: this effect re-runs (twice on mount under
    // StrictMode) and the handoff only yields its segments once.
    if (link) filesLinkRef.current = link;
  }, [linkSegments]);

  const takeFilesLink = useCallback(() => {
    const link = filesLinkRef.current;
    filesLinkRef.current = null;
    if (link?.preview) pendingPreviewRef.current = { name: link.preview, sharedId: link.shared };
    return link;
  }, []);

  // A node of a drive shared with the user has no path under the user's own
  // root, so its link names it by id and the store opens where it is listed.
  // False when it is gone or no longer shared.
  const openSharedLink = useCallback(async (id: string): Promise<boolean> => {
    if (await openSharedNode(id, (name) => t("shared_files_from", { name }))) return true;
    toast.error(tDeepLink(pendingPreviewRef.current !== null ? "file_not_found" : "folder_not_found"));
    // Not a file of the same name in whatever folder is open instead.
    pendingPreviewRef.current = null;
    return false;
  }, [openSharedNode, t, tDeepLink]);
  const openSharedLinkRef = useRef(openSharedLink);
  openSharedLinkRef.current = openSharedLink;

  // Links arriving after mount are delivered live. The Pro shell keeps this
  // surface mounted for the whole session, and so does Next for the standard
  // page when a link changes only the query (`?shared=`), while the route is
  // read on mount only. The bootstrap has already run by then - walk the
  // drive directly and let the preview effect below claim `pendingPreviewRef`
  // once the listing lands. While the Pro interface is on, the standard
  // instance renders only during a cold-load redirect and must not steal the
  // link parked for the Pro one.
  const proInterfaceActive = useProInterfaceActive();
  const navigateByPathRef = useRef(navigateByPath);
  navigateByPathRef.current = navigateByPath;
  useEffect(() => {
    if (!isEmbedded && proInterfaceActive) return;
    return subscribePendingDeepLink('files', (segments, search) => {
      const link = parseFilesPath(segments, new URLSearchParams(search ?? window.location.search));
      if (!link) return;
      if (link.preview) pendingPreviewRef.current = { name: link.preview, sharedId: link.shared };
      if (link.shared) void openSharedLinkRef.current(link.shared);
      else void navigateByPathRef.current(link.path);
    });
  }, [isEmbedded, proInterfaceActive]);

  // Check support and load the first listing after the client is initialized.
  // One effect, run once: `checkSupport` publishes `supportsFiles` before it
  // resolves, so splitting the cold path from the warm one would have them
  // race - the warm one following the deep link while the cold one, a tick
  // later, listed the root on top of it.
  const storeClient = useFileStore(s => s.client);
  useEffect(() => {
    if (filesBootstrapRef.current) return;
    if (!storeClient) return;
    filesBootstrapRef.current = true;

    void (async () => {
      const firstCheck = supportsFiles === null;
      if (firstCheck) {
        if (!await checkSupport()) return;
        // Upgrade any files created by older builds (flat path-encoded names)
        // into the real FileNode hierarchy before the first listing.
        await migrateLegacyFlatNodes();
      } else if (supportsFiles !== true) {
        return;
      }

      // A deep link replaces the root listing rather than following it -
      // listing the root first would strand the user there and rewrite the
      // URL they arrived on.
      const link = takeFilesLink();
      if (link?.shared && await openSharedLinkRef.current(link.shared)) return;
      if (link && !link.shared && link.path !== '/') await navigateByPath(link.path);
      else if (firstCheck) await navigate(null);
    })();
  }, [storeClient, supportsFiles, checkSupport, migrateLegacyFlatNodes, navigate, navigateByPath, takeFilesLink]);

  // The preview waits for the folder listing: the modal is keyed by file name
  // and can only render once the file is in `resources` - found by the id a
  // link into a shared drive names it by (linkedPreviewResource).
  useEffect(() => {
    const pending = pendingPreviewRef.current;
    if (!pending) return;
    const resource = linkedPreviewResource(resources, pending, useFileStore.getState().currentParentId);
    if (!resource) return;
    pendingPreviewRef.current = null;
    if (!resource.isSymlink && isFilePreviewable(resource.name)) {
      setPreviewFile(resource.name);
    } else {
      toast.error(tDeepLink('file_not_found'));
    }
  }, [resources, tDeepLink]);

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

  // What the server said went wrong, as the second line under an action's
  // own error message; undefined when it said nothing specific.
  const serverReason = useCallback((err: unknown): string | undefined => {
    switch (fileErrorKind(err)) {
      case "overQuota": return t("error_over_quota");
      case "tooDeep": return t("error_too_deep");
      case "invalidName": return t("error_invalid_name");
      case "forbidden": return t("error_forbidden");
      case "tooLarge": return t("error_too_large");
      default: return undefined;
    }
  }, [t]);
  // A copy that stopped part-way and could not all be taken back says so too.
  const failureReason = useCallback((err: unknown): string | undefined => {
    const reason = serverReason(err);
    if (!isPartialCopy(err)) return reason;
    return reason ? `${reason} ${t("error_partial_copy")}` : t("error_partial_copy");
  }, [serverReason, t]);

  // An upload goes on past a file the server refuses; the refused ones are
  // reported once it is done.
  const showUploadReport = useCallback((report: UploadReport) => {
    if (report.canceled) {
      toast.info(t("upload_canceled"), report.uploaded > 0 ? t("upload_canceled_partial", { count: report.uploaded }) : undefined);
    } else if (report.uploaded > 0) {
      toast.success(t("upload_success", { count: report.uploaded }));
    }
    if (report.failed.length === 0) return;
    const names = report.failed.slice(0, 3).map((f) => f.name).join(", ")
      + (report.failed.length > 3 ? ", …" : "");
    const reason = failureReason(report.failed[0].error);
    toast.error(t("upload_failed", { count: report.failed.length }), reason ? `${names}: ${reason}` : names);
  }, [t, failureReason]);

  const handleCreateFolder = useCallback(async (name: string) => {
    try {
      await createDirectory(name);
      toast.success(t("create_folder_success"));
    } catch (err) {
      console.error("Failed to create folder:", err);
      toast.error(t("create_folder_error"), failureReason(err));
    }
  }, [createDirectory, t, failureReason]);

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
      showUploadReport(await uploadFiles(files));
    } catch (err) {
      console.error("Failed to upload files:", err);
      toast.error(t("upload_error"), failureReason(err));
    }
  }, [uploadFiles, t, maxSizeUpload, showUploadReport, failureReason]);

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
      showUploadReport(await uploadFolder(files));
    } catch (err) {
      console.error("Failed to upload folder:", err);
      toast.error(t("upload_error"), failureReason(err));
    }
  }, [uploadFolder, t, maxSizeUpload, showUploadReport, failureReason]);

  const handleUndo = useCallback(async () => {
    try {
      await undoLastAction();
      toast.success(t("undo_success"));
    } catch (err) {
      console.error("Failed to undo:", err);
      toast.error(t("undo_error"), failureReason(err));
    }
  }, [undoLastAction, t, failureReason]);

  // Delete (R3): in the own drive items go to the trash, with Undo and no
  // question; in the trash and in a drive someone shared they are gone for
  // good, so that asks first.
  const currentParentIdForDelete = useFileStore((s) => s.currentParentId);
  const handleDeleteNames = useCallback(async (names: string[]) => {
    if (names.length === 0) return;
    if (isTrashLocation(currentParentIdForDelete)) {
      const confirmed = await confirmDialog({
        title: t("delete_forever_title", { count: names.length }),
        message: names.length === 1
          ? t("delete_forever_message", { name: names[0] })
          : t("delete_forever_message_count", { count: names.length }),
        confirmText: t("delete_forever"),
        variant: "destructive",
      });
      if (!confirmed) return;
      try {
        const count = await purgeResources(names);
        if (count > 0) toast.success(t("deleted_forever", { count }));
      } catch (err) {
        console.error("Failed to delete:", err);
        toast.error(t("delete_error"), failureReason(err));
      }
      return;
    }
    if (deletesToTrash(currentParentIdForDelete)) {
      try {
        const count = await trashResources(names);
        if (count > 0) {
          toast.success(t("moved_to_trash", { count }), {
            action: { label: t("undo"), onClick: handleUndo },
          });
        }
      } catch (err) {
        console.error("Failed to delete:", err);
        toast.error(t("delete_error"), failureReason(err));
      }
      return;
    }
    const confirmed = await confirmDialog({
      title: t("delete_forever_title", { count: names.length }),
      message: names.length === 1
        ? t("delete_forever_message", { name: names[0] })
        : t("delete_forever_message_count", { count: names.length }),
      confirmText: t("delete_forever"),
      variant: "destructive",
    });
    if (!confirmed) return;
    try {
      if (names.length === 1 ? !await deleteResource(names[0]) : !await deleteResources(names)) return;
      toast.success(t("deleted_forever", { count: names.length }));
    } catch (err) {
      console.error("Failed to delete:", err);
      toast.error(t("delete_error"), failureReason(err));
    }
  }, [currentParentIdForDelete, confirmDialog, t, purgeResources, trashResources, deleteResource, deleteResources, handleUndo, failureReason]);
  const handleDelete = useCallback((name: string) => handleDeleteNames([name]), [handleDeleteNames]);
  const handleBatchDelete = handleDeleteNames;

  const handleRestore = useCallback(async (names: string[]) => {
    try {
      const count = await restoreResources(names);
      if (count > 0) toast.success(t("restored", { count }));
    } catch (err) {
      console.error("Failed to restore:", err);
      toast.error(t("restore_error"), failureReason(err));
    }
  }, [restoreResources, t, failureReason]);

  const trashCount = useFileStore((s) => s.trashCount);
  const handleEmptyTrash = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("empty_trash_title"),
      message: t("empty_trash_message", { count: trashCount }),
      confirmText: t("empty_trash"),
      variant: "destructive",
    });
    if (!confirmed) return;
    try {
      await emptyTrash();
      toast.success(t("trash_emptied"));
    } catch (err) {
      console.error("Failed to empty the trash:", err);
      toast.error(t("empty_trash_error"), failureReason(err));
    }
  }, [confirmDialog, t, trashCount, emptyTrash, failureReason]);

  const handleRename = useCallback(async (oldName: string, newName: string) => {
    try {
      if (!await renameResource(oldName, newName)) return;
      toast.success(t("rename_success"), {
        action: { label: t("undo"), onClick: handleUndo },
      });
    } catch (err) {
      console.error("Failed to rename:", err);
      toast.error(t("rename_error"), failureReason(err));
    }
  }, [renameResource, t, handleUndo, failureReason]);

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

  // A folder (or a selection with folders) comes as a zip built here; a
  // progress toast shows how far it is and can cancel it.
  const handleDownloadZip = useCallback(async (ids: string[], zipName: string) => {
    const controller = new AbortController();
    const toastId = toast.progress(t("zipping", { name: zipName }), {
      progress: 0,
      action: { label: t("cancel"), onClick: () => controller.abort() },
    });
    try {
      await downloadZip(ids, zipName, {
        signal: controller.signal,
        onProgress: ({ progress, current }) => toast.update(toastId, { progress, message: current }),
      });
      toast.dismiss(toastId);
    } catch (err) {
      toast.dismiss(toastId);
      if (err instanceof DOMException && err.name === "AbortError") {
        toast.info(t("download_canceled"));
        return;
      }
      console.error("Failed to download the zip:", err);
      toast.error(t("zip_error", { name: zipName }), failureReason(err));
    }
  }, [downloadZip, t, failureReason]);

  // A document format the editor can create starts from a blank template
  // and opens in the editor (#1393); any other name is an empty text file.
  const handleCreateFile = useCallback(async (name: string) => {
    try {
      const ext = fileExtension(name);
      let template: Blob | undefined;
      if (wopiStatus?.newExtensions.includes(ext)) {
        const res = await apiFetch(`/api/wopi/template?ext=${encodeURIComponent(ext)}`);
        if (!res.ok) throw new Error(`Template for .${ext} unavailable (${res.status})`);
        template = await res.blob();
      }
      const created = await createFile(name, template);
      toast.success(t("create_file_success"));
      if (template && created && isOfficeEditable(created)) setEditFile(created);
    } catch (err) {
      console.error("Failed to create file:", err);
      toast.error(t("create_file_error"), failureReason(err));
    }
  }, [createFile, wopiStatus, isOfficeEditable, t, failureReason]);

  const handleDuplicate = useCallback(async (name: string) => {
    try {
      await duplicateResource(name);
      toast.success(t("duplicate_success"));
    } catch (err) {
      console.error("Failed to duplicate:", err);
      toast.error(t("duplicate_error"), failureReason(err));
    }
  }, [duplicateResource, t, failureReason]);

  const handleMoveTo = useCallback(async (names: string[], targetId: string | null) => {
    try {
      if (!await moveToFolderId(names, targetId)) return;
      toast.success(t("move_success", { count: names.length }), {
        action: { label: t("undo"), onClick: handleUndo },
      });
    } catch (err) {
      console.error("Failed to move:", err);
      toast.error(t("move_error"), failureReason(err));
    }
  }, [moveToFolderId, t, handleUndo, failureReason]);

  const handleMoveNode = useCallback(async (id: string, targetId: string | null) => {
    try {
      if (!await moveNode(id, targetId)) return;
      toast.success(t("move_success", { count: 1 }), {
        action: { label: t("undo"), onClick: handleUndo },
      });
    } catch (err) {
      console.error("Failed to move:", err);
      toast.error(t("move_error"), failureReason(err));
    }
  }, [moveNode, t, handleUndo, failureReason]);

  const handlePaste = useCallback(async () => {
    try {
      if (!await pasteResources()) return;
      toast.success(t("paste_success"), {
        action: lastAction ? { label: t("undo"), onClick: handleUndo } : undefined,
      });
    } catch (err) {
      console.error("Failed to paste:", err);
      toast.error(t("paste_error"), failureReason(err));
    }
  }, [pasteResources, t, lastAction, handleUndo, failureReason]);

  const handlePreviewImage = useCallback((name: string) => {
    setPreviewImage(name);
    addRecentFile(name, findResourceId(name));
  }, [addRecentFile, findResourceId]);

  const handlePreviewFile = useCallback((name: string) => {
    setPreviewFile(name);
    addRecentFile(name, findResourceId(name));
  }, [addRecentFile, findResourceId]);

  const handleRenameNode = useCallback(async (id: string, newName: string) => {
    try {
      if (!await renameNode(id, newName)) return;
      toast.success(t("rename_success"), {
        action: { label: t("undo"), onClick: handleUndo },
      });
    } catch (err) {
      console.error("Failed to rename:", err);
      toast.error(t("rename_error"), failureReason(err));
    }
  }, [renameNode, t, handleUndo, failureReason]);

  const handleDeleteNode = useCallback(async (id: string, name: string) => {
    // A folder of the own drive goes to the trash; one of a shared drive is gone for good.
    if (deletesToTrash(id)) {
      try {
        if (!await trashNode(id)) return;
        toast.success(t("moved_to_trash", { count: 1 }), {
          action: { label: t("undo"), onClick: handleUndo },
        });
      } catch (err) {
        console.error("Failed to delete:", err);
        toast.error(t("delete_error"), failureReason(err));
      }
      return;
    }
    const confirmed = await confirmDialog({
      title: t("delete_forever_title", { count: 1 }),
      message: t("delete_forever_message", { name }),
      confirmText: t("delete_forever"),
      variant: "destructive",
    });
    if (!confirmed) return;
    try {
      if (!await deleteNode(id)) return;
      toast.success(t("deleted_forever", { count: 1 }));
    } catch (err) {
      console.error("Failed to delete:", err);
      toast.error(t("delete_error"), failureReason(err));
    }
  }, [deleteNode, trashNode, confirmDialog, handleUndo, t, failureReason]);

  // Files may hold what an attachment-only block would keep in: the device
  // policy covers them too, the strictest of the accounts signed in here
  // (the drive may be another account's).
  const filesDownloadsOff = useStrictestDevices().noDownloads;

  const handleDownloadNode = useCallback(async (id: string) => {
    try {
      await downloadNode(id);
    } catch (err) {
      console.error("Failed to download:", err);
      toast.error(t("download_error"));
    }
  }, [downloadNode, t]);

  const handleRevealNode = useCallback(async (id: string) => {
    if (!await revealNode(id)) toast.error(tDeepLink("file_not_found"));
  }, [revealNode, tDeepLink]);

  // Recent files can live in any folder: open that folder, then the file.
  const handleOpenRecent = useCallback(async (id: string) => {
    const name = await revealNode(id);
    if (!name) {
      toast.error(tDeepLink("file_not_found"));
      return;
    }
    addRecentFile(name, id);
    if (isOfficeEditable(name)) setEditFile(name);
    else if (isImageFile(name)) setPreviewImage(name);
    else if (isFilePreviewable(name)) setPreviewFile(name);
  }, [revealNode, addRecentFile, isOfficeEditable, tDeepLink]);

  // The permalink for the folder on screen. In the Pro shell only the focused
  // tab writes the address bar; the standard instance that renders while Pro
  // takes over a route stays silent.
  const isFocusedProTab = useIsFocusedProTab();
  // A shared drive's folders and pages are linked by id (see openSharedLink).
  const currentParentId = useFileStore((s) => s.currentParentId);
  const filesLinkPath = appPath(isSharedLocation(currentParentId)
    ? buildSharedFilesPath(currentParentId, previewFile)
    : buildFilesPath(currentPath, previewFile));

  // The previewed file as plugins see it (file-preview-section).
  const previewedName = previewFile ?? previewImage;
  // ←/→ in a preview go through the folder's other previewable files.
  const previewNeighbours = useMemo(() => {
    if (!previewedName) return undefined;
    const names = resources
      .filter((r) => !r.isDirectory && !r.isSymlink && (isImageFile(r.name) || isFilePreviewable(r.name)))
      .map((r) => r.name);
    const i = names.indexOf(previewedName);
    if (i === -1) return undefined;
    return {
      previous: names[i - 1] ?? null,
      next: names[i + 1] ?? null,
      onGo: (name: string) => {
        addRecentFile(name, resources.find((r) => r.name === name)?.id ?? name);
        if (isImageFile(name)) {
          setPreviewFile(null);
          setPreviewImage(name);
        } else {
          setPreviewImage(null);
          setPreviewFile(name);
        }
      },
    };
  }, [previewedName, resources, addRecentFile]);
  const previewedView = useMemo(() => {
    const resource = previewedName ? resources.find((r) => r.name === previewedName) : undefined;
    return resource ? resourceToView(resource, currentPath) : null;
  }, [previewedName, resources, currentPath]);
  useDeepLinkUrl(
    isEmbedded
      ? (isFocusedProTab ? filesLinkPath : null)
      : proInterfaceActive ? null : filesLinkPath,
  );

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
    <div className={cn("flex flex-col overflow-hidden pt-[env(safe-area-inset-top)]", mvShell ? "bg-[var(--mv-canvas)]" : "bg-background", isEmbedded ? "h-full" : "h-dvh")}>
      {!isEmbedded && <SkipLink>{tShell("skip_to_content")}</SkipLink>}
      <AppTopBannerSlot />
      {refreshIndicator}
      {mvShell && (
        <MvTopBar
          showMenuButton={false}
          onManageApps={handleManageApps}
          onInlineApp={handleInlineApp}
          onCloseInlineApp={closeInlineApp}
          activeAppId={inlineApp?.id ?? null}
        />
      )}
      <div data-mv-card={mvShell ? "" : undefined} className={cn("flex flex-1 min-h-0 overflow-hidden", mvShell && "mb-4 mx-4")}>
      {!isMobile && !isEmbedded && !mvShell && (
        <div className="memail-app-rail bg-secondary flex flex-col flex-shrink-0" style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}>
          <NavigationRail variant="workspace"
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
            <div className="flex-1 min-h-0 flex flex-col">
              {!filesEnabled ? (
                <AppMain embedded={isEmbedded} heading={tSidebar("files")} className="flex items-center justify-center h-full">
                  <div className="max-w-lg text-center space-y-3 px-4">
                    <AlertTriangle className="w-10 h-10 text-amber-600 dark:text-amber-400 mx-auto" />
                    <p className="text-sm font-medium">{t("disabled_title")}</p>
                  </div>
                </AppMain>
              ) : supportsFiles === false ? (
                <AppMain embedded={isEmbedded} heading={tSidebar("files")} className="flex items-center justify-center h-full">
                  <p className="text-sm text-muted-foreground">{t("not_available")}</p>
                </AppMain>
              ) : (
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
                  onRestore={handleRestore}
                  onEmptyTrash={() => void handleEmptyTrash()}
                  onRename={handleRename}
                  onDownload={handleDownload}
                  onBatchDownload={handleBatchDownload}
                  onDownloadZip={handleDownloadZip}
                  onRefresh={refresh}
                  onToggleSelect={toggleSelect}
                  onClearSelection={clearSelection}
                  onSetSelection={setSelection}
                  onCut={cutResources}
                  onCopy={copyResources}
                  onPaste={handlePaste}
                  onMoveTo={handleMoveTo}
                  onMoveNode={handleMoveNode}
                  onPreviewImage={handlePreviewImage}
                  onPreviewFile={handlePreviewFile}
                  isOfficeEditable={isOfficeEditable}
                  onEditFile={setEditFile}
                  onCreateFile={handleCreateFile}
                  newFileFormats={wopiStatus?.newExtensions}
                  onDuplicate={handleDuplicate}
                  getImageUrl={getImageUrl}
                  favorites={favorites}
                  recentFiles={recentFiles}
                  onToggleFavorite={toggleFavorite}
                  onOpenRecent={handleOpenRecent}
                  onRenameNode={handleRenameNode}
                  onDeleteNode={handleDeleteNode}
                  onDownloadNode={handleDownloadNode}
                  downloadsOff={filesDownloadsOff}
                  onRevealNode={handleRevealNode}
                  onRemoveRecent={removeRecentFile}
                  accountFolders={accountFolders}
                  onSelectAccount={handleSelectAccount}
                  accountPickerMode={isAccountPicker}
                  accountLabel={currentAccountLabel}
                  client={storeClient}
                  ownAccountId={filesAccountId}
                  sharingEnabled={sharingEnabled}
                  onShare={handleShare}
                />
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
          onDownload={filesDownloadsOff ? undefined : handleDownload}
          getImageUrl={getImageUrl}
          file={previewedView}
          neighbours={previewNeighbours}
        />
      )}

      {/* File preview modal (text, PDF, audio, video, markdown) */}
      {previewFile && (
        <FilePreviewModal
          name={previewFile}
          onClose={() => setPreviewFile(null)}
          onDownload={() => handleDownload(previewFile)}
          getFileContent={() => getFileContent(previewFile)}
          file={previewedView}
          neighbours={previewNeighbours}
        />
      )}

      {/* WOPI document editor overlay (#425) */}
      {editFile && (() => {
        const editResource = resources.find(r => r.name === editFile);
        if (!editResource) return null;
        // A node shared with the user opens in its owner's account, by its
        // own id (#1094).
        const node = resourceServerRef(editResource);
        // The Pro shell may be browsing a login other than the active one.
        const slot = currentFilesAccountId
          ? accounts.find((a) => a.id === currentFilesAccountId)?.cookieSlot
          : undefined;
        return (
          <WopiEditor
            target={{ kind: "file", id: node.id, name: editResource.name }}
            accountId={node.accountId ?? filesAccountId}
            slot={slot}
            closeOnBack
            onClose={() => {
              setEditFile(null);
              // The editor may have saved new content - pick up size/mtime.
              refresh();
            }}
          />
        );
      })()}

      {/* Legacy file migration progress (issue #379) */}
      {migrationProgress && (
        <MigrationOverlay
          title={t("migration_title")}
          description={t("migration_description")}
          current={migrationProgress.current}
          total={migrationProgress.total}
        />
      )}

      <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
      <ConfirmDialog {...confirmDialogProps} />
      </div>
    </div>
  );
}

/**
 * The legacy file migration (#379) blocks the Files app until it is done: a
 * modal with no buttons that holds the focus, so a screen reader reads its
 * title, and a progress bar it can follow.
 */
function MigrationOverlay({ title, description, current, total }: { title: string; description: string; current: number; total: number }) {
  const id = useId();
  const panelRef = useFocusTrap({ isActive: true, restoreFocus: true, initialFocus: () => panelRef.current });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        className="w-[22rem] max-w-[90vw] rounded-lg border border-border bg-background p-6 shadow-xl outline-none"
      >
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 text-primary animate-spin shrink-0" aria-hidden="true" />
          <div>
            <p id={`${id}-title`} className="text-sm font-medium">{title}</p>
            <p id={`${id}-description`} className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        <div
          role="progressbar"
          aria-labelledby={`${id}-title`}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={current}
          aria-valuetext={`${current} / ${total}`}
          className="mt-4 h-1.5 bg-primary/20 rounded-full overflow-hidden"
        >
          <div
            className="h-full bg-primary rounded-full transition-all duration-300"
            style={{ width: total > 0 ? `${(current / total) * 100}%` : '0%' }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground tabular-nums text-end" aria-hidden="true">
          {current} / {total}
        </p>
      </div>
    </div>
  );
}
