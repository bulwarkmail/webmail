"use client";

// Step 9 (M6): consent screen for an AI chat (Claude, ChatGPT, …) connecting
// to the user's workspace by OAuth. The platform's /api/oauth/authorize sends
// the browser here with the authorization request in the query; the platform
// validates it again on every call, so nothing here is trusted.
// Step 51: the screen names the account and the connector's address, and lets
// the user pick another account signed in here (several connectors in one chat).
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { withBasePath } from "@/lib/browser-navigation";
import { Button } from "@/components/ui/button";
import { AlertCircle, CheckCircle } from "@/components/icons";
import { AuthCard, Notice, Spinner } from "@/components/xenaxio/ui";
import { type BrowserAccount, errorKey, type Me, xenaxio, XenaxioApiError } from "@/lib/xenaxio/api";
import { openAccount } from "@/lib/xenaxio/accounts";
import { usePortal } from "@/lib/xenaxio/portal";
import { useXT } from "@/lib/xenaxio/i18n";

type Request = { clientName: string; redirectHost: string; loopback: boolean; address?: string };

/** "https://acme.xenaxio.com" → "https://acme.xenaxio.com/mcp"; null for anything but https. */
function mcpAddressOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? `${parsed.origin}/mcp` : null;
  } catch {
    return null;
  }
}

function Consent() {
  const t = useXT();
  const locale = useLocale();
  const router = useRouter();
  const query = useSearchParams().toString();
  const [me, setMe] = useState<Me | null>(null);
  const [request, setRequest] = useState<Request | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [others, setOthers] = useState<BrowserAccount[]>([]);
  const [otherCompany, setOtherCompany] = useState<string | null>(null);
  const back = `/${locale}/connect/?${query}`;
  const portal = usePortal();

  useEffect(() => {
    if (!query) {
      setInvalid(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const user = await xenaxio.me();
        if (cancelled) return;
        if (user.user.mustChangePassword) return router.replace("/workspace/password");
        setMe(user);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof XenaxioApiError && err.status === 401) {
          // Sign in first, then come back to this very request.
          window.location.assign(withBasePath(`/${locale}/login/?next=${encodeURIComponent(back)}`));
          return;
        }
        setError(t(errorKey(err)));
        return;
      }
      try {
        const info = await xenaxio.oauthRequest(query);
        if (!cancelled) setRequest(info);
      } catch {
        if (!cancelled) setInvalid(true);
      }
      // Step 29: other accounts signed in here can be connected instead.
      try {
        const list = await xenaxio.accounts();
        if (!cancelled) setOthers(list.accounts.filter((a) => !a.active));
      } catch {
        /* the list is optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, back, locale, router, t]);

  const switchTo = async (account: BrowserAccount) => {
    setError(null);
    setOtherCompany(null);
    try {
      const { url } = await xenaxio.switchAccount(account.userId, back);
      // Same address: this page again, now with the other account.
      if (url.startsWith("/")) return openAccount(url);
      // The account opens on its company's own address (always from the shared one): connect it there.
      setOtherCompany(mcpAddressOf(account.portalUrl) ?? account.portalUrl);
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { redirect } = await xenaxio.oauthDecision(query, approve);
      setLeaving(true);
      // Back to the chat: an address the platform checked against the client's registration.
      window.location.assign(redirect);
    } catch (err) {
      setError(t(errorKey(err)));
      setBusy(false);
    }
  };

  if (invalid) {
    return (
      <AuthCard title={t("connect.title")}>
        <Notice kind="error">{t("connect.invalid")}</Notice>
      </AuthCard>
    );
  }
  if (leaving) return <Spinner label={t("connect.redirecting")} />;
  if (!me || !request) return error ? <AuthCard title={t("connect.title")}><Notice kind="error">{error}</Notice></AuthCard> : <Spinner label={t("common.loading")} />;

  const can = ["connect.can_1", "connect.can_2", "connect.can_3", "connect.can_4", "connect.can_5"];
  return (
    <AuthCard title={t("connect.title")}>
      <div className="space-y-5">
        <p className="text-base">{t("connect.wants", { client: request.clientName })}</p>

        <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
          <p className="text-xs text-muted-foreground">{t("connect.account_title")}</p>
          <div>
            <p className="text-lg font-semibold break-all">{me.user.displayName || me.user.email}</p>
            <p className="text-sm break-all">
              {me.user.email} · {me.tenant.name}
            </p>
          </div>
          {request.address && (
            <div>
              <p className="text-xs text-muted-foreground">{t("connect.address")}</p>
              <p className="font-mono text-sm break-all">{request.address}</p>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
          <p className="text-xs text-muted-foreground">{t("connect.redirect")}</p>
          <p className="font-mono text-lg font-semibold break-all">{request.redirectHost}</p>
        </div>
        {request.loopback && <Notice kind="info">{t("connect.loopback")}</Notice>}

        <div className="space-y-2 text-sm">
          <p className="font-medium">{t("connect.can")}</p>
          <ul className="space-y-1.5">
            {can.map((key) => (
              <li key={key} className="flex gap-2">
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
          <p className="flex gap-2 text-muted-foreground">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{t("connect.cannot")}</span>
          </p>
        </div>

        <div className="space-y-2 text-sm">
          {others.length > 0 && <p className="font-medium">{t("connect.others")}</p>}
          {others.map((account) => (
            <div key={account.userId} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
              <span className="min-w-0 flex-1 break-all">
                <span className="block">{account.displayName || account.email}</span>
                <span className="block text-xs text-muted-foreground">
                  {account.email} · {account.company}
                </span>
              </span>
              <Button size="sm" variant="outline" onClick={() => switchTo(account)} disabled={busy}>
                {t("connect.switch")}
              </Button>
            </div>
          ))}
          {otherCompany && <Notice kind="info">{t("connect.other_company", { url: otherCompany })}</Notice>}
          {/* On a company portal an added account stays here (step 39: same company only). */}
          {portal?.kind === "tenant" && (
            <a className="text-xs text-primary underline-offset-2 hover:underline" href={withBasePath(`/${locale}/login/?mode=add-account&next=${encodeURIComponent(back)}`)}>
              {t("connect.add_account")}
            </a>
          )}
        </div>

        <p className="text-xs text-muted-foreground">{t("connect.revoke_hint")}</p>

        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => decide(false)} disabled={busy}>
            {t("connect.deny")}
          </Button>
          <Button onClick={() => decide(true)} disabled={busy}>
            {busy ? t("connect.working") : t("connect.allow")}
          </Button>
        </div>
      </div>
    </AuthCard>
  );
}

export default function ConnectPage() {
  return (
    <Suspense>
      <Consent />
    </Suspense>
  );
}
