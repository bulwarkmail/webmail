"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/stores/auth-store";
import { useAccountStore } from "@/stores/account-store";
import { usePolicyStore } from "@/stores/policy-store";
import { policySubjectForClient } from "@/lib/admin/policy-subject";
import type { PolicySubject } from "@/lib/admin/policy-scopes";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { flushComposers } from "@/lib/compose-flush-registry";
import { openActivityChannel, readLastActivity, type ActivityChannel } from "@/lib/session-policy/activity-channel";
import { onFrameActivity } from "@/lib/session-policy/frame-activity";
import {
  NO_SESSION_LIMITS,
  sameLimits,
  sessionLimits,
  setCurrentSessionLimits,
  type AccountSession,
  type SessionLimits,
} from "@/lib/session-policy/limits";
import { createSessionTimer, type SessionEndKind, type SessionTimer, type SessionTimerState } from "@/lib/session-policy/session-timer";
import { rememberSessionEnd, type SessionEndReason } from "@/lib/session-policy/sign-out-reason";
import { SessionTimeoutDialog } from "./session-timeout-dialog";

/** How long the sign-out waits for the open composers to save their drafts (and for sends in flight). */
export const DRAFT_FLUSH_TIMEOUT_MS = 8000;
/** Local activity reaches the timer and the other tabs at most this often. */
const ACTIVITY_THROTTLE_MS = 1000;
/**
 * Bubbling input events, caught on the way down. Scrolling and focus moves
 * inside the page don't count: the page scrolls and refocuses on its own.
 * Input inside a frame never reaches this window. Plugin frames report the
 * same events from inside (lib/session-policy/frame-activity.ts); other
 * frames (the office editor) don't count, and neither does a frame merely
 * having the focus: a focused frame left alone would keep the session open
 * forever. Users working there see the warning, which sits above every
 * overlay, and choose to stay.
 */
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel"] as const;

/** Policy subjects per client and connection round; a failed or empty answer is asked again. */
const subjects = new WeakMap<IJMAPClient, { revision: number; subject: Promise<PolicySubject | null> }>();
function subjectFor(client: IJMAPClient, revision: number): Promise<PolicySubject | null> {
  const cached = subjects.get(client);
  if (cached && cached.revision === revision) return cached.subject;
  const subject = policySubjectForClient(client).catch(() => null);
  subjects.set(client, { revision, subject });
  void subject.then((value) => {
    if (value === null && subjects.get(client)?.subject === subject) subjects.delete(client);
  });
  return subject;
}

/** The limits of every account signed in here, each with its own domain and group scopes. */
async function collectLimits(revision: number): Promise<SessionLimits> {
  const auth = useAuthStore.getState();
  const clients = new Map<string, IJMAPClient>(auth.getAllConnectedClients());
  if (auth.client && auth.activeAccountId && !clients.has(auth.activeAccountId)) clients.set(auth.activeAccountId, auth.client);
  const accounts: AccountSession[] = await Promise.all([...clients.entries()].map(async ([accountId, client]) => {
    const subject = await subjectFor(client, revision);
    const session = usePolicyStore.getState().resolveFor(subject).organisation?.session;
    return { session, signedInAt: signedInAtFor(accountId) };
  }));
  return sessionLimits(accounts);
}

/**
 * When the account signed in. An account signed in before this was recorded
 * counts as signed in now, the first time it is seen.
 */
function signedInAtFor(accountId: string): number | undefined {
  const store = useAccountStore.getState();
  const account = store.getAccountById(accountId);
  if (!account) return undefined;
  if (typeof account.signedInAt === "number") return account.signedInAt;
  const now = Date.now();
  store.updateAccount(accountId, { signedInAt: now });
  return now;
}

function endReason(kind: SessionEndKind, limits: SessionLimits, draftsUnsaved: boolean): SessionEndReason {
  const drafts = draftsUnsaved ? { draftsUnsaved: true } : {};
  return kind === "max"
    ? { kind: "max", hours: limits.max?.hours ?? 0, ...drafts }
    : { kind: "idle", minutes: limits.idle?.minutes ?? 0, ...drafts };
}

const IDLE_STATE: SessionTimerState = { phase: "active", kind: null, deadline: null };

/**
 * The organisation's idle timeout and maximum session length
 * (policy.json `organisation.session`). Activity in any Bulwark tab keeps
 * every tab signed in; a warning counts down first; at zero the open and
 * minimised composers save their drafts and every account signs out, with
 * the reason on the login page. What the accounts keep on the device hides until
 * the next sign-in, unless the organisation asks for deletion at once.
 */
