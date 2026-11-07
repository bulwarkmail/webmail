"use client";

import { useTranslations } from "next-intl";
import { ChevronDown, Forward, Reply, ReplyAll } from "@/components/icons";
import { ContextMenu } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { ComposerToolbarMenuRadioItem } from "@/components/email/composer-toolbar-menu";
import { cn } from "@/lib/utils";

export type ReplyKind = "reply" | "replyAll" | "forward";

const ICONS = { reply: Reply, replyAll: ReplyAll, forward: Forward } as const;

/**
 * The start of a docked reply's To row: what kind of answer it is, as a
 * small menu to switch between Reply, Reply all and Forward (Outlook has it
 * there). It replaces the reply's title row. Without `onSwitch` it only
 * shows the kind.
 */
export function ReplyTypeMenu({ kind, kinds, onSwitch }: {
  kind: ReplyKind;
  /** The kinds it can switch to, the current one included. */
  kinds: readonly ReplyKind[];
  onSwitch?: (next: ReplyKind) => void;
}) {
  const t = useTranslations("email_composer");
  const tDock = useTranslations("compose_dock");
  const menu = useContextMenu<null>();
  const open = menu.contextMenu.isOpen;
  const close = menu.closeContextMenu;
  const Icon = ICONS[kind];
  const names: Record<ReplyKind, string> = { reply: t("reply"), replyAll: t("reply_all"), forward: t("forward") };

  if (!onSwitch || kinds.length < 2) {
    return (
      <span className="grid h-7 w-7 shrink-0 place-items-center text-muted-foreground" title={names[kind]} data-reply-type={kind}>
        <Icon className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{names[kind]}</span>
      </span>
    );
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onMouseDown={(e) => { if (open) e.stopPropagation(); }}
        onClick={(e) => {
          if (open) close();
          else menu.openContextMenuFrom(e.currentTarget, null, "start");
        }}
        className={cn(
          "-ms-1.5 flex h-7 items-center gap-0.5 rounded-md px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
        // The kind first, as the title row said it, then what the button does.
        aria-label={tDock("reply_type", { kind: names[kind] })}
        title={tDock("reply_type", { kind: names[kind] })}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="composer-reply-type"
        data-reply-type={kind}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </button>
      <ContextMenu ref={menu.menuRef} isOpen={open} position={menu.contextMenu.position} onClose={close}>
        <div className="min-w-44">
          {kinds.map((k) => (
            <ComposerToolbarMenuRadioItem
              key={k}
              checked={k === kind}
              onSelect={() => { close(); if (k !== kind) onSwitch(k); }}
              testId={`composer-reply-type-${k}`}
            >
              {names[k]}
            </ComposerToolbarMenuRadioItem>
          ))}
        </div>
      </ContextMenu>
    </div>
  );
}
