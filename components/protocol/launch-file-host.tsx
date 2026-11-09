"use client";

import { useCallback, useEffect, useState, type ComponentType, type ComponentProps } from "react";
import { useTranslations } from "next-intl";
import type { FilePreviewModal as FilePreviewModalType } from "@/components/files/file-preview-modal";
import { useHandoffFiles } from "@/hooks/use-handoff-files";
import { saveBlobAs } from "@/lib/download-guard";
import { toast } from "@/stores/toast-store";

type PreviewComponent = ComponentType<ComponentProps<typeof FilePreviewModalType>>;

/**
 * Shows a .eml opened from the OS. It parses in the browser, so it works
 * offline and before sign-in. `policyAccount` stays out: the strictest device
 * policy of the accounts signed in here decides about saving (FilePreviewModal
 * and saveBlobAs check it).
 *
 * The preview is loaded when a file arrives, to keep it off the layout's
 * bundle, and by hand rather than with next/dynamic: without a connection and
 * without the offline shell its chunk can't load, which has to end in a
 * message, not in the error page, and work again later.
 */
export function LaunchFileHost() {
  const t = useTranslations("pwaLaunch");
  const { file, done } = useHandoffFiles("eml", true);
  const [Preview, setPreview] = useState<PreviewComponent | null>(null);

  useEffect(() => {
    if (!file || Preview) return;
    let stale = false;
    import("@/components/files/file-preview-modal")
      .then((module) => {
        if (!stale) setPreview(() => module.FilePreviewModal);
      })
      .catch(() => {
        if (stale) return;
        toast.error(t("open_failed"));
        done();
      });
    return () => { stale = true; };
  }, [file, Preview, done, t]);

  const getFileContent = useCallback(async () => {
    if (!file) throw new Error("no file");
    return { blob: file, contentType: "message/rfc822" };
  }, [file]);

  const onDownload = useCallback(() => {
    if (file) saveBlobAs(file, file.name, { kind: "attachment" });
  }, [file]);

  if (!file || !Preview) return null;
  return (
    <Preview
      key={`${file.name}:${file.lastModified}`}
      name={file.name}
      onClose={done}
      onDownload={onDownload}
      getFileContent={getFileContent}
    />
  );
}
