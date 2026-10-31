"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { registerComposer, type ComposerMetadata } from "@/lib/plugin-sandbox/composer-registry";
import { replaceTextareaRange, textToEditorHtml } from "@/lib/plugin-sandbox/composer-edit";
import { generateUUID } from "@/lib/utils";
import { ComposerPluginToolbarButtons } from "./composer-toolbar-menu";

type Props = {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  readMetadata: () => ComposerMetadata;
  onChange: (text: string) => void;
};

/** Own the quick-reply capability without an extra reading-pane render.
 * 읽기 화면을 추가 렌더링하지 않고 간단 답장의 플러그인 핸들을 관리합니다. */
export function QuickReplyPluginActions({ inputRef, readMetadata, onChange }: Props) {
  const [composerId] = useState(generateUUID);
  const metadataRef = useRef(readMetadata);
  metadataRef.current = readMetadata;
  useEffect(() => {
    const registration = registerComposer({
      readBody: () => { const text = inputRef.current?.value ?? ''; return { text, html: textToEditorHtml(text) }; },
      readMetadata: () => metadataRef.current(),
      readSelection: () => {
        const input = inputRef.current;
        const text = input?.value.slice(input.selectionStart, input.selectionEnd) ?? '';
        return { text, html: textToEditorHtml(text), empty: !text };
      },
      replaceBody: (_html, text) => {
        const input = inputRef.current;
        if (!input || input.disabled) return false;
        const changed = replaceTextareaRange(input, 0, input.value.length, text);
        if (changed) onChange(input.value);
        return changed;
      },
      replaceSelection: (_html, text, { below }) => {
        const input = inputRef.current;
        if (!input || input.disabled) return false;
        let from = input.selectionStart;
        let replacement = text;
        if (below) { from = input.selectionEnd; replacement = `\n\n${text}`; }
        const changed = replaceTextareaRange(input, from, input.selectionEnd, replacement);
        if (changed) onChange(input.value);
        return changed;
      },
      attach: async () => false,
    }, composerId);
    return registration.unregister;
  }, [composerId, inputRef, onChange]);
  return <ComposerPluginToolbarButtons alwaysVisible surface="composer-toolbar-actions" context={() => ({ composerId })} />;
}
