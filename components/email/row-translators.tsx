"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTranslations } from "next-intl";

type Values = Record<string, string | number | Date | null | undefined>;
/** A translator of one namespace that remembers what it said. */
export type RowTranslator = (key: string, values?: Values) => string;

export interface RowTranslators {
  /** email_viewer */
  viewer: RowTranslator;
  /** email_list */
  list: RowTranslator;
  /** email_list.batch_actions */
  batch: RowTranslator;
  /** settings.email_behavior.hover_actions */
  hover: RowTranslator;
  /** threads */
  threads: RowTranslator;
  /** sidebar */
  sidebar: RowTranslator;
}

/** `translate` with each answer kept: rows ask the same few words again and again. */
function remembering(translate: (key: string, values?: Values) => string): RowTranslator {
  const said = new Map<string, string>();
  return (key, values) => {
    let id = key;
    if (values) {
      for (const name of Object.keys(values)) {
        const value = values[name];
        // A date isn't a plain value: ask afresh.
        if (value instanceof Date) return translate(key, values);
        id += `\u0000${name}\u0000${value}`;
      }
    }
    let text = said.get(id);
    if (text === undefined) {
      text = translate(key, values);
      // A long list of subjects shouldn't keep every one.
      if (said.size > 500) said.clear();
      said.set(id, text);
    }
    return text;
  };
}

const RowTranslatorsContext = createContext<RowTranslators | null>(null);

function useMakeRowTranslators(): RowTranslators {
  const viewer = useTranslations("email_viewer");
  const list = useTranslations("email_list");
  const batch = useTranslations("email_list.batch_actions");
  const hover = useTranslations("settings.email_behavior.hover_actions");
  const threads = useTranslations("threads");
  const sidebar = useTranslations("sidebar");
  // New translators (another language, the rest of the catalog) start a new memory.
  return useMemo(() => ({
    viewer: remembering(viewer as RowTranslator),
    list: remembering(list as RowTranslator),
    batch: remembering(batch as RowTranslator),
    hover: remembering(hover as RowTranslator),
    threads: remembering(threads as RowTranslator),
    sidebar: remembering(sidebar as RowTranslator),
  }), [viewer, list, batch, hover, threads, sidebar]);
}

/**
 * The words of the message rows, made once for the whole list instead of six
 * translators and the same lookups in every row on every render.
 */
export function RowTranslatorsProvider({ children }: { children: ReactNode }) {
  const translators = useMakeRowTranslators();
  return <RowTranslatorsContext.Provider value={translators}>{children}</RowTranslatorsContext.Provider>;
}

/** The list's row words; null outside a RowTranslatorsProvider. */
export function useRowTranslators(): RowTranslators | null {
  return useContext(RowTranslatorsContext);
}
