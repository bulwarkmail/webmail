"use client";

// Proofreading in one composer: runs the checker plugins (see
// lib/proofreading/composer-proofreader.ts) on the editor or the plain-text
// textarea, draws their underlines and applies the fixes the user picks.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { ComposerProofreader, type DismissAction, type PlacedIssue, type ProofreaderStatus } from "@/lib/proofreading/composer-proofreader";
import { checkerAccess, type PolicyView } from "@/lib/proofreading/gate";
import { draftProtection, OPTIONS_SURFACE } from "@/lib/proofreading/protection";
import { plainSegments, richSegments } from "@/lib/proofreading/segments";
import { allCheckers, dispatchCheck, dispatchCheckerAction, registerCheckTarget, subscribeCheckers } from "@/lib/plugin-sandbox/checkers";
import { actionsFor, subscribeActions } from "@/lib/plugin-sandbox/actions";
import { all as allActivePlugins, subscribe as subscribeActivePlugins } from "@/lib/plugin-sandbox/registry";
import { replaceTextareaRange, type PlainOwnOptions } from "@/lib/plugin-sandbox/composer-edit";
import { usePolicyStore } from "@/stores/policy-store";
import { useSettingsStore } from "@/stores/settings-store";
import { applyIssueReplacement, setTextIssues } from "./text-check-extension";

/** The policy as the gate needs it, read now. */
export function currentPolicyView(): PolicyView {
  const s = usePolicyStore.getState();
  return {
    restrictions: s.policy.restrictions ?? {},
    defaults: (s.policy.defaults ?? {}) as Record<string, unknown>,
    settled: s.loaded && !s.partial && !s.subjectPending,
  };
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
}

const EMPTY_STATUS: ProofreaderStatus = {
  available: false, on: false, forced: false, lockedOff: false, paused: null,
  checking: false, trouble: null, count: 0, activeLabels: [],
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
      protection: () => draftProtection(actionsFor(OPTIONS_SURFACE), allActivePlugins().map((e) => e.plugin)),
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
    if (!editor || editor.isDestroyed || plainTextMode) return;
    const ranges = issues.map((i) => ({ key: i.key, from: i.from, to: i.to, kind: i.kind, text: i.annotation.text }));
    const signature = ranges.map((r) => `${r.key}@${r.from}`).join(",");
    if (signature === drawnRef.current) return;
    drawnRef.current = signature;
    setTextIssues(editor, ranges);
  }, [editor, issues, plainTextMode]);

  const setComposerOn = useCallback((on: boolean) => {
    composerSwitches.set(sessionKey, on);
    composerOnRef.current = on;
    setComposerOnState(on);
    proofreader?.gateChanged();
  }, [sessionKey, proofreader]);

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
    if (done) proofreader.edited("now");
    bump();
    return done;
  }, [proofreader, textareaRef]);

  const dismiss = useCallback((issue: PlacedIssue, action: DismissAction) => {
    proofreader?.dismiss(issue, action);
  }, [proofreader]);

  const sendWarningIssues = useCallback(() => proofreader?.issuesForSendWarning() ?? [], [proofreader]);

  return { issues, status, composerOn, setComposerOn, apply, dismiss, browserSpellcheck, sendWarningIssues };
}
