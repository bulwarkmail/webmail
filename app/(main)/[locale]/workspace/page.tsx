"use client";

// Workspace home: company status and, for admins, the set-up pages.
import type { ReactNode } from "react";
import { Link } from "@/i18n/navigation";
import { Brain, Building, ChevronRight, FileText, Folder, Globe, Inbox, KeyRound, LayoutGrid, Mail, MessagesSquare, Palette, Share2, ShieldCheck, Smartphone, Sparkles, Terminal, Users, Video } from "@/components/icons";
import { Notice } from "@/components/xenaxio/ui";
import { useMe, WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { useXT } from "@/lib/xenaxio/i18n";
import { useXenaxioMe } from "@/lib/xenaxio/me-store";

function Tile({ href, icon, title, description, disabled }: { href: string; icon: ReactNode; title: string; description: string; disabled?: boolean }) {
  // Step 110: a page the plan does not include yet — shown, with the reason, not linked.
  if (disabled) {
    return (
      <div aria-disabled="true" className="flex items-center gap-3 rounded-lg border border-dashed border-border p-4 text-muted-foreground" data-testid="workspace-tile-disabled">
        <span>{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block font-medium">{title}</span>
          <span className="block text-sm">{description}</span>
        </span>
      </div>
    );
  }
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

/**
 * Step 110: the overview of a company without email (XenRooms): the pages a
 * team chat needs — people, Rooms, look, meetings, AI, audit log — and the own
 * assistant. XenRooms Free has no AI: its tile says so.
 */
function RoomsOverview() {
  const t = useXT();
  const me = useMe();
  const isAdmin = me.user.role === "admin";
  const free = me.tenant.plan === "free";
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t("workspace.signed_in_as", { email: me.user.email })}</p>
      <div className="grid gap-3">
        {isAdmin && <Tile href="/workspace/rooms/people" icon={<Users className="w-5 h-5" />} title={t("rooms.people_title")} description={t("workspace.rooms_people_desc")} />}
        {isAdmin && <Tile href="/workspace/chat" icon={<MessagesSquare className="w-5 h-5" />} title={t("workspace.chat")} description={t("workspace.rooms_chat_desc")} />}
        {isAdmin && <Tile href="/workspace/appearance" icon={<Palette className="w-5 h-5" />} title={t("workspace.rooms_appearance")} description={t("workspace.rooms_appearance_desc")} />}
        {isAdmin && <Tile href="/workspace/meetings" icon={<Video className="w-5 h-5" />} title={t("workspace.meetings")} description={t("workspace.rooms_meetings_desc")} />}
        {isAdmin && <Tile href="/workspace/ai" icon={<Sparkles className="w-5 h-5" />} title={t("workspace.ai")} description={free ? t("workspace.rooms_ai_free") : t("workspace.ai_desc")} disabled={free} />}
        {isAdmin && <Tile href="/workspace/audit" icon={<FileText className="w-5 h-5" />} title={t("workspace.audit")} description={t("workspace.audit_desc")} />}
        {!free && <Tile href="/workspace/assistant" icon={<Brain className="w-5 h-5" />} title={t("workspace.assistant")} description={t("workspace.assistant_desc")} />}
        {!free && <Tile href="/workspace/mcp" icon={<Terminal className="w-5 h-5" />} title={t("workspace.mcp")} description={t("workspace.mcp_desc")} />}
        {!free && <Tile href="/workspace/permissions" icon={<ShieldCheck className="w-5 h-5" />} title={t("workspace.permissions")} description={t("workspace.permissions_desc")} />}
        <Tile href="/workspace/password" icon={<KeyRound className="w-5 h-5" />} title={t("workspace.password")} description={t("workspace.password_desc")} />
      </div>
    </div>
  );
}

function Overview() {
  const t = useXT();
  const me = useMe();
  const isAdmin = me.user.role === "admin";
  if (me.tenant.product === "rooms") return <RoomsOverview />;
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
        {isAdmin && <Tile href="/workspace/shared-mailboxes" icon={<Inbox className="w-5 h-5" />} title={t("workspace.shared")} description={t("workspace.shared_desc")} />}
        {isAdmin && <Tile href="/workspace/resources" icon={<Building className="w-5 h-5" />} title={t("workspace.resources")} description={t("workspace.resources_desc")} />}
        {isAdmin && <Tile href="/workspace/chat" icon={<MessagesSquare className="w-5 h-5" />} title={t("workspace.chat")} description={t("workspace.chat_desc")} />}
        {isAdmin && <Tile href="/workspace/meetings" icon={<Video className="w-5 h-5" />} title={t("workspace.meetings")} description={t("workspace.meetings_desc")} />}
        {isAdmin && <Tile href="/workspace/files" icon={<Folder className="w-5 h-5" />} title={t("workspace.files")} description={t("workspace.files_desc")} />}
        {isAdmin && <Tile href="/workspace/ai" icon={<Sparkles className="w-5 h-5" />} title={t("workspace.ai")} description={t("workspace.ai_desc")} />}
        {isAdmin && <Tile href="/workspace/projects" icon={<LayoutGrid className="w-5 h-5" />} title={t("workspace.projects")} description={t("workspace.projects_desc")} />}
        {isAdmin && <Tile href="/workspace/object-types" icon={<LayoutGrid className="w-5 h-5" />} title={t("workspace.object_types")} description={t("workspace.object_types_desc")} />}
        {isAdmin && <Tile href="/workspace/groups" icon={<Users className="w-5 h-5" />} title={t("workspace.groups")} description={t("workspace.groups_desc")} />}
        {isAdmin && <Tile href="/workspace/flows" icon={<Share2 className="w-5 h-5" />} title={t("workspace.flows")} description={t("workspace.flows_desc")} />}
        {isAdmin && <Tile href="/workspace/audit" icon={<FileText className="w-5 h-5" />} title={t("workspace.audit")} description={t("workspace.audit_desc")} />}
        <Tile href="/workspace/assistant" icon={<Brain className="w-5 h-5" />} title={t("workspace.assistant")} description={t("workspace.assistant_desc")} />
        <Tile href="/workspace/menu" icon={<LayoutGrid className="w-5 h-5" />} title={t("workspace.my_menu")} description={t("workspace.my_menu_desc")} />
        <Tile href="/workspace/mail-apps" icon={<Smartphone className="w-5 h-5" />} title={t("workspace.mail_apps")} description={t("workspace.mail_apps_desc")} />
        <Tile href="/workspace/mcp" icon={<Terminal className="w-5 h-5" />} title={t("workspace.mcp")} description={t("workspace.mcp_desc")} />
        <Tile href="/workspace/permissions" icon={<ShieldCheck className="w-5 h-5" />} title={t("workspace.permissions")} description={t("workspace.permissions_desc")} />
        <Tile href="/workspace/password" icon={<KeyRound className="w-5 h-5" />} title={t("workspace.password")} description={t("workspace.password_desc")} />
      </div>
    </div>
  );
}

export default function WorkspacePage() {
  const t = useXT();
  // Step 110: in XenRooms this page is the administration ("Verwaltung").
  const rooms = useXenaxioMe()?.tenant.product === "rooms";
  return (
    <WorkspaceShell title={rooms ? t("rooms.admin_here") : t("workspace.title")}>
      <Overview />
    </WorkspaceShell>
  );
}
