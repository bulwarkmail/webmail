"use client";

import { useTranslations } from "next-intl";
import { Info, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { closeFirstStartNotice, useCurrentFirstStartNotice } from "@/lib/first-start-notices";

/**
 * The first-start notice that's waiting, as a bar above the message list (see
 * lib/first-start-notices). In the page's flow, it covers nothing. `hidden` while
 * something else greets the user there, so only one shows at a time.
 */
export function FirstStartNoticeBar({ hidden = false }: { hidden?: boolean }) {
  const tCommon = useTranslations("common");
  const notice = useCurrentFirstStartNotice();
  if (!notice || hidden) return null;
  return (
    <div
      role="status"
      data-first-start-notice={notice.id}
      className="flex items-start gap-3 border-b border-border bg-accent/30 px-4 py-2.5 text-sm"
    >
      <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-foreground">{notice.text}</p>
      {notice.action && (
        <Button
          variant="outline"
          size="xs"
          className="flex-shrink-0 text-xs"
          onClick={() => {
            const action = notice.action!;
            closeFirstStartNotice(notice.id);
            action.onClick();
          }}
        >
          {notice.action.label}
        </Button>
      )}
      <IconButton label={tCommon("close")} onClick={() => closeFirstStartNotice(notice.id)} className="-my-1 flex-shrink-0 text-muted-foreground">
        <X />
      </IconButton>
    </div>
  );
}
