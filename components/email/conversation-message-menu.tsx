"use client";

import { useTranslations } from "next-intl";
import { MoreVertical, Printer } from "@/components/icons";
import { ContextMenu, ContextMenuItem } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { cn } from "@/lib/utils";

interface ConversationMessageMenuProps {
  /** Prints this message alone. Left out: no Print (the organisation turned printing off). */
  onPrint?: () => void;
  /** The look of the ⋮ button, to match the buttons next to it. */
  className?: string;
  iconClassName?: string;
}

/**
 * One conversation message's own ⋮: what applies to that message rather
 * than the whole conversation, such as printing it alone.
 */
export function ConversationMessageMenu({ onPrint, className, iconClassName }: ConversationMessageMenuProps) {
  const t = useTranslations("email_viewer");
  const menu = useContextMenu<null>();
  if (!onPrint) return null;
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); menu.openContextMenuFrom(e.currentTarget, null, "end"); }}
        title={t("more_actions")}
        aria-label={t("more_actions")}
        aria-haspopup="menu"
        aria-expanded={menu.contextMenu.isOpen}
        data-conversation-message-menu=""
        className={cn(
          "grid place-items-center w-10 h-10 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors",
          className,
        )}
      >
        <MoreVertical className={cn("w-5 h-5", iconClassName)} />
      </button>
      <ContextMenu ref={menu.menuRef} isOpen={menu.contextMenu.isOpen} position={menu.contextMenu.position} onClose={menu.closeContextMenu}>
        <ContextMenuItem
          icon={Printer}
          label={t("print")}
          testId="conversation-message-print"
          onClick={() => { menu.closeContextMenu(); onPrint(); }}
        />
      </ContextMenu>
    </>
  );
}
