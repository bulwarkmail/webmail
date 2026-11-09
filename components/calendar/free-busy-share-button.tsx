"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Loader2, Share2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { usePolicyStore } from "@/stores/policy-store";
import { toast } from "@/stores/toast-store";
import { ensureFreeBusyShare, freeBusyShareGroups, freeBusyShareState } from "@/lib/free-busy-share";
import { cn } from "@/lib/utils";

/**
 * "Share my free/busy with <group>": shares the user's default calendar's
 * busy times (not its events) with the admin's free/busy group, else with a
 * group of the user's pick. Once shared it says so instead. Nothing shows
 * when there is no group to share with.
 */
export function FreeBusyShareButton({ className }: { className?: string }) {
  const t = useTranslations("free_busy_share");
  const client = useAuthStore((s) => s.client);
  const adminGroup = usePolicyStore((s) => s.policy.organisation?.calendars?.freeBusyGroup ?? "");
  const groups = useMemo(() => freeBusyShareGroups(client, adminGroup), [client, adminGroup]);
  const [group, setGroup] = useState(groups[0] ?? "");
  const [shared, setShared] = useState<Record<string, boolean | null>>({});
  const [saving, setSaving] = useState(false);
  const selectId = useId();

  useEffect(() => {
    if (!groups.includes(group)) setGroup(groups[0] ?? "");
  }, [groups, group]);

  useEffect(() => {
    if (!client || !group || group in shared) return;
    let cancelled = false;
    void freeBusyShareState(client, group).catch(() => null).then((state) => {
      if (!cancelled) setShared((current) => ({ ...current, [group]: state }));
    });
    return () => { cancelled = true; };
  }, [client, group, shared]);

  if (!client || groups.length === 0) return null;
  const state = shared[group];

  const share = async () => {
    setSaving(true);
    try {
      const result = await ensureFreeBusyShare(client, group);
      if (result === "shared" || result === "already") {
        setShared((current) => ({ ...current, [group]: true }));
        toast.success(t("done", { group }));
      } else {
        toast.error(t("error"));
      }
    } catch {
      toast.error(t("error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-xs", className)} data-testid="free-busy-share">
      {groups.length > 1 && (
        <>
          <label htmlFor={selectId} className="sr-only">{t("group_label")}</label>
          <select
            id={selectId}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            className="h-8 max-w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </>
      )}
      {state === true ? (
        <span role="status" className="flex items-center gap-1 text-muted-foreground">
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          {t("already", { group })}
        </span>
      ) : (
        <Button type="button" size="xs" variant="outline" onClick={() => void share()} disabled={saving || state === undefined} data-testid="free-busy-share-button">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Share2 className="h-3.5 w-3.5" aria-hidden="true" />}
          {t("button", { group })}
        </Button>
      )}
    </div>
  );
}
