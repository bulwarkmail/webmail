"use client";

// xenaxio, step 43: the admin turns the company's team chat on or off and sees
// its state (being set up, on, a problem). Step 54: and whether the assistant
// and connected AI chats (MCP) may read it.
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice, Spinner } from "@/components/xenaxio/ui";
import { FederationAdmin } from "@/components/xenaxio/chat/federation-admin";
import { WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { Link } from "@/i18n/navigation";
import { type ChatAdmin, errorText, xenaxio } from "@/lib/xenaxio/api";
import { useChatStore } from "@/lib/xenaxio/chat/store";
import { useXT } from "@/lib/xenaxio/i18n";

function ChatSettings() {
  const t = useXT();
  const [data, setData] = useState<ChatAdmin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadStatus = useChatStore((s) => s.loadStatus);

  const load = useCallback(async () => {
    try {
      setData(await xenaxio.chatAdmin());
    } catch (err) {
      setError(errorText(t, err));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);
  // While it is being set up, look again every few seconds.
  useEffect(() => {
    if (data?.state !== "provisioning") return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [data?.state, load]);
  useEffect(() => {
    if (data) void loadStatus(true);
  }, [data, loadStatus]);

  const change = async (enabled: boolean) => {
    if (!enabled && !window.confirm(t("chatadmin.switch_off_confirm"))) return;
    setBusy(true);
    setError(null);
    try {
      setData(await xenaxio.setChatAdmin(enabled));
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const changeAi = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setData(await xenaxio.setChatAi(enabled));
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner label={t("common.loading")} />;
  const on = data.state === "active" || data.state === "provisioning" || data.state === "error";
  const domain = data.serverName ?? data.candidate?.name ?? null;

  return (
    <div className="max-w-2xl space-y-6">
      {error && <Notice kind="error">{error}</Notice>}
      {!data.available && <Notice kind="info">{t("chatadmin.unavailable")}</Notice>}
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <p className="text-sm text-muted-foreground">{t("chatadmin.intro")}</p>
        <p className="text-sm font-medium">{t(`chatadmin.${data.state}`)}</p>
        {data.state === "error" && data.error && <p className="text-xs text-muted-foreground">{t("chatadmin.last_error", { error: data.error })}</p>}
        {domain && <p className="text-sm text-muted-foreground">{data.serverName ? t("chatadmin.domain", { domain }) : t("chatadmin.domain_note", { domain })}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant={on ? "outline" : "default"} disabled={busy || !data.available} onClick={() => void change(!on)}>
            {on ? t("chatadmin.switch_off") : t("chatadmin.switch_on")}
          </Button>
          {data.state === "active" && (
            <Link href="/chat" className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-primary hover:underline">
              {t("chatadmin.open")}
            </Link>
          )}
        </div>
        {data.state === "active" && (
          <label htmlFor="chat-ai-access" className="flex cursor-pointer items-start gap-3 border-t border-border pt-3">
            <input id="chat-ai-access" type="checkbox" className="mt-1 h-4 w-4" checked={data.aiAccess} disabled={busy} onChange={(e) => void changeAi(e.target.checked)} />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">{t("chatadmin.ai_access")}</span>
              <span className="block text-xs text-muted-foreground">{t("chatadmin.ai_access_hint")}</span>
            </span>
          </label>
        )}
      </section>
      {/* Step 43, part E: other companies (federation), once the chat runs. */}
      {data.state === "active" && <FederationAdmin />}
    </div>
  );
}

export default function ChatAdminPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("chatadmin.title")} backHref="/workspace" requireAdmin>
      <ChatSettings />
    </WorkspaceShell>
  );
}
