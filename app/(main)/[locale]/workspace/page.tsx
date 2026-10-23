"use client";

// Workspace home: company status and, for admins, the set-up pages.
import type { ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import { ChevronRight, FileText, Globe, KeyRound, Mail, Palette, Sparkles, Terminal, Users } from "@/components/icons";
import { Notice } from "@/components/xenaxio/ui";
import { useMe, WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { useXT } from "@/lib/xenaxio/i18n";

function Tile({ href, icon, title, description }: { href: string; icon: ReactNode; title: string; description: string }) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 hover:bg-accent transition-colors">
      <span className="text-primary">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground">{description}</span>
      </span>
      <ChevronRight className="w-4 h-4 text-muted-foreground" />
    </Link>
  );
}

function Overview() {
  const t = useXT();
  const me = useMe();
  const isAdmin = me.user.role === "admin";
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("workspace.signed_in_as", { email: me.user.email })}</p>
      <Notice kind={me.tenant.status === "active" ? "success" : "info"}>
        {me.tenant.status === "active" ? t("workspace.status_active") : t("workspace.status_onboarding")}
      </Notice>
      <div className="grid gap-3">
        <Tile href="/" icon={<Mail className="w-5 h-5" />} title={t("workspace.mail")} description={t("workspace.mail_desc")} />
        {isAdmin && <Tile href="/workspace/domain" icon={<Globe className="w-5 h-5" />} title={t("workspace.domain")} description={t("workspace.domain_desc")} />}
        {isAdmin && <Tile href="/workspace/appearance" icon={<Palette className="w-5 h-5" />} title={t("workspace.appearance")} description={t("workspace.appearance_desc")} />}
        {isAdmin && <Tile href="/workspace/users" icon={<Users className="w-5 h-5" />} title={t("workspace.users")} description={t("workspace.users_desc")} />}
        {isAdmin && <Tile href="/workspace/ai" icon={<Sparkles className="w-5 h-5" />} title={t("workspace.ai")} description={t("workspace.ai_desc")} />}
        {isAdmin && <Tile href="/workspace/audit" icon={<FileText className="w-5 h-5" />} title={t("workspace.audit")} description={t("workspace.audit_desc")} />}
        <Tile href="/workspace/mcp" icon={<Terminal className="w-5 h-5" />} title={t("workspace.mcp")} description={t("workspace.mcp_desc")} />
        <Tile href="/workspace/password" icon={<KeyRound className="w-5 h-5" />} title={t("workspace.password")} description={t("workspace.password_desc")} />
      </div>
    </div>
  );
}

export default function WorkspacePage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("workspace.title")}>
      <Overview />
    </WorkspaceShell>
  );
}
