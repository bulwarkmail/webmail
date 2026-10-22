"use client";

// While the company's domain is not connected (DNS not checked yet), mail can
// neither be sent nor received. Shown at the top of every app (mail, calendar,
// contacts, settings) so nobody mistakes a silent mailbox for a working one.
// Admins get the way to the DNS page; employees learn whom to ask.
import { Link } from "@/i18n/navigation";
import { AlertTriangle } from "@/components/icons";
import { useXT } from "@/lib/xenaxio/i18n";
import { domainPending, useXenaxioMe } from "@/lib/xenaxio/me-store";

export function XenaxioDomainBanner() {
  const t = useXT();
  const me = useXenaxioMe();
  if (!domainPending(me)) return null;
  const admin = me.user.role === "admin";
  return (
    <div role="status" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-300 flex-shrink-0">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <span>{t(admin ? "domainbar.pending_admin" : "domainbar.pending_user", { domain: me.domain.name })}</span>
      {admin && (
        <Link href="/workspace/domain" className="font-medium underline underline-offset-2 hover:no-underline">
          {t("domainbar.open_dns")}
        </Link>
      )}
    </div>
  );
}
