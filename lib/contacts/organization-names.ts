import type { ContactCard } from "@/lib/jmap/types";

/**
 * Every organization name the loaded cards use: the organization of a person,
 * and the name of an organization card (kind "org"). Names that differ only in
 * case are one entry, spelled as first seen. Sorted as the language sorts.
 */
export function collectOrganizationNames(contacts: readonly ContactCard[], locale?: string): string[] {
  const names = new Map<string, string>();
  const add = (value: string | undefined) => {
    const name = value?.trim();
    if (!name) return;
    const key = name.toLocaleLowerCase();
    if (!names.has(key)) names.set(key, name);
  };
  for (const contact of contacts) {
    if (contact.kind === "group") continue;
    for (const org of Object.values(contact.organizations ?? {})) add(org?.name);
    if (contact.kind === "org") add(contact.name?.full);
  }
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  return [...names.values()].sort(collator.compare);
}

/**
 * The names that contain what was typed, ignoring case, those starting with
 * it first. Nothing while the field is empty; the name typed exactly is left
 * out, longer ones that start with it stay.
 */
export function matchOrganizationNames(names: readonly string[], typed: string, limit = 8): string[] {
  const query = typed.trim().toLocaleLowerCase();
  if (!query) return [];
  const starts: string[] = [];
  const contains: string[] = [];
  for (const name of names) {
    const lower = name.toLocaleLowerCase();
    if (lower === query) continue;
    if (lower.startsWith(query)) starts.push(name);
    else if (lower.includes(query)) contains.push(name);
  }
  return [...starts, ...contains].slice(0, limit);
}
