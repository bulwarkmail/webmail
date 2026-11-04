"use client";

import { useTranslations } from "next-intl";
import { Info, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { closeFirstStartNotice, useCurrentFirstStartNotice } from "@/lib/first-start-notices";
import { useConnectionState } from "@/hooks/use-connection-state";
import { useWelcomeBannerDue } from "@/components/ui/welcome-banner";

/**
 * The first-start notice that's waiting, as a bar above the message list (see
 * lib/first-start-notices). In the page's flow, it covers nothing. It waits while the
 * welcome tips are due, wherever they show (above the list or in the reading pane),
 * so the first start has one greeting at a time. `hidden` while something else greets
 * the user there. Offline, the offline bar above says what matters then, so the
 * notice waits too.
 *
 * One line: a longer text is cut, and shows whole on hover.
 */
export function FirstStartNoticeBar({ hidden = false }: { hidden?: boolean }) {
  const tCommon = useTranslations("common");
  const notice = useCurrentFirstStartNotice();
  const { offline } = useConnectionState();
  const welcomeDue = useWelcomeBannerDue();
  if (!notice || hidden || offline || welcomeDue) return null;
  return (
    <div
      role="status"
      data-first-start-notice={notice.id}
      className="flex items-center gap-3 border-b border-border bg-accent/30 px-4 py-1.5 text-sm"
    >
      <Info className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-foreground" title={notice.text}>{notice.text}</p>
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
