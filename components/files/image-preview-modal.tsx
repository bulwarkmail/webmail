"use client";

import { useState, useEffect } from "react";
import { Spinner } from "@/components/ui/spinner";
import { PreviewShell, type PreviewNeighbours } from "@/components/files/preview-shell";
import { useTranslations } from "next-intl";
import { ZoomableImage } from "@/components/files/zoomable-image";
import { FilePreviewPluginSection } from "@/components/files/file-preview-plugin-section";
import type { FileResourceView } from "@/lib/plugin-types";
import { useCloseOnBack } from "@/hooks/use-close-on-back";
import { useStrictestDevices } from "@/hooks/use-device-policy";
import { Watermark, useWatermarkText } from "@/components/device/watermark";
import { noMediaSavingProps } from "@/lib/device-frame";

interface ImagePreviewModalProps {
  name: string;
  onClose: () => void;
  /** Left out when a device policy turned downloads off. */
  onDownload?: (name: string) => Promise<void>;
  getImageUrl: (name: string) => Promise<string>;
  /** The previewed file as plugins see it (file-preview-section). */
  file?: FileResourceView | null;
  /** The previous and next file of the folder, for ←/→. */
  neighbours?: PreviewNeighbours;
}

export function ImagePreviewModal({ name, onClose, onDownload, getImageUrl, file, neighbours }: ImagePreviewModalProps) {
  const t = useTranslations("files");
  // The Files app follows the strictest signed-in account (Organisation > Devices).
  const downloadsOff = useStrictestDevices().noDownloads;
  const watermark = useWatermarkText(undefined, { strictest: true });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Back closes the preview instead of leaving Files, as for every other preview.
  useCloseOnBack({ onBack: onClose });

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    setLoading(true);
    setError(false);
    setImageUrl(null);

    getImageUrl(name)
      .then((url) => {
        revoke = url;
        if (cancelled) return;
        setImageUrl(url);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (revoke?.startsWith("blob:")) URL.revokeObjectURL(revoke);
    };
  }, [name, getImageUrl]);

  return (
    <PreviewShell name={name} onClose={onClose} onDownload={onDownload ? () => void onDownload(name) : undefined} neighbours={neighbours}>
      <div className="relative flex-1 min-h-0" {...noMediaSavingProps(downloadsOff)}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Spinner label={t("loading")} className="w-8 h-8 text-white/80" />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-white/70 text-sm">{t("preview_error")}</p>
          </div>
        )}
        {imageUrl && !error && (
          <ZoomableImage src={imageUrl} alt={name} onBackgroundClick={onClose} />
        )}
        {imageUrl && !error && <Watermark text={watermark} />}
      </div>
      <FilePreviewPluginSection file={file} />
    </PreviewShell>
  );
}
