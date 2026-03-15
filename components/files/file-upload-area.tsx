"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Upload, FolderPlus, FilePlus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FileUploadAreaProps {
  onUpload: (files: File[]) => Promise<void>;
  onCreateFolder: () => void;
  onCreateTextFile?: () => void;
}

export function FileUploadArea({ onUpload, onCreateFolder, onCreateTextFile }: FileUploadAreaProps) {
  const t = useTranslations("files");
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      await onUpload(files);
    }
  }, [onUpload]);

  return (
    <div className="flex items-center justify-center h-full p-8">
      <div
        className={`flex flex-col items-center gap-4 p-12 rounded-xl border-2 border-dashed transition-colors max-w-md w-full ${
          isDragging ? "border-primary bg-primary/5" : "border-border"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
          <Upload className="w-8 h-8 text-muted-foreground" />
        </div>
        <div className="text-center">
          <h3 className="text-base font-medium">{t("empty_state_title")}</h3>
          <p className="text-sm text-muted-foreground mt-1">{t("empty_state_description")}</p>
          <p className="text-xs text-muted-foreground mt-2">{t("drop_files_here")}</p>
        </div>
        <div className="flex gap-2 flex-wrap justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={onCreateFolder}
          >
            <FolderPlus className="w-4 h-4 mr-2" />
            {t("new_folder")}
          </Button>
          {onCreateTextFile && (
            <Button
              variant="outline"
              size="sm"
              onClick={onCreateTextFile}
            >
              <FilePlus className="w-4 h-4 mr-2" />
              {t("new_text_file")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
