"use client";

import { useState, useEffect, useCallback } from "react";
import { X, Download, ZoomIn, ZoomOut, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

interface ImagePreviewModalProps {
  name: string;
  onClose: () => void;
  onDownload: (name: string) => Promise<void>;
  getImageUrl: (name: string) => Promise<string>;
}

export function ImagePreviewModal({ name, onClose, onDownload, getImageUrl }: ImagePreviewModalProps) {
  const t = useTranslations("files");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    let revoke: string | null = null;
    setLoading(true);
    setError(false);

    getImageUrl(name)
      .then((url) => {
        revoke = url;
        setImageUrl(url);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });

    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [name, getImageUrl]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(z + 0.25, 5));
    if (e.key === "-") setZoom((z) => Math.max(z - 0.25, 0.25));
    if (e.key === "r") setRotation((r) => r + 90);
  }, [onClose]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div
      role="dialog"
      aria-label={name}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      {/* Header */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/60 to-transparent z-10">
        <span className="text-white text-sm font-medium truncate max-w-[50%]">{name}</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white hover:bg-white/20" onClick={(e) => { e.stopPropagation(); setZoom((z) => Math.min(z + 0.25, 5)); }}>
            <ZoomIn className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white hover:bg-white/20" onClick={(e) => { e.stopPropagation(); setZoom((z) => Math.max(z - 0.25, 0.25)); }}>
            <ZoomOut className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white hover:bg-white/20" onClick={(e) => { e.stopPropagation(); setRotation((r) => r + 90); }}>
            <RotateCw className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white hover:bg-white/20" onClick={(e) => { e.stopPropagation(); onDownload(name); }}>
            <Download className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white hover:bg-white/20" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Image */}
      <div className="flex items-center justify-center w-full h-full p-16" onClick={(e) => e.stopPropagation()}>
        {loading && (
          <div className="w-10 h-10 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        )}
        {error && (
          <p className="text-white/70 text-sm">{t("preview_error")}</p>
        )}
        {imageUrl && !error && (
          <img
            src={imageUrl}
            alt={name}
            className="max-w-full max-h-full object-contain transition-transform duration-200"
            style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
            onLoad={() => setLoading(false)}
            draggable={false}
          />
        )}
      </div>
    </div>
  );
}
