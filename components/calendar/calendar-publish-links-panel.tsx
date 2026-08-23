"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Copy, Link2, Loader2, Plus, Trash2 } from "lucide-react";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type {
  CalendarPublishLink,
  CalendarPublishLinkAccess,
  CalendarPublishLinkVisibility,
} from "@/lib/jmap/types";
import {
  resolveCalendarPublishLinkUrl,
  calendarPublishLinkAccessLabel,
} from "@/lib/calendar-publish-link";
import { formatDateTime } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { cn } from "@/lib/utils";

interface CalendarPublishLinksPanelProps {
  client: IJMAPClient;
  serverUrl: string;
  calendarId: string;
  calendarName: string;
  targetAccountId?: string;
}

type CreatedLinkReveal = {
  url: string;
  label: string | null;
};

export function CalendarPublishLinksPanel({
  client,
  serverUrl,
  calendarId,
  calendarName,
  targetAccountId,
}: CalendarPublishLinksPanelProps) {
  const t = useTranslations("calendar.publishLinks");
  const timeFormat = useSettingsStore((s) => s.timeFormat);

  const [links, setLinks] = useState<CalendarPublishLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [createdReveal, setCreatedReveal] = useState<CreatedLinkReveal | null>(null);

  const [access, setAccess] = useState<CalendarPublishLinkAccess>("private");
  const [visibility, setVisibility] = useState<CalendarPublishLinkVisibility>("full");
  const [label, setLabel] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  const loadLinks = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const list = await client.getCalendarPublishLinks(calendarId, targetAccountId);
      setLinks(list);
    } catch {
      setLoadError(true);
      setLinks([]);
    } finally {
      setLoading(false);
    }
  }, [client, calendarId, targetAccountId]);

  useEffect(() => {
    void loadLinks();
  }, [loadLinks]);

  const resetCreateForm = () => {
    setAccess("private");
    setVisibility("full");
    setLabel("");
    setExpiresAt("");
    setShowCreate(false);
  };

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("url_copied"));
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = url;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      toast.success(t("url_copied"));
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const created = await client.createCalendarPublishLink(
        {
          calendarId,
          access,
          visibility,
          label: label.trim() || null,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        },
        targetAccountId,
      );
      const url = resolveCalendarPublishLinkUrl(serverUrl, created);
      setCreatedReveal({ url, label: created.label });
      resetCreateForm();
      await loadLinks();
      toast.success(t("created"));
    } catch {
      toast.error(t("error_create"));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (linkId: string) => {
    setRevokingId(linkId);
    try {
      await client.destroyCalendarPublishLink(linkId, targetAccountId);
      setConfirmRevokeId(null);
      if (createdReveal) setCreatedReveal(null);
      await loadLinks();
      toast.success(t("revoked"));
    } catch {
      toast.error(t("error_revoke"));
    } finally {
      setRevokingId(null);
    }
  };

  const formatWhen = (iso: string | null) => {
    if (!iso) return t("never");
    return formatDateTime(iso, timeFormat, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <div className="mt-2 rounded-md border border-border bg-muted/20 p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium text-foreground flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5 text-muted-foreground" />
            {t("title")}
          </h4>
          <p className="text-xs text-muted-foreground mt-0.5">{t("description")}</p>
        </div>
        {!showCreate && !loadError && (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md border border-border bg-background hover:bg-muted transition-colors shrink-0"
          >
            <Plus className="w-3 h-3" />
            {t("create")}
          </button>
        )}
      </div>

      {createdReveal && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
          <p className="text-xs font-medium text-foreground">{t("created_once_title")}</p>
          <p className="text-xs text-muted-foreground">{t("created_once_hint")}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs break-all rounded bg-background border border-border px-2 py-1.5">
              {createdReveal.url}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(createdReveal.url)}
              className="p-1.5 rounded-md border border-border bg-background hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0"
              title={t("copy_url")}
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setCreatedReveal(null)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {t("dismiss")}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {t("loading")}
        </div>
      ) : loadError ? (
        <p className="text-xs text-muted-foreground">{t("unsupported")}</p>
      ) : links.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty", { name: calendarName })}</p>
      ) : (
        <div className="space-y-2">
          {links.map((link) => {
            if (confirmRevokeId === link.id) {
              return (
                <div
                  key={link.id}
                  className="flex items-center gap-2 py-2 px-2.5 bg-destructive/5 rounded-md border border-destructive/20"
                >
                  <p className="text-xs text-foreground flex-1">
                    {t("confirm_revoke", { label: link.label || t("untitled") })}
                  </p>
                  <button
                    type="button"
                    onClick={() => handleRevoke(link.id)}
                    disabled={revokingId === link.id}
                    className="px-2 py-1 text-xs font-medium bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/90 disabled:opacity-50"
                  >
                    {t("revoke")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRevokeId(null)}
                    className="px-2 py-1 text-xs bg-muted text-foreground rounded-md hover:bg-accent"
                  >
                    {t("cancel")}
                  </button>
                </div>
              );
            }

            return (
              <div
                key={link.id}
                className="flex flex-col sm:flex-row sm:items-center gap-2 py-2 px-2.5 rounded-md border border-border bg-background text-xs"
              >
                <div className="flex-1 min-w-0 space-y-0.5">
                  <span className="font-medium text-foreground truncate block">
                    {link.label || t("untitled")}
                  </span>
                  <span className="text-muted-foreground block">
                    {calendarPublishLinkAccessLabel(link.access, t)}
                    {" · "}
                    {link.visibility === "full" ? t("visibility_full") : t("visibility_busy")}
                  </span>
                  <span className="text-muted-foreground block">
                    {t("created_at", { time: formatWhen(link.createdAt) })}
                    {" · "}
                    {t("last_used_at", { time: formatWhen(link.lastUsedAt) })}
                  </span>
                  {link.expiresAt && (
                    <span className="text-muted-foreground block">
                      {t("expires_at", { time: formatWhen(link.expiresAt) })}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmRevokeId(link.id)}
                  disabled={revokingId === link.id}
                  className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded-md border border-border",
                    "text-muted-foreground hover:text-destructive hover:border-destructive/30 hover:bg-destructive/5 transition-colors shrink-0",
                    revokingId === link.id && "opacity-50",
                  )}
                  title={t("revoke")}
                >
                  <Trash2 className="w-3 h-3" />
                  {t("revoke")}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <div className="space-y-3 pt-1 border-t border-border">
          <p className="text-xs font-medium text-foreground">{t("create_title")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t("access")}
              </label>
              <select
                value={access}
                onChange={(e) => setAccess(e.target.value as CalendarPublishLinkAccess)}
                disabled={creating}
                className="w-full px-2 py-1.5 text-xs rounded-md border border-border bg-background"
              >
                <option value="private">{t("access_private")}</option>
                <option value="public">{t("access_public")}</option>
              </select>
              <p className="text-[11px] text-muted-foreground mt-1">
                {access === "public" ? t("access_public_hint") : t("access_private_hint")}
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t("visibility")}
              </label>
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as CalendarPublishLinkVisibility)}
                disabled={creating}
                className="w-full px-2 py-1.5 text-xs rounded-md border border-border bg-background"
              >
                <option value="full">{t("visibility_full")}</option>
                <option value="busy">{t("visibility_busy")}</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("label_optional")}
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("label_placeholder")}
              disabled={creating}
              className="w-full px-2 py-1.5 text-xs rounded-md border border-border bg-background"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("expires_optional")}
            </label>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              disabled={creating}
              className="w-full px-2 py-1.5 text-xs rounded-md border border-border bg-background"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating}
              className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
            >
              {creating ? t("creating") : t("create_submit")}
            </button>
            <button
              type="button"
              onClick={resetCreateForm}
              disabled={creating}
              className="px-3 py-1.5 text-xs bg-muted text-foreground rounded-md hover:bg-accent"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
