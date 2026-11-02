"use client";

import { useTranslations } from "next-intl";
import { Upload, FolderPlus, FolderOpen, SearchX, NotebookPen } from "@/components/icons";
import { Button } from "@/components/ui/button";

interface EmptyFolderProps {
  isRoot: boolean;
  canCreate: boolean;
  onUpload: () => void;
  onCreateFolder: () => void;
  /** Xenaxio step 115: "Neue Notiz" with its label (the app's own strings). */
  onNewNote?: () => void;
  newNoteLabel?: string;
}

/** What an empty folder shows: what to do next, and that dropping files works. */
export function EmptyFolder({ isRoot, canCreate, onUpload, onCreateFolder, onNewNote, newNoteLabel }: EmptyFolderProps) {
  const t = useTranslations("files");
  return (
    <div className="flex items-center justify-center h-full min-h-[18rem] p-8">
      <div className="flex flex-col items-center text-center max-w-lg">
        <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-4">
          {isRoot ? <Upload className="w-7 h-7 text-muted-foreground" /> : <FolderOpen className="w-7 h-7 text-muted-foreground" />}
        </div>
        <h3 className="text-base font-medium">{isRoot ? t("empty_state_title") : t("empty_folder_title")}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {canCreate ? t("empty_folder_description") : t("empty_folder_read_only")}
        </p>
        {canCreate && (
          <div className="flex gap-2 flex-wrap justify-center mt-5">
            <Button size="sm" onClick={onUpload} className="gap-1.5">
              <Upload className="w-4 h-4" />
              {t("upload_files")}
            </Button>
            <Button variant="outline" size="sm" onClick={onCreateFolder} className="gap-1.5">
              <FolderPlus className="w-4 h-4" />
              {t("new_folder")}
            </Button>
            {/* Xenaxio step 115: a note can be started right here. */}
            {onNewNote && (
              <Button variant="outline" size="sm" onClick={onNewNote} className="gap-1.5">
                <NotebookPen className="w-4 h-4" />
                {newNoteLabel}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function NoSearchResults({ query, onClear }: { query: string; onClear: () => void }) {
  const t = useTranslations("files");
  return (
    <div className="flex flex-col items-center justify-center text-center h-full min-h-[14rem] p-8">
      <SearchX className="w-10 h-10 text-muted-foreground/50 mb-3" />
      <p className="text-sm font-medium">{t("no_results_for", { query })}</p>
      <Button variant="ghost" size="sm" className="mt-2" onClick={onClear}>{t("clear_search")}</Button>
    </div>
  );
}
