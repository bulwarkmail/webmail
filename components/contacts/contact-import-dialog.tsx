"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Upload, FileText, AlertTriangle, Check } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { parseVCard, detectDuplicates } from "@/lib/vcard";
import {
  CSV_TARGET_GROUPS, csvToContacts, decodeCsvBytes, isCsvFile, matchColumns, readCsv,
  type CsvColumn, type CsvTable, type CsvTarget,
} from "@/lib/contacts/csv-import";
import type { AddressBook, ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";
import { isOfflineNow } from "@/lib/offline/state";
import { useCollectionNames } from "@/hooks/use-collection-names";
import { AccountGroupedOptions } from "@/components/calendar/calendar-select";

interface ContactImportDialogProps {
  existingContacts: ContactCard[];
  onImport: (contacts: ContactCard[], addressBookId?: string) => Promise<number>;
  onClose: () => void;
  /** A file opened from the OS: read at once, as if picked here. */
  initialFile?: File | null;
  /** Books the cards can go into; "Import into" shows when there are two or more. */
  addressBooks?: AddressBook[];
  /** The book open in Contacts: "Import into" starts there. */
  defaultAddressBookId?: string;
}

/** The file's bytes; jsdom's File has no arrayBuffer(). */
function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** "adr.home.street" → "t_street"; "phone.fax.home" → "t_phone_fax_home". */
function targetKey(target: CsvTarget): string {
  if (target.startsWith("adr.")) return `t_${target.split(".")[2]}`;
  return `t_${target.replace(/\./g, "_")}`;
}

export function ContactImportDialog({
  existingContacts,
  onImport,
  onClose,
  initialFile,
  addressBooks = [],
  defaultAddressBookId,
}: ContactImportDialogProps) {
  const t = useTranslations("contacts");
  const shownName = useCollectionNames();
  const tCsv = useTranslations("ux_pim_cimport");
  const tLaunch = useTranslations("pwaLaunch");
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ContactCard[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [duplicates, setDuplicates] = useState<Map<number, string>>(new Map());
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A CSV file waits for its columns to be matched before the preview.
  const [csv, setCsv] = useState<{ table: CsvTable; fileName: string } | null>(null);
  const [columns, setColumns] = useState<CsvColumn[]>([]);
  const [matching, setMatching] = useState(false);
  const pickBook = () => {
    if (defaultAddressBookId && addressBooks.some((b) => b.id === defaultAddressBookId)) return defaultAddressBookId;
    return (addressBooks.find((b) => b.isDefault) ?? addressBooks[0])?.id ?? "";
  };
  const [bookId, setBookId] = useState(pickBook);

  const showCards = useCallback((contacts: ContactCard[]) => {
    const dupes = detectDuplicates(existingContacts, contacts);
    setParsed(contacts);
    setDuplicates(dupes);
    const initialSelected = new Set<number>();
    contacts.forEach((_, idx) => {
      if (!dupes.has(idx)) initialSelected.add(idx);
    });
    setSelected(initialSelected);
  }, [existingContacts]);

  const readFile = useCallback(async (file: File) => {
    setError(null);
    setResult(null);

    if (file.size > 5 * 1024 * 1024) {
      setError(t("import.file_too_large"));
      return;
    }

    if (isCsvFile(file)) {
      try {
        const table = readCsv(decodeCsvBytes(await readBytes(file)));
        if (table.headers.length === 0 || table.rows.length === 0) {
          setError(t("import.no_contacts"));
          return;
        }
        setCsv({ table, fileName: file.name });
        setColumns(matchColumns(table));
        setMatching(true);
      } catch (error) {
        console.error('Failed to read CSV:', error);
        setError(tCsv("parse_error"));
      }
      return;
    }

    try {
      const text = await file.text();
      const contacts = parseVCard(text);

      if (contacts.length === 0) {
        setError(t("import.no_contacts"));
        return;
      }

      showCards(contacts);
    } catch (error) {
      console.error('Failed to parse vCard:', error);
      setError(t("import.parse_error"));
    }
  }, [t, tCsv, showCards]);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await readFile(file);
  }, [readFile]);

  const initialFileRead = useRef(false);
  useEffect(() => {
    if (!initialFile || initialFileRead.current) return;
    initialFileRead.current = true;
    void readFile(initialFile);
  }, [initialFile, readFile]);

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

  const setTarget = (index: number, target: CsvTarget) => {
    setColumns((cols) => cols.map((c) => (c.index === index ? { ...c, target } : c)));
  };

  const anyColumnMatched = columns.some((c) => c.target !== "skip" && c.target !== "type");

  const continueFromColumns = () => {
    if (!csv) return;
    const contacts = csvToContacts(csv.table, columns);
    if (contacts.length === 0) {
      setError(t("import.no_contacts"));
      return;
    }
    setError(null);
    setMatching(false);
    showCards(contacts);
  };

  const backToColumns = () => {
    setParsed([]);
    setError(null);
    setMatching(true);
  };

  const backToFile = () => {
    setCsv(null);
    setColumns([]);
    setMatching(false);
    setError(null);
  };

  const handleImport = async () => {
    const toImport = parsed.filter((_, i) => selected.has(i));
    if (toImport.length === 0) return;

    setIsImporting(true);
    try {
      const count = await onImport(toImport, addressBooks.length > 0 && bookId ? bookId : undefined);
      setResult(count);
    } catch (error) {
      console.error('Failed to import contacts:', error);
      setError(isOfflineNow() ? tLaunch("contacts_need_server") : t("import.failed"));
    } finally {
      setIsImporting(false);
    }
  };

  const errorBanner = error && (
    <div role="alert" className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md flex items-center gap-2">
      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
      {error}
    </div>
  );

  const groupLabel = (id: string) => tCsv(`group_${id.replace(".", "_")}`);
  const optionLabel = (groupId: string, target: CsvTarget) => target.startsWith("adr.")
    ? tCsv("address_field", { group: groupLabel(groupId), part: tCsv(targetKey(target)) })
    : tCsv(targetKey(target));

  const footer = result !== null ? undefined : matching ? (
    <>
      <Button variant="outline" onClick={backToFile} className="me-auto">
        {tCsv("back")}
      </Button>
      <Button variant="outline" onClick={onClose}>
        {t("form.cancel")}
      </Button>
      <Button onClick={continueFromColumns} disabled={!anyColumnMatched}>
        {tCsv("continue")}
      </Button>
    </>
  ) : parsed.length > 0 ? (
    <>
      {csv && (
        <Button variant="outline" onClick={backToColumns} disabled={isImporting}>
          {tCsv("back")}
        </Button>
      )}
      <p className="text-sm text-muted-foreground me-auto self-center">
        {t("import.selected", { count: selected.size })}
      </p>
      <Button variant="outline" onClick={onClose} disabled={isImporting}>
        {t("form.cancel")}
      </Button>
      <Button onClick={handleImport} disabled={isImporting || selected.size === 0}>
        {isImporting ? t("import.importing") : t("import.import_button")}
      </Button>
    </>
  ) : undefined;

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={t("import.title")}
      size="lg"
      // Picked cards and matched columns are not thrown away by a stray click outside.
      dirty={(parsed.length > 0 || matching) && result === null}
      footer={footer}
    >
      <div className="space-y-4 pt-4">
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
        ) : matching && csv ? (
          <>
            {errorBanner}
            <div>
              <h3 className="text-sm font-medium">{tCsv("columns_title")}</h3>
              <p className="text-sm text-muted-foreground mt-1">{tCsv("columns_hint", { file: csv.fileName })}</p>
            </div>
            <div className="border rounded-md max-h-96 overflow-y-auto" data-testid="csv-columns">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-start text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium text-start">{tCsv("column")}</th>
                    <th scope="col" className="px-3 py-2 font-medium text-start">{tCsv("sample")}</th>
                    <th scope="col" className="px-3 py-2 font-medium text-start">{tCsv("field")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {columns.map((col) => (
                    <tr key={col.index} className={cn(col.target === "skip" && "text-muted-foreground")}>
                      <th scope="row" className="px-3 py-1.5 font-normal text-start max-w-[12rem] truncate" title={col.header}>
                        {col.header || "-"}
                      </th>
                      <td className="px-3 py-1.5 max-w-[12rem] truncate" title={col.sample}>{col.sample}</td>
                      <td className="px-3 py-1.5">
                        <select
                          aria-label={col.header}
                          value={col.target}
                          onChange={(e) => setTarget(col.index, e.target.value as CsvTarget)}
                          className="w-full text-sm bg-transparent border border-input rounded-md px-2 py-1 text-foreground focus:outline-hidden hover:border-muted-foreground/50 transition-colors"
                        >
                          <option value="skip">{tCsv("skip")}</option>
                          {CSV_TARGET_GROUPS.map((group) => (
                            <optgroup key={group.id} label={groupLabel(group.id)}>
                              {group.targets.map((target) => (
                                <option key={target} value={target}>{optionLabel(group.id, target)}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!anyColumnMatched && <p className="text-sm text-muted-foreground">{tCsv("no_columns")}</p>}
          </>
        ) : parsed.length === 0 ? (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".vcf,.vcard,.csv,text/csv"
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
              <p className="text-sm font-medium">{tCsv("file_hint")}</p>
              <p className="text-xs">{tCsv("file_types")}</p>
            </button>

            {errorBanner}
          </>
        ) : (
          <>
            {errorBanner}

            {addressBooks.length > 1 && (
              <label className="flex items-center gap-3 text-sm">
                <span className="font-medium shrink-0">{tCsv("import_into")}</span>
                <select
                  value={bookId}
                  onChange={(e) => setBookId(e.target.value)}
                  className="flex-1 min-w-0 text-sm bg-transparent border border-input rounded-md px-2.5 py-1.5 text-foreground focus:outline-hidden hover:border-muted-foreground/50 transition-colors"
                >
                  <AccountGroupedOptions
                    items={addressBooks}
                    label={(book) => (book.isShared && book.accountName ? `${shownName.addressBook(book)} (${book.accountName})` : shownName.addressBook(book))}
                  />
                </select>
              </label>
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
                      "w-full flex items-center gap-3 px-3 py-2.5 text-start transition-colors hover:bg-muted",
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
    </Dialog>
  );
}
