"use client";

// Proofreading in one composer: runs the checker plugins (see
// lib/proofreading/composer-proofreader.ts) on the editor or the plain-text
// textarea, draws their underlines and applies the fixes the user picks.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { announce } from "@/lib/announce";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { ComposerProofreader, type DismissAction, type PlacedIssue, type ProofreaderStatus } from "@/lib/proofreading/composer-proofreader";
import { checkerAccess, type PolicyView } from "@/lib/proofreading/gate";
import { draftProtection, OPTIONS_SURFACE } from "@/lib/proofreading/protection";
import { plainSegments, richSegments } from "@/lib/proofreading/segments";
import { allCheckers, dispatchCheck, dispatchCheckerAction, registerCheckTarget, subscribeCheckers } from "@/lib/plugin-sandbox/checkers";
import { actionsFor, subscribeActions } from "@/lib/plugin-sandbox/actions";
import { all as allActivePlugins, subscribe as subscribeActivePlugins } from "@/lib/plugin-sandbox/registry";
import { replaceTextareaRange, type PlainOwnOptions } from "@/lib/plugin-sandbox/composer-edit";
import { usePolicyStore } from "@/stores/policy-store";
import { knownPlugins, subscribeKnownPlugins } from "@/lib/plugin-sandbox/known-plugins";
import type { InstalledPlugin } from "@/lib/plugin-types";
import { useSettingsStore } from "@/stores/settings-store";
import {
  applyIssueReplacement, drawnIssues, issueNavigationKey, issueRect, selectNextIssue, setActiveIssue, setTextIssues,
  type IssueOpenVia, type TextCheckOptions,
} from "./text-check-extension";

/**
 * The policy as the gate needs it, read now. Settled only with a policy from
 * the server (or the copy this browser kept of one): when the fetch failed
 * and nothing was ever fetched, the built-in defaults could undo an admin's
 * lock, so nothing is checked.
 */
export function currentPolicyView(): PolicyView {
  const s = usePolicyStore.getState();
  return {
    restrictions: s.policy.restrictions ?? {},
    defaults: (s.policy.defaults ?? {}) as Record<string, unknown>,
    settled: policySettled(s),
  };
}

export function policySettled(s: Pick<ReturnType<typeof usePolicyStore.getState>, 'loaded' | 'partial' | 'subjectPending' | 'source'>): boolean {
  return s.loaded && !s.partial && !s.subjectPending && s.source !== 'fallback' && s.source !== 'none';
}

/** Plugins turned on that aren't running yet (still loading). */
function startingPlugins(running: InstalledPlugin[]): InstalledPlugin[] {
  const up = new Set(running.map((p) => p.id));
  return knownPlugins().filter((p) => p.enabled && p.status !== 'error' && p.status !== 'disabled' && !up.has(p.id));
}

// The per-composer switch outlives a remount (pop-out, layout switch).
const composerSwitches = new Map<string, boolean>();

export interface UseProofreadingArgs {
  composerId: string | null;
  sessionKey: string;
  editor: Editor | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  plainTextMode: boolean;
  ownOptions: RefObject<PlainOwnOptions>;
}

export interface Proofreading {
  issues: PlacedIssue[];
  status: ProofreaderStatus;
  /** The per-composer switch (ignored when the admin requires checking). */
  composerOn: boolean;
  setComposerOn: (on: boolean) => void;
  /** Put a suggestion in; false when the text changed meanwhile. */
  apply: (issue: PlacedIssue, replacement: string) => boolean;
  dismiss: (issue: PlacedIssue, action: DismissAction) => void;
  /** Whether the browser's own spell check should be on. */
  browserSpellcheck: boolean;
  /** Issues of checkers that asked for a warning before sending. */
  sendWarningIssues: () => PlacedIssue[];
  /** The popup on one issue. */
  popup: IssuePopupState | null;
  openPopup: (key: string, anchor: DOMRect | null, via: IssueOpenVia) => void;
  closePopup: (refocus: boolean) => void;
  /** The status control's panel, and the issue to focus in its list. */
  panel: { focusKey: string | null } | null;
  setPanel: (panel: { focusKey: string | null } | null) => void;
  navigate: (dir: 1 | -1) => boolean;
  /** From the list: select the issue in the text and open its popup. */
  jumpTo: (issue: PlacedIssue) => void;
  /** For the rich editor (RichTextEditor's textCheck prop). */
  editorHandlers: TextCheckOptions;
}

