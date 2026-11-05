// Composer lifecycle hooks: onComposerOpen, onComposerClose, onDraftAutoSave.
//
// The composer component is not the composer session: the host remounts it
// when it moves (Mountain View's pop-out window, a layout switch), which is
// not the user closing and reopening it. So a session is identified by a key
// the host keeps for as long as it means the same message, and an unmount
// only counts as a close when no composer with that key mounts again right
// after it.
//
// Observers never get in the way of the composer: a missing or broken bus is
// ignored here (composer tests replace the hook module with partial doubles).

import type { ComposerContext } from './plugin-types';
import { emailHooks } from './plugin-hooks';
import { splitLinkParams, type LinkParams } from './plugin-link-params';

const openSessions = new Set<string>();
const pendingCloses = new Map<string, ReturnType<typeof setTimeout>>();

/** A composer with this session key is on screen. */
export function composerMounted(sessionKey: string, context: ComposerContext): void {
  const pending = pendingCloses.get(sessionKey);
  if (pending !== undefined) {
    // Remounted in place: the same session goes on.
    clearTimeout(pending);
    pendingCloses.delete(sessionKey);
    return;
  }
  if (openSessions.has(sessionKey)) return;
  openSessions.add(sessionKey);
  try {
    if (emailHooks.onComposerOpen.size > 0) void emailHooks.onComposerOpen.emit(context);
  } catch { /* observers never break the composer */ }
}

/**
 * The composer with this key went away. Reported as closed unless it mounts
 * again before the next task. `info` is read when the close is reported, so a
 * send that finishes while the host tears the composer down still counts.
 */
export function composerUnmounted(sessionKey: string, info: () => { draftId: string | null; sent: boolean }): void {
  if (!openSessions.has(sessionKey) || pendingCloses.has(sessionKey)) return;
  pendingCloses.set(sessionKey, setTimeout(() => {
    pendingCloses.delete(sessionKey);
    openSessions.delete(sessionKey);
    try {
      if (emailHooks.onComposerClose.size > 0) void emailHooks.onComposerClose.emit(info());
    } catch { /* observers never break the composer */ }
  }, 0));
}

/** A draft was saved on the server. */
export function draftSaved(draftId: string, subject: string): void {
  try {
    if (emailHooks.onDraftAutoSave.size > 0) void emailHooks.onDraftAutoSave.emit({ draftId, subject });
  } catch { /* observers never break the composer */ }
}

/**
 * Hand each plugin its parameters from the link the composer `composerId`
 * opened from (lib/plugin-link-params.ts), once the plugins have started
 * (`ready`): onComposeFromLink, to that plugin only.
 */
export async function deliverLinkParams(composerId: string, params: LinkParams, ready: () => Promise<void>): Promise<void> {
  await ready();
  const bus = emailHooks.onComposeFromLink;
  if (!bus || bus.size === 0) return;
  for (const [pluginId, own] of splitLinkParams(params, bus.pluginIds())) {
    await emailHooks.onComposeFromLink.emitTo(pluginId, { composerId, params: own });
  }
}

/** Forget every session (tests). */
export function resetComposerSessions(): void {
  for (const timer of pendingCloses.values()) clearTimeout(timer);
  pendingCloses.clear();
  openSessions.clear();
}

/** The plugin-facing name of a composer mode. */
export function composerContextMode(mode: 'compose' | 'reply' | 'replyAll' | 'forward'): ComposerContext['mode'] {
  return mode === 'compose' ? 'new' : mode === 'replyAll' ? 'reply-all' : mode;
}
