"use client";

import { useState, useCallback, useEffect, useRef, useId } from "react";
import { useLocale, useTranslations } from "next-intl";
import { buildRecurrenceSummary } from "./recurrence-editor";
import { Button } from "@/components/ui/button";
import { Upload, Check, RefreshCw, Globe } from "@/components/icons";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { getEventStartDate } from "@/lib/calendar-utils";
import { useCalendarStore } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { apiFetch } from "@/lib/browser-navigation";
import { explainServerAuthError } from "@/lib/server-auth-status";
import { IS_LITE } from "@/lib/lite";
import { isOfflineNow } from "@/lib/offline/state";
import { useCollectionNames } from "@/hooks/use-collection-names";

interface ICalImportModalProps {
  calendars: Calendar[];
  client: IJMAPClient;
  onClose: () => void;
  initialUrl?: string;
  /** A file opened from the OS: read at once, as if picked here. */
  initialFile?: File | null;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_EXTENSIONS = [".ics", ".ical"];

type ImportStep = "select" | "preview" | "importing";
type ImportMode = "file" | "url";

export function ICalImportModal({ calendars, client, onClose, initialUrl, initialFile }: ICalImportModalProps) {
  const shownName = useCollectionNames();
  const t = useTranslations("calendar.import");
  const tLaunch = useTranslations("pwaLaunch");
  const tCal = useTranslations("calendar");
  const locale = useLocale();
  const tForm = useTranslations("calendar.form");
  const importEvents = useCalendarStore((s) => s.importEvents);
  const timeFormat = useSettingsStore((s) => s.timeFormat);

  const [step, setStep] = useState<ImportStep>("select");
  const [parsedEvents, setParsedEvents] = useState<Partial<CalendarEvent>[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [calendarId, setCalendarId] = useState<string>(() => {
    const defaultCal = calendars.find((c) => c.isDefault);
    return defaultCal?.id || calendars[0]?.id || "";
  });
  const [isParsing, setIsParsing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>(initialUrl ? "url" : "file");
  const [urlInput, setUrlInput] = useState(initialUrl || "");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The dialog opens on the drop zone, or on the address field for a link.
  const dropZoneRef = useRef<HTMLButtonElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const targetId = useId();
  // The file that couldn't be read for lack of a connection, read again when
  // it is back.
  const waitingForServer = useRef<File | null>(null);

  // Opened before the calendars had loaded, from a launch: the default once they have.
  useEffect(() => {
    if (calendarId || calendars.length === 0) return;
    setCalendarId((calendars.find((c) => c.isDefault) ?? calendars[0]).id);
  }, [calendars, calendarId]);

  const validateFile = useCallback((file: File): string | null => {
    if (file.size > MAX_FILE_SIZE) return t("file_too_large");
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
    if (!ACCEPTED_EXTENSIONS.includes(ext)) return t("invalid_format");
    return null;
  }, [t]);

  const handleFile = useCallback(async (file: File) => {
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    // The server reads the file (uploadBlob, then CalendarEvent/parse). Say so
    // rather than call a good file invalid.
    const serverUrl = client.getServerUrl();
    if (isOfflineNow(serverUrl)) {
      waitingForServer.current = file;
      setError(tLaunch("ics_needs_server"));
      return;
    }
    waitingForServer.current = null;

    setError(null);
    setIsParsing(true);
    setStep("select");

    try {
      const blob = new File([file], file.name, { type: "text/calendar" });
      const uploaded = await client.uploadBlob(blob);
      const accountId = client.getCalendarsAccountId();
      const events = await client.parseCalendarEvents(accountId, uploaded.blobId);

      if (events.length === 0) {
        setError(t("no_events"));
        setIsParsing(false);
        return;
      }

      setParsedEvents(events);
      setSelectedIndices(new Set(events.map((_, i) => i)));
      setStep("preview");
    } catch {
      if (isOfflineNow(serverUrl)) {
        waitingForServer.current = file;
        setError(tLaunch("ics_needs_server"));
      } else {
        setError(t("invalid_format"));
      }
    } finally {
      setIsParsing(false);
    }
  }, [client, validateFile, t, tLaunch]);

  const initialFileRead = useRef(false);
  useEffect(() => {
    if (!initialFile || initialFileRead.current) return;
    initialFileRead.current = true;
    void handleFile(initialFile);
  }, [initialFile, handleFile]);

  useEffect(() => {
    const retry = () => {
      if (waitingForServer.current) void handleFile(waitingForServer.current);
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [handleFile]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleUrlFetch = useCallback(async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;

    try {
      new URL(trimmed);
    } catch {
      setError(t("invalid_url"));
      return;
    }

    setError(null);
    setIsFetchingUrl(true);
    setIsParsing(true);

    try {
      const response = await apiFetch("/api/fetch-ical", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(explainServerAuthError(response.status, data.error, t("url_fetch_failed")));
      }

      const blob = await response.blob();
      const file = new File([blob], "calendar.ics", { type: "text/calendar" });
      const uploaded = await client.uploadBlob(file);
      const accountId = client.getCalendarsAccountId();
      const events = await client.parseCalendarEvents(accountId, uploaded.blobId);

      if (events.length === 0) {
        setError(t("no_events"));
        setIsFetchingUrl(false);
        setIsParsing(false);
        return;
      }

      setParsedEvents(events);
      setSelectedIndices(new Set(events.map((_, i) => i)));
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("url_fetch_failed"));
    } finally {
      setIsFetchingUrl(false);
      setIsParsing(false);
    }
  }, [urlInput, client, t]);

  const toggleEvent = useCallback((index: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (selectedIndices.size === parsedEvents.length) {
      setSelectedIndices(new Set());
    } else {
      setSelectedIndices(new Set(parsedEvents.map((_, i) => i)));
    }
  }, [selectedIndices.size, parsedEvents]);

  const handleImport = useCallback(async () => {
    const eventsToImport = parsedEvents.filter((_, i) => selectedIndices.has(i));
    if (eventsToImport.length === 0) return;

    setStep("importing");
    try {
      const count = await importEvents(client, eventsToImport, calendarId);
      if (count === null) {
        // A plugin stopped the import and said why.
        setStep("preview");
        return;
      }
      toast.success(t("success", { count }));
      onClose();
    } catch {
      toast.error(t("error"));
      setStep("preview");
    }
  }, [parsedEvents, selectedIndices, importEvents, client, calendarId, t, onClose]);

  const formatEventDate = (event: Partial<CalendarEvent>): string => {
    if (!event.start) return "";
    try {
      const date = getEventStartDate(event as CalendarEvent);
      // The locale's own order and month names, not an English pattern.
      return date.toLocaleString(locale === "en" ? "en-US" : locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
        ...(event.showWithoutTime ? {} : timeFormat === "12h"
          ? { hour: "numeric", minute: "2-digit", hour12: true }
          : { hour: "2-digit", minute: "2-digit", hour12: false }),
      });
    } catch {
      return event.start;
    }
  };

  // Nothing closes it while the events are being imported.
  const close = useCallback(() => {
    if (step !== "importing") onClose();
  }, [step, onClose]);

  return (
    <Dialog
      isOpen
      onClose={close}
      title={t("title")}
      size="full-on-phone"
      initialFocus={importMode === "url" ? urlInputRef : dropZoneRef}
      dirty={step !== "select" || urlInput.trim() !== (initialUrl ?? "")}
      footer={step !== "importing" ? (
        <>
          <Button variant="outline" onClick={close}>
            {tForm("cancel")}
          </Button>
          {step === "preview" && (
            <Button
              onClick={handleImport}
              disabled={selectedIndices.size === 0}
            >
              <Check className="w-4 h-4 me-1" />
              {t("import_button")} ({selectedIndices.size})
            </Button>
          )}
        </>
      ) : undefined}
    >
        <div className="pt-4 space-y-4">
          {step === "select" && !isParsing && (
            <>
              <div className="flex border-b border-border mb-4">
                <button
                  onClick={() => { setImportMode("file"); setError(null); }}
                  className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    importMode === "file"
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Upload className="w-4 h-4" />
                  {t("tab_file")}
                </button>
                {/* URL import goes through the /api/fetch-ical CORS proxy, absent in the static build. */}
                {!IS_LITE && (
                  <button
                    onClick={() => { setImportMode("url"); setError(null); }}
                    className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                      importMode === "url"
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Globe className="w-4 h-4" />
                    {t("tab_url")}
                  </button>
                )}
              </div>

              {importMode === "file" && (
                <>
                <button
                  ref={dropZoneRef}
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`w-full flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-8 cursor-pointer transition-colors focus-visible:outline-hidden ${
                    isDragging
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50 hover:bg-muted/50"
                  }`}
                >
                  <Upload className="w-8 h-8 text-muted-foreground mb-3" />
                  <span className="block text-sm font-medium">{t("select_file")}</span>
                  <span className="block text-xs text-muted-foreground mt-1">{t("drop_file")}</span>
                  <span className="block text-xs text-muted-foreground mt-2">{t("supported_formats")}</span>
                </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".ics,.ical"
                    onChange={handleFileChange}
                    className="hidden"
                    tabIndex={-1}
                  />
                </>
              )}

              {importMode === "url" && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">{t("url_description")}</p>
                  <div className="flex gap-2">
                    <input
                      ref={urlInputRef}
                      type="url"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder={t("url_placeholder")}
                      aria-label={t("tab_url")}
                      className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden"
                      onKeyDown={(e) => { if (e.key === "Enter") handleUrlFetch(); }}
                    />
                    <Button
                      onClick={handleUrlFetch}
                      disabled={!urlInput.trim() || isFetchingUrl}
                    >
                      {isFetchingUrl ? (
                        <Spinner size="sm" className="text-current" />
                      ) : (
                        t("fetch")
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("url_hint")}</p>
                </div>
              )}
            </>
          )}

          {isParsing && (
            <div className="flex flex-col items-center justify-center py-8">
              <Spinner className="mb-3" />
              <p className="text-sm text-muted-foreground">{t("parsing")}</p>
            </div>
          )}

          {error && (
            <div role="alert" className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          {step === "preview" && parsedEvents.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {t("parsed_events", { count: parsedEvents.length })}
                </p>
                <button
                  onClick={toggleAll}
                  className="text-xs text-primary hover:underline"
                >
                  {selectedIndices.size === parsedEvents.length
                    ? t("deselect_all")
                    : t("select_all")}
                </button>
              </div>

              <div className="max-h-[300px] overflow-y-auto border border-border rounded-md divide-y divide-border">
                {parsedEvents.map((event, index) => (
                  <label
                    key={index}
                    className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/50 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIndices.has(index)}
                      onChange={() => toggleEvent(index)}
                      className="mt-0.5 rounded border-input"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" title={event.title || tCal("events.no_title")}>
                        {event.title || tCal("events.no_title")}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground">
                          {formatEventDate(event)}
                        </span>
                        {event.recurrenceRules && event.recurrenceRules.length > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            <RefreshCw className="w-3 h-3" />
                            {buildRecurrenceSummary(event.recurrenceRules[0], tCal, locale) ?? tCal("recurrence.custom")}
                          </span>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>

              {calendars.length > 1 && (
                <div>
                  <label htmlFor={targetId} className="text-sm font-medium mb-1 block">
                    {t("target_calendar")}
                  </label>
                  <select
                    id={targetId}
                    value={calendarId}
                    onChange={(e) => setCalendarId(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden"
                  >
                    {calendars.map((cal) => (
                      <option key={cal.id} value={cal.id}>
                        {shownName.calendar(cal)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          {step === "importing" && (
            <div className="flex flex-col items-center justify-center py-8">
              <Spinner className="mb-3" />
              <p className="text-sm text-muted-foreground">{t("importing")}</p>
            </div>
          )}
        </div>
    </Dialog>
  );
}