export function SessionTimeoutGuard() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isDemoMode = useAuthStore((s) => s.isDemoMode);
  const client = useAuthStore((s) => s.client);
  const revision = useAuthStore((s) => s.connectedAccountsRevision);
  const rawPolicy = usePolicyStore((s) => s.rawPolicy);
  const accountsKey = useAccountStore((s) => s.accounts.map((a) => `${a.id}|${a.signedInAt ?? ""}|${a.isConnected}`).join(","));

  // The last activity any tab recorded, read once before this tab's own
  // listeners can write it: a reload after a pause longer than the limit
  // signs out right away, whatever the user does while the page loads.
  const [mount] = useState(() => ({ at: Date.now(), lastActivity: readLastActivity() }));
  const [limits, setLimits] = useState<SessionLimits>(NO_SESSION_LIMITS);
  const [limitsReady, setLimitsReady] = useState(false);
  const [state, setState] = useState<SessionTimerState>(IDLE_STATE);
  const [ending, setEnding] = useState(false);
  const [dismissedMax, setDismissedMax] = useState<number | null>(null);
  const timerRef = useRef<SessionTimer | null>(null);
  const timersStartedRef = useRef(0);
  const channelRef = useRef<ActivityChannel | null>(null);
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const limitsReadyRef = useRef(limitsReady);
  limitsReadyRef.current = limitsReady;
  const endingRef = useRef(false);
  const active = isAuthenticated && !isDemoMode;

  useEffect(() => {
    if (!active) {
      setLimits(NO_SESSION_LIMITS);
      setLimitsReady(false);
      return;
    }
    let cancelled = false;
    void collectLimits(revision).then((next) => {
      if (cancelled) return;
      setLimits((prev) => (sameLimits(prev, next) ? prev : next));
      setLimitsReady(true);
    });
    return () => { cancelled = true; };
  }, [active, client, revision, rawPolicy, accountsKey]);

  useEffect(() => {
    setCurrentSessionLimits(active ? limits : null);
  }, [active, limits]);

  const endSession = useCallback(async (kind: SessionEndKind) => {
    if (endingRef.current) return;
    endingRef.current = true;
    setEnding(true);
    const current = limitsRef.current;
    // Said first, in case another tab's sign-out takes this one to the login page meanwhile.
    rememberSessionEnd(endReason(kind, current, false));
    const flushed = await flushComposers(DRAFT_FLUSH_TIMEOUT_MS);
    if (flushed.failed > 0 || flushed.timedOut) rememberSessionEnd(endReason(kind, current, true));
    // Nobody asked: the mail hides until the next sign-in, and unsent messages with it.
    await useAuthStore.getState().logoutAll({ endProviderSession: false, keepLocalData: true, sessionLimit: true });
  }, []);

  // The clock, while there is a limit to count.
  const hasLimits = active && limitsReady && (!!limits.idle || !!limits.max);
  useEffect(() => {
    if (!hasLimits) {
      timerRef.current?.dispose();
      timerRef.current = null;
      setState(IDLE_STATE);
      return;
    }
    if (timerRef.current) {
      timerRef.current.setLimits(limits);
      return;
    }
    // The first clock of this page starts from the activity recorded before
    // the page loaded, a fresh sign-in from the sign-in. A clock started
    // later (limits turned on meanwhile) from what the tabs recorded since.
    const stored = timersStartedRef.current === 0 ? mount.lastActivity ?? mount.at : readLastActivity() ?? Date.now();
    const newestSignIn = Math.max(0, ...useAccountStore.getState().accounts.map((a) => a.signedInAt ?? 0));
    timersStartedRef.current += 1;
    timerRef.current = createSessionTimer({
      limits,
      lastActivity: Math.max(stored, newestSignIn),
      onChange: setState,
      onExpire: (kind) => { void endSession(kind); },
    });
    setState(timerRef.current.state());
  }, [hasLimits, limits, endSession, mount]);

  useEffect(() => () => {
    timerRef.current?.dispose();
    timerRef.current = null;
  }, []);

  useEffect(() => {
    if (!active) {
      endingRef.current = false;
      setEnding(false);
    }
  }, [active]);

  // Activity in this tab (its plugin frames too) and the others.
  useEffect(() => {
    const channel = openActivityChannel((at) => timerRef.current?.remoteActivity(at));
    channelRef.current = channel;
    let lastSeen = 0;
    const onActivity = () => {
      // Nothing counts until the limits of the signed-in accounts are known:
      // the clock starts from what was recorded before.
      if (endingRef.current || !limitsReadyRef.current) return;
      const at = Date.now();
      if (at - lastSeen < ACTIVITY_THROTTLE_MS) return;
      const timer = timerRef.current;
      if (timer) {
        timer.activity(at);
        // During the idle warning only "Stay signed in" counts.
        const s = timer.state();
        if (s.phase === "expired" || (s.phase === "warning" && s.kind === "idle")) return;
      }
      lastSeen = at;
      channel.post(at);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") timerRef.current?.check();
    };
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, onActivity, { capture: true, passive: true });
    // Input in plugin frames, which never reaches this window.
    const offFrames = onFrameActivity(onActivity);
    // The window coming back into focus, not focus moving between elements.
    window.addEventListener("focus", onActivity);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onActivity, { capture: true });
      offFrames();
      window.removeEventListener("focus", onActivity);
      document.removeEventListener("visibilitychange", onVisibility);
      channel.close();
      channelRef.current = null;
    };
  }, []);

  const stay = useCallback(() => {
    const timer = timerRef.current;
    if (!timer) return;
    timer.stay();
    channelRef.current?.post(timer.lastActivity());
  }, []);

  const signOutNow = useCallback(() => {
    const kind = timerRef.current?.state().kind ?? "idle";
    void endSession(kind);
  }, [endSession]);

  if (!active) return null;
  if (ending) {
    return <SessionTimeoutDialog mode="ending" deadline={null} onStay={stay} onDismiss={stay} onSignOut={signOutNow} />;
  }
  if (state.phase !== "warning" || !state.kind) return null;
  if (state.kind === "max" && dismissedMax === state.deadline) return null;
  return (
    <SessionTimeoutDialog
      mode={state.kind}
      deadline={state.deadline}
      maxHours={limits.max?.hours}
      onStay={stay}
      onDismiss={() => setDismissedMax(state.deadline)}
      onSignOut={signOutNow}
    />
  );
}
