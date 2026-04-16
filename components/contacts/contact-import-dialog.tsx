"use client";

import { useState, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Upload, FileText, AlertTriangle, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { parseVCard, detectDuplicates } from "@/lib/vcard";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";

interface ContactImportDialogProps {
  existingContacts: ContactCard[];
  onImport: (contacts: ContactCard[]) => Promise<number>;
  onClose: () => void;
}

export function ContactImportDialog({
  existingContacts,
  onImport,
  onClose,
}: ContactImportDialogProps) {
  const t = useTranslations("contacts");
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ContactCard[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [duplicates, setDuplicates] = useState<Map<number, string>>(new Map());
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setResult(null);

    if (file.size > 5 * 1024 * 1024) {
      setError(t("import.file_too_large"));
      return;
    }

    try {
      const text = await file.text();
      const contacts = parseVCard(text);

      if (contacts.length === 0) {
        setError(t("import.no_contacts"));
        return;
      }

      const dupes = detectDuplicates(existingContacts, contacts);
      setParsed(contacts);
      setDuplicates(dupes);

      const initialSelected = new Set<number>();
      contacts.forEach((_, idx) => {
        if (!dupes.has(idx)) initialSelected.add(idx);
      });
      setSelected(initialSelected);
    } catch (error) {
      console.error('Failed to parse vCard:', error);
      setError(t("import.parse_error"));
    }
  }, [existingContacts, t]);

  const toggleSelect = (idx: number) => {
    const next = new Set(selected);
    if (next.has(idx)) {
      next.delete(idx);
    } else {
      next.add(idx);
    }
    setSelected(next);
  };

  const selectAll = () => {
    setSelected(new Set(parsed.map((_, i) => i)));
  };

  const deselectAll = () => {
    setSelected(new Set());
  };

  const handleImport = async () => {
    const toImport = parsed.filter((_, i) => selected.has(i));
    if (toImport.length === 0) return;

    setIsImporting(true);
    try {
      const count = await onImport(toImport);
      setResult(count);
    } catch (error) {
      console.error('Failed to import contacts:', error);
      setError(t("import.failed"));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("import.title")}</h2>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {result !== null ? (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center mb-4">
              <Check className="w-6 h-6 text-green-600 dark:text-green-400" />
            </div>
            <p className="text-sm font-medium">{t("import.success", { count: result })}</p>
            <Button variant="outline" size="sm" onClick={onClose} className="mt-4">
              {t("import.close")}
            </Button>
          </div>
        ) : parsed.length === 0 ? (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".vcf,.vcard"
              onChange={handleFileChange}
              className="hidden"
            />

            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className={cn(
                "w-full border-2 border-dashed rounded-lg py-12 px-4",
                "flex flex-col items-center gap-3 transition-colors",
                "hover:border-primary hover:bg-primary/5",
                "text-muted-foreground"
              )}
            >
              <Upload className="w-8 h-8" />
              <p className="text-sm font-medium">{t("import.drop_hint")}</p>
              <p className="text-xs">{t("import.file_types")}</p>
            </button>

            {error && (
              <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 px-3 py-2 rounded flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}
          </>
        ) : (
          <>
            {error && (
              <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 px-3 py-2 rounded flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {t("import.found", { count: parsed.length })}
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={selectAll}>
                  {t("import.select_all")}
                </Button>
                <Button variant="ghost" size="sm" onClick={deselectAll}>
                  {t("import.deselect_all")}
                </Button>
              </div>
            </div>

            <div className="border rounded-md divide-y divide-border max-h-96 overflow-y-auto">
              {parsed.map((contact, idx) => {
                const cName = getContactDisplayName(contact);
                const cEmail = getContactPrimaryEmail(contact);
                const isDupe = duplicates.has(idx);
                const isSelected = selected.has(idx);

                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => toggleSelect(idx)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted",
                      isSelected && "bg-primary/5"
                    )}
                  >
                    <div className={cn(
                      "w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 transition-colors",
                      isSelected ? "bg-primary border-primary text-primary-foreground" : "border-border"
                    )}>
                      {isSelected && <Check className="w-3 h-3" />}
                    </div>
                    <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{cName || cEmail || "-"}</div>
                      {cEmail && cName && (
                        <div className="text-xs text-muted-foreground truncate">{cEmail}</div>
                      )}
                    </div>
                    {isDupe && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-warning/15 text-warning flex-shrink-0">
                        {t("import.duplicate")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {parsed.length > 0 && result === null && (
        <div className="flex items-center justify-between px-6 py-4 border-t border-border">
          <p className="text-sm text-muted-foreground">
            {t("import.selected", { count: selected.size })}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={isImporting}>
              {t("form.cancel")}
            </Button>
            <Button onClick={handleImport} disabled={isImporting || selected.size === 0}>
              {isImporting ? t("import.importing") : t("import.import_button")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
