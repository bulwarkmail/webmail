"use client";

import { useTranslations } from "next-intl";
import { Users, Pencil, Trash2, UserMinus, Mail, MoreVertical, Printer } from "@/components/icons";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ToolbarButton } from "@/components/ui/toolbar";
import { cn } from "@/lib/utils";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";

interface ContactGroupDetailProps {
  group: ContactCard;
  members: ContactCard[];
  onEdit: () => void;
  onDelete: () => void;
  onRemoveMember: (memberId: string) => void;
  onSelectMember: (id: string) => void;
  /** Compose an email to every member with the recipients placed in `field`. */
  onComposeGroup?: (field: "to" | "cc" | "bcc") => void;
  /** Print the group and its members. */
  onPrint?: () => void;
  isMobile?: boolean;
  className?: string;
}

export function ContactGroupDetail({
  group,
  members,
  onEdit,
  onDelete,
  onRemoveMember,
  onSelectMember,
  onComposeGroup,
  onPrint,
  isMobile,
  className,
}: ContactGroupDetailProps) {
  const t = useTranslations("contacts");
  const tCommon = useTranslations("common");
  const groupName = getContactDisplayName(group);
  // Delete sits in a ⋮, as on a contact's page (R6).
  const menu = useContextMenu<null>();
  const hasEmailMembers = members.some((m) => getContactPrimaryEmail(m).trim());

  return (
    <div className={cn("flex flex-col h-full overflow-y-auto", className)}>
      <div data-window-top-row="" className={cn("border-b border-border", isMobile ? "px-4 py-4" : "px-6 py-6")}>
        <div className={cn("flex gap-4", isMobile ? "flex-col" : "items-start justify-between")}>
          <div className="flex items-center gap-4">
            <div className={cn("rounded-full bg-primary/10 flex items-center justify-center", isMobile ? "w-12 h-12" : "w-14 h-14")}>
              <Users className={cn("text-primary", isMobile ? "w-6 h-6" : "w-7 h-7")} />
            </div>
            <div>
              <h2 className={cn("font-semibold", isMobile ? "text-lg" : "text-xl")}>{groupName}</h2>
              <p className="text-sm text-muted-foreground">
                {t("groups.member_count", { count: members.length })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="xs" onClick={onEdit} className="gap-1.5 touch-manipulation">
              <Pencil />
              {t("groups.edit")}
            </Button>
            <ToolbarButton
              label={t("detail.more_actions")}
              aria-haspopup="menu"
              aria-expanded={menu.contextMenu.isOpen}
              active={menu.contextMenu.isOpen}
              onClick={(e) => menu.openContextMenuFrom(e.currentTarget, null, "end")}
              className="touch-manipulation"
            >
              <MoreVertical />
            </ToolbarButton>
            <ContextMenu ref={menu.menuRef} isOpen={menu.contextMenu.isOpen} position={menu.contextMenu.position} onClose={menu.closeContextMenu}>
              <ContextMenuItem icon={Pencil} label={t("groups.edit")} onClick={() => { menu.closeContextMenu(); onEdit(); }} />
              {onPrint && <ContextMenuItem icon={Printer} label={tCommon("print")} onClick={() => { menu.closeContextMenu(); onPrint(); }} />}
              <ContextMenuSeparator />
              <ContextMenuItem icon={Trash2} label={t("groups.delete")} destructive onClick={() => { menu.closeContextMenu(); onDelete(); }} />
            </ContextMenu>
          </div>
        </div>
        {onComposeGroup && hasEmailMembers && (
          <div className="flex flex-wrap items-center gap-2 mt-4">
            <Mail className="w-4 h-4 text-muted-foreground" aria-hidden />
            <span className="text-sm text-muted-foreground">{t("groups.send_email")}</span>
            <div className="inline-flex gap-1">
              {(["to", "cc", "bcc"] as const).map((field) => (
                <Button
                  key={field}
                  variant="outline"
                  size="xs"
                  onClick={() => onComposeGroup(field)}
                  className="touch-manipulation"
                >
                  {t(`groups.send_email_${field}`)}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="px-6 py-4">
        <h3 className="text-sm font-medium text-muted-foreground mb-3">
          {t("groups.members_label")}
        </h3>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {t("groups.no_members")}
          </p>
        ) : (
          <div className="space-y-1">
            {members.map((member) => {
              const mName = getContactDisplayName(member);
              const mEmail = getContactPrimaryEmail(member);
              return (
                <div
                  key={member.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-muted group transition-colors"
                >
                  <button
                    className="flex items-center gap-3 flex-1 min-w-0 text-start"
                    onClick={() => onSelectMember(member.id)}
                  >
                    <Avatar name={mName} email={mEmail} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{mName}</div>
                      {mEmail && (
                        <div className="text-xs text-muted-foreground truncate">{mEmail}</div>
                      )}
                    </div>
                  </button>
                  {/* Always shown: this list is where members are managed (#pim-18). */}
                  <IconButton
                    label={t("groups.remove_member", { name: mName })}
                    onClick={() => onRemoveMember(member.id)}
                  >
                    <UserMinus className="text-muted-foreground" />
                  </IconButton>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
