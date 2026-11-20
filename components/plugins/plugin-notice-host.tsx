'use client';

// Plugins' notices (api.ui.showNotice, lib/plugin-sandbox/notices.ts) as
// toasts of the app's own stack: the same place, width and look as every
// toast, a line naming the plugin with the close button, and the plugin's
// frame below it. No backdrop and no focus trap: the frame never takes the
// focus, so the user goes on typing while a notice comes up. The title is
// read out the way a toast's is (lib/announce, politely). A dialog the frame
// opens (api.ui.openDialog) stands above the stack.

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { dismissNotice, notices, subscribeNotices, type NoticeRequest } from '@/lib/plugin-sandbox/notices';
import { MAX_NOTICE_HEIGHT } from '@/lib/plugin-sandbox/slot-layout';
import { useToastStore } from '@/stores/toast-store';
import { usePluginStore } from '@/stores/plugin-store';
import type { SlotName } from '@/lib/plugin-types';
import { PluginIframeSlot } from './plugin-iframe-slot';

const NONE: readonly NoticeRequest[] = [];

/** rem the stack keeps free of notices: its margins and room for a toast of the app's. */
const STACK_ROOM_REM = 6;
/** rem a notice takes beside its frame: the line with the plugin's name, the borders and the gap to the next. */
const NOTICE_CHROME_REM = 2.5;

/**
 * The most a notice's frame takes: MAX_NOTICE_HEIGHT, and on a short screen
 * less, so that all `count` notices up fit on the screen with their close
 * buttons. Also for a notice that names another of the plugin's slots, whose
 * frame could otherwise grow to that slot's limit.
 */
export function noticeFrameLimit(count: number): string {
  const n = Math.max(1, count);
  return `min(${MAX_NOTICE_HEIGHT}px, calc((100dvh - ${STACK_ROOM_REM}rem) / ${n} - ${NOTICE_CHROME_REM}rem))`;
}

const noticeCount = () => notices().length;
const oneNotice = () => 1;

/** The plugin's frame in a notice: `height` fixes it and the frame fills it, else it takes its content's height. */
export function PluginNoticeFrame({ notice }: { notice: NoticeRequest }) {
  const extraProps = useMemo(() => ({ ...notice.extraProps, noticeId: notice.id }), [notice]);
  const limit = noticeFrameLimit(useSyncExternalStore(subscribeNotices, noticeCount, oneNotice));
  return (
    <div
      data-plugin-notice={notice.pluginId}
      data-plugin-slot={notice.slot}
      // What doesn't fit scrolls, so a frame cut down on a short screen keeps its buttons in reach.
      className={notice.height !== undefined ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}
      style={notice.height !== undefined ? { height: `min(${notice.height}px, ${limit})` } : { maxHeight: limit }}
    >
      <PluginIframeSlot
        pluginId={notice.pluginId}
        slot={notice.slot as SlotName}
        extraProps={extraProps}
        fill={notice.height !== undefined}
      />
    </div>
  );
}

export function PluginNoticeHost(): null {
  const list = useSyncExternalStore(subscribeNotices, notices, () => NONE);
  // Notice id → the id of the toast that shows it.
  const toastIds = useRef(new Map<string, string>());

  useEffect(() => {
    const store = useToastStore.getState();
    const ids = toastIds.current;
    const up = new Set(list.map((n) => n.id));
    // Closed by the plugin, its frame going, or the plugin turned off.
    for (const [noticeId, toastId] of ids) {
      if (up.has(noticeId)) continue;
      ids.delete(noticeId);
      store.removeToast(toastId);
    }
    for (const notice of list) {
      if (ids.has(notice.id)) continue;
      const plugin = usePluginStore.getState().plugins.find((p) => p.id === notice.pluginId);
      const pluginName = plugin?.name || notice.pluginId;
      const toastId = store.addToast({
        type: 'info',
        title: notice.title || pluginName,
        duration: 0,
        pluginId: notice.pluginId,
        pluginName,
        content: <PluginNoticeFrame notice={notice} />,
        // The user's close button: the toast goes with its own animation.
        onDismiss: () => {
          ids.delete(notice.id);
          dismissNotice(notice.id);
        },
      });
      ids.set(notice.id, toastId);
    }
  }, [list]);

  useEffect(() => {
    const ids = toastIds.current;
    return () => {
      for (const toastId of ids.values()) useToastStore.getState().removeToast(toastId);
      ids.clear();
    };
  }, []);

  return null;
}