export interface IssuePopupState {
  key: string;
  anchor: DOMRect | null;
  via: IssueOpenVia;
}

const EMPTY_STATUS: ProofreaderStatus = {
  available: false, on: false, userOn: false, forced: false, lockedOff: false, paused: null,
  checking: false, trouble: null, count: 0, activeLabels: [], activePlugins: [], availablePlugins: [],
};

export function useProofreading({ composerId, sessionKey, editor, textareaRef, plainTextMode, ownOptions }: UseProofreadingArgs): Proofreading {
  const checkers = useSyncExternalStore(subscribeCheckers, allCheckers, allCheckers);
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const [proofreader, setProofreader] = useState<ComposerProofreader | null>(null);
  const [composerOn, setComposerOnState] = useState(() => composerSwitches.get(sessionKey) ?? true);
  const composerOnRef = useRef(composerOn);
  composerOnRef.current = composerOn;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const t = useTranslations("proofreading");
  const tRef = useRef(t);
  tRef.current = t;
  const plainRef = useRef(plainTextMode);
  plainRef.current = plainTextMode;
  const hasCheckers = checkers.length > 0;

  useEffect(() => {
    if (!composerId || !hasCheckers) return;
    const p = new ComposerProofreader({
      composerId,
      checkers: allCheckers,
      readSegments: () => {
        const opts = ownOptions.current ?? {};
        if (plainRef.current) return plainSegments(textareaRef.current?.value ?? "", opts);
        const ed = editorRef.current;
        return ed && !ed.isDestroyed ? richSegments(ed.state.doc, opts) : [];
      },
      language: () => useSettingsStore.getState().writingLanguage,
      access: (pluginId) => checkerAccess(currentPolicyView(), useSettingsStore.getState(), pluginId),
      protection: () => {
        const running = allActivePlugins().map((e) => e.plugin);
        return draftProtection(actionsFor(OPTIONS_SURFACE), running, startingPlugins(running));
      },
      composerOn: () => composerOnRef.current,
      send: (spec, request) => dispatchCheck(spec, request),
      action: (spec, payload) => dispatchCheckerAction(spec, payload),
      onChange: bump,
    });
    setProofreader(p);
    const unsubscribe = [
      registerCheckTarget(composerId, {
        getCheckText: (spec) => p.getCheckText(spec),
        setAnnotations: (spec, revision, raw) => p.setAnnotations(spec, revision, raw),
      }),
      subscribeCheckers(() => p.sync()),
      subscribeActions(() => p.gateChanged()),
      subscribeActivePlugins(() => p.gateChanged()),
      subscribeKnownPlugins(() => p.gateChanged()),
      usePolicyStore.subscribe(() => p.gateChanged()),
      useSettingsStore.subscribe((s, prev) => {
        if (s.writingLanguage !== prev.writingLanguage) p.edited("now");
        if (s.proofreading !== prev.proofreading || s.proofreadingPlugins !== prev.proofreadingPlugins) p.gateChanged();
      }),
    ];
    return () => {
      for (const u of unsubscribe) u();
      p.dispose();
      setProofreader(null);
    };
  }, [composerId, hasCheckers, ownOptions, textareaRef]);

  // Typing, pasting and leaving the text.
  useEffect(() => {
    if (!proofreader) return;
    if (plainTextMode) {
      const ta = textareaRef.current;
      if (!ta) return;
      const typing = () => proofreader.edited("typing");
      const now = () => setTimeout(() => proofreader.edited("now"), 0);
      ta.addEventListener("input", typing);
      ta.addEventListener("paste", now);
      ta.addEventListener("blur", now);
      proofreader.edited("now");
      return () => {
        ta.removeEventListener("input", typing);
        ta.removeEventListener("paste", now);
        ta.removeEventListener("blur", now);
      };
    }
    if (!editor || editor.isDestroyed) return;
    const typing = () => proofreader.edited("typing");
    const now = () => setTimeout(() => proofreader.edited("now"), 0);
    const dom = editor.view.dom;
    editor.on("update", typing);
    dom.addEventListener("paste", now);
    editor.on("blur", now);
    proofreader.edited("now");
    return () => {
      editor.off("update", typing);
      dom.removeEventListener("paste", now);
      editor.off("blur", now);
    };
  }, [proofreader, editor, plainTextMode, textareaRef]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the change signal
  const issues = useMemo(() => proofreader?.issues() ?? [], [proofreader, version, plainTextMode]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the change signal
  const status = useMemo(() => proofreader?.status() ?? EMPTY_STATUS, [proofreader, version, composerOn]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the change signal
  const browserSpellcheck = useMemo(() => proofreader?.browserSpellcheck() ?? true, [proofreader, version, composerOn]);

  // Underlines in the rich editor.
  const drawnRef = useRef("");
  useEffect(() => {
    if (!editor || editor.isDestroyed || !editor.state || plainTextMode) return;
    const ranges = issues.map((i) => ({ key: i.key, from: i.from, to: i.to, kind: i.kind, text: i.annotation.text }));
    const signature = ranges.map((r) => `${r.key}@${r.from}`).join(",");
    if (signature === drawnRef.current) return;
    drawnRef.current = signature;
    setTextIssues(editor, ranges);
  }, [editor, issues, plainTextMode]);

  // Which underlines are still there: typing into one removes it at once,
  // and the list and the count follow.
  const [drawnKeys, setDrawnKeys] = useState<string[] | null>(null);
  useEffect(() => {
    if (!editor || editor.isDestroyed || !editor.state || plainTextMode) { setDrawnKeys(null); return; }
    const read = () => {
      const keys = drawnIssues(editor.state).map((r) => r.key);
      setDrawnKeys((prev) => (prev && prev.length === keys.length && prev.every((k, i) => k === keys[i]) ? prev : keys));
    };
    read();
    editor.on("transaction", read);
    return () => { editor.off("transaction", read); };
  }, [editor, plainTextMode]);
  const visibleIssues = useMemo(() => {
    if (drawnKeys === null) return issues;
    const keep = new Set(drawnKeys);
    return issues.filter((i) => keep.has(i.key));
  }, [issues, drawnKeys]);
  const visibleStatus = useMemo(
    () => (status.count === visibleIssues.length ? status : { ...status, count: visibleIssues.length }),
    [status, visibleIssues.length],
  );

  const setComposerOn = useCallback((on: boolean) => {
    composerSwitches.set(sessionKey, on);
    composerOnRef.current = on;
    setComposerOnState(on);
    proofreader?.gateChanged();
  }, [sessionKey, proofreader]);

  // ─── The popup on an issue, and the list in the status control ───
  const [popup, setPopup] = useState<IssuePopupState | null>(null);
  const [panel, setPanel] = useState<{ focusKey: string | null } | null>(null);
  const popupRef = useRef(popup);
  popupRef.current = popup;
  const visibleRef = useRef(visibleIssues);
  visibleRef.current = visibleIssues;

  const openPopup = useCallback((key: string, anchor: DOMRect | null, via: IssueOpenVia) => {
    setPanel(null);
    setPopup({ key, anchor, via });
    const ed = editorRef.current;
    if (ed && !plainRef.current) setActiveIssue(ed, key);
  }, []);

  const closePopup = useCallback((refocus: boolean) => {
    setPopup(null);
    const ed = editorRef.current;
    if (ed && !ed.isDestroyed && !plainRef.current) {
      setActiveIssue(ed, null);
      if (refocus) ed.commands.focus();
    } else if (refocus) {
      textareaRef.current?.focus();
    }
  }, [textareaRef]);

  /** Go to the next or previous issue: in the text (rich) or in the list (plain). */
  const navigate = useCallback((dir: 1 | -1) => {
    const list = visibleRef.current;
    if (!list.length) {
      if (composerOnRef.current) announce(tRef.current("panel.no_issues"), { key: "proofreading-count" });
      return false;
    }
    const ed = editorRef.current;
    if (ed && !plainRef.current) {
      const key = selectNextIssue(ed, dir);
      if (!key) return false;
      openPopup(key, issueRect(ed, key), "keyboard");
      return true;
    }
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? start;
    const next = dir === 1
      ? list.find((i) => i.from >= end && !(i.from === start && i.to === end)) ?? list[0]
      : [...list].reverse().find((i) => i.to <= start && !(i.from === start && i.to === end)) ?? list[list.length - 1];
    ta?.setSelectionRange(next.from, next.to);
    setPopup(null);
    setPanel({ focusKey: next.key });
    return true;
  }, [openPopup, textareaRef]);

  /** Show an issue from the list: select it in the text and open its popup. */
  const jumpTo = useCallback((issue: PlacedIssue) => {
    const ed = editorRef.current;
    if (!ed || plainRef.current) return;
    const range = drawnIssues(ed.state).find((r) => r.key === issue.key);
    if (!range) return;
    // Focus now, not later as TipTap's focus command does: a late focus
    // would pull the keyboard out of the popup again.
    ed.view.focus();
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, range.from, range.to)).scrollIntoView());
    openPopup(issue.key, issueRect(ed, issue.key), "keyboard");
  }, [openPopup]);

  // Keys in the rich text (see text-check-extension.ts).
  const editorHandlers = useMemo<TextCheckOptions>(() => ({
    onOpen: openPopup,
    onKey: (event) => {
      if (event.key === "Escape" && popupRef.current) {
        closePopup(true);
        return true;
      }
      const dir = issueNavigationKey(event);
      if (dir && navigate(dir)) {
        event.preventDefault();
        return true;
      }
      return false;
    },
  }), [openPopup, closePopup, navigate]);

  // The same keys in the plain-text composer.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!plainTextMode || !ta || !proofreader) return;
    const onKey = (event: KeyboardEvent) => {
      const dir = issueNavigationKey(event);
      if (dir && navigate(dir)) event.preventDefault();
    };
    ta.addEventListener("keydown", onKey);
    return () => ta.removeEventListener("keydown", onKey);
  }, [plainTextMode, textareaRef, proofreader, navigate]);

  // An issue that went away (fixed, typed over) closes its popup.
  // With the focus in it, the focus goes back to the text.
  useEffect(() => {
    if (!popup || visibleIssues.some((i) => i.key === popup.key)) return;
    const focusInside = !!(document.activeElement as Element | null)?.closest?.('[data-testid="proofreading-popup"]');
    closePopup(focusInside);
  }, [popup, visibleIssues, closePopup]);

  const apply = useCallback((issue: PlacedIssue, replacement: string): boolean => {
    if (!proofreader) return false;
    let done = false;
    if (plainRef.current) {
      const ta = textareaRef.current;
      // Where the issue is now, and only if it still says the same.
      const now = ta ? proofreader.issues().find((i) => i.key === issue.key) : undefined;
      if (ta && now && ta.value.slice(now.from, now.to) === issue.annotation.text) {
        done = replaceTextareaRange(ta, now.from, now.to, replacement);
      }
    } else if (editorRef.current) {
      done = applyIssueReplacement(editorRef.current, issue.key, replacement);
    }
    if (done) {
      proofreader.edited("now");
      setPopup(null);
      const ed = editorRef.current;
      if (ed && !plainRef.current) { setActiveIssue(ed, null); ed.commands.focus(); }
    }
    bump();
    return done;
  }, [proofreader, textareaRef]);

  const dismiss = useCallback((issue: PlacedIssue, action: DismissAction) => {
    proofreader?.dismiss(issue, action);
    if (popupRef.current?.key === issue.key) closePopup(true);
  }, [proofreader, closePopup]);

  const sendWarningIssues = useCallback(() => proofreader?.issuesForSendWarning() ?? [], [proofreader]);

  return {
    issues: visibleIssues, status: visibleStatus, composerOn, setComposerOn, apply, dismiss, browserSpellcheck, sendWarningIssues,
    popup, openPopup, closePopup, panel, setPanel, navigate, jumpTo, editorHandlers,
  };
}
