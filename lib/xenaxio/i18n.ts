// Strings of the xenaxio pages (sign-in, onboarding, workspace admin, operator).
// Kept apart from Bulwark's locales/*/common.json so upstream merges stay
// clean; the product supports German and English (spec W6), every other
// locale falls back to English.
import { useCallback } from "react";
import { useLocale } from "next-intl";
import de from "./messages-de.json";
import en from "./messages-en.json";

type Tree = { [key: string]: string | Tree };
const CATALOGS: Record<string, Tree> = { de, en };

function lookup(tree: Tree, path: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function translate(locale: string, key: string, values?: Record<string, string | number>): string {
  const base = locale.split("-")[0] ?? "en";
  const text = lookup(CATALOGS[base] ?? en, key) ?? lookup(en, key) ?? key;
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

/** `t("login.title")`, `t("domain.last_checked", { time })` */
export function useXT() {
  const locale = useLocale();
  return useCallback((key: string, values?: Record<string, string | number>) => translate(locale, key, values), [locale]);
}
