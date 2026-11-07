"use client";

import { memo, useMemo, useRef, type ComponentType } from "react";
import type { EmailViewerProps } from "@/components/email/email-viewer";
import { ReaderOpenFailure } from "@/components/email/reader-open-failure";
import { WelcomeBanner } from "@/components/ui/welcome-banner";
import { useStableEach } from "@/hooks/use-stable-each";
import { useStableHandlers } from "@/hooks/use-stable-handlers";

/** What the empty reading pane shows instead of a message. */
export type EmptyReadingPane =
  | { kind: "selection"; hostRef: (element: HTMLDivElement | null) => void }
  | { kind: "failure"; offline: boolean; onRetry: () => void }
  | null;

type Handler = (...args: never[]) => unknown;

export type StableEmailViewerProps = Omit<EmailViewerProps, "emptyPaneContent" | "emptyPaneFooter"> & {
  /** The viewer component (loaded on demand by the mail page). */
  viewer: ComponentType<EmailViewerProps>;
  emptyPane?: EmptyReadingPane;
  /** The welcome banner under the empty pane. */
  welcomeFooter?: boolean;
};

const memoised = new WeakMap<ComponentType<EmailViewerProps>, ComponentType<EmailViewerProps>>();
function memoOf(viewer: ComponentType<EmailViewerProps>): ComponentType<EmailViewerProps> {
  let found = memoised.get(viewer);
  if (!found) {
    found = memo(viewer);
    memoised.set(viewer, found);
  }
  return found;
}

function shallowEqual(a: object | null | undefined, b: object | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** `next`, or the value kept from before while it holds the same fields. */
function useSameShallow<T extends object | null | undefined>(next: T): T {
  const kept = useRef(next);
  if (!shallowEqual(kept.current, next)) kept.current = next;
  return kept.current;
}

/**
 * The reading pane's viewer, drawn again only when something it shows has
 * changed. The mail page re-renders for every search, folder switch and list
 * update, and handed the viewer new handlers and objects each time, so the
 * whole viewer (header, toolbar, menus) drew again in each of those commits
 * while the message on screen stayed the same. Here the handlers keep their
 * identity (they forward to the latest ones) and objects are kept while
 * their fields are the same.
 */
export function StableEmailViewer({ viewer, emptyPane = null, welcomeFooter = false, replyDraft, blobSource, mvPosition, ...rest }: StableEmailViewerProps) {
  const Viewer = memoOf(viewer);
  const handlers: Record<string, Handler> = {};
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === "function") handlers[key] = value as Handler;
    else values[key] = value;
  }
  const stable = useStableEach(handlers);
  // The pane's own callbacks (the open failure's retry, the reply draft's card).
  const pane = useStableHandlers({
    onRetry: emptyPane?.kind === "failure" ? emptyPane.onRetry : undefined,
    onEditDraft: replyDraft ? replyDraft.onEdit : undefined,
    onDiscardDraft: replyDraft ? replyDraft.onDiscard : undefined,
  });

  const keptBlobSource = useSameShallow(blobSource);
  const keptMvPosition = useSameShallow(mvPosition);
  const draftShown = !!replyDraft;
  const draftPreview = replyDraft?.preview;
  const keptReplyDraft = useMemo(
    () => (draftShown && pane.onEditDraft && pane.onDiscardDraft
      ? { preview: draftPreview, onEdit: pane.onEditDraft, onDiscard: pane.onDiscardDraft }
      : replyDraft === undefined ? undefined : null),
    // `replyDraft` only tells undefined from null here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftShown, draftPreview, pane, replyDraft === undefined],
  );

  const paneKind = emptyPane?.kind ?? null;
  const hostRef = emptyPane?.kind === "selection" ? emptyPane.hostRef : null;
  const offline = emptyPane?.kind === "failure" ? emptyPane.offline : false;
  const emptyPaneContent = useMemo(
    () => (paneKind === "selection" && hostRef
      ? <div ref={hostRef} className="m-auto w-full p-8" />
      : paneKind === "failure" && pane.onRetry
        ? <ReaderOpenFailure offline={offline} onRetry={pane.onRetry} />
        : undefined),
    [paneKind, hostRef, offline, pane],
  );
  const emptyPaneFooter = useMemo(() => (welcomeFooter ? <WelcomeBanner variant="pane" /> : undefined), [welcomeFooter]);

  return (
    <Viewer
      {...(values as unknown as EmailViewerProps)}
      {...(stable as Partial<EmailViewerProps>)}
      blobSource={keptBlobSource}
      mvPosition={keptMvPosition}
      replyDraft={keptReplyDraft}
      emptyPaneContent={emptyPaneContent}
      emptyPaneFooter={emptyPaneFooter}
    />
  );
}
