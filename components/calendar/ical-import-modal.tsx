"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { X, Upload, Check, Loader2, RefreshCw, Globe } from "lucide-react";
import { format, parseISO } from "date-fns";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { getEventStartDate } from "@/lib/calendar-utils";
import { useCalendarStore } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { apiFetch } from "@/lib/browser-navigation";

interface ICalImportModalProps {
  calendars: Calendar[];
  client: IJMAPClient;
  onClose: () => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_EXTENSIONS = [".ics", ".ical"];

type ImportStep = "select" | "preview" | "importing";
type ImportMode = "file" | "url";

export function ICalImportModal({ calendars, client, onClose }: ICalImportModalProps) {
  const t = useTranslations("calendar.import");
  const tCal = useTranslations("calendar");
  const tCommon = useTranslations("common");
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
  const [importMode, setImportMode] = useState<ImportMode>("file");
  const [urlInput, setUrlInput] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

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
      setError(t("invalid_format"));
    } finally {
      setIsParsing(false);
    }
  }, [client, validateFile, t]);

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
        throw new Error(data.error || t("url_fetch_failed"));
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
      const timeFmt = timeFormat === "12h" ? "h:mm a" : "HH:mm";
      return event.showWithoutTime
        ? format(date, "MMM d, yyyy")
        : format(date, `MMM d, yyyy ${timeFmt}`);
    } catch {
      return event.start;
    }
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const focusableEls = modal.querySelectorAll<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
    );
    const firstEl = focusableEls[0];
    const lastEl = focusableEls[focusableEls.length - 1];

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl?.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl?.focus();
      }
    };
    modal.addEventListener("keydown", handler);
    firstEl?.focus();
    return () => modal.removeEventListener("keydown", handler);
  }, [step]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("title")}
        className="relative bg-background border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground"
            aria-label={tCommon("close")}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
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
              </div>

              {importMode === "file" && (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-8 cursor-pointer transition-colors ${
                    isDragging
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50 hover:bg-muted/50"
                  }`}
                >
                  <Upload className="w-8 h-8 text-muted-foreground mb-3" />
                  <p className="text-sm font-medium">{t("select_file")}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t("drop_file")}</p>
                  <p className="text-xs text-muted-foreground mt-2">{t("supported_formats")}</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".ics,.ical"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </div>
              )}

              {importMode === "url" && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">{t("url_description")}</p>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder={t("url_placeholder")}
                      className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      onKeyDown={(e) => { if (e.key === "Enter") handleUrlFetch(); }}
                    />
                    <Button
                      onClick={handleUrlFetch}
                      disabled={!urlInput.trim() || isFetchingUrl}
                    >
                      {isFetchingUrl ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
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
              <Loader2 className="w-6 h-6 animate-spin text-primary mb-3" />
              <p className="text-sm text-muted-foreground">{t("parsing")}</p>
            </div>
          )}

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
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
                      <p className="text-sm font-medium truncate">
                        {event.title || tCal("events.no_title")}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground">
                          {formatEventDate(event)}
                        </span>
                        {event.recurrenceRules && event.recurrenceRules.length > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            <RefreshCw className="w-3 h-3" />
                            {event.recurrenceRules[0].frequency}
                          </span>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>

              {calendars.length > 1 && (
                <div>
                  <label className="text-sm font-medium mb-1 block">
                    {t("target_calendar")}
                  </label>
                  <select
                    value={calendarId}
                    onChange={(e) => setCalendarId(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {calendars.map((cal) => (
                      <option key={cal.id} value={cal.id}>
                        {cal.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          {step === "importing" && (
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary mb-3" />
              <p className="text-sm text-muted-foreground">{t("importing")}</p>
            </div>
          )}
        </div>

        {step !== "importing" && (
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
            <Button variant="outline" onClick={onClose}>
              {tForm("cancel")}
            </Button>
            {step === "preview" && (
              <Button
                onClick={handleImport}
                disabled={selectedIndices.size === 0}
              >
                <Check className="w-4 h-4 mr-1" />
                {t("import_button")} ({selectedIndices.size})
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
