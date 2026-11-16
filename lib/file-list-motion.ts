import { useFileStore } from "@/stores/file-store";
import { around, depart, NOOP, shown, type Departure, type Surface } from "./list-motion";

const FILES: Surface = {
  items: () => [...document.querySelectorAll<HTMLElement>('[data-resource], [role="grid"] [role="rowgroup"] > h3')],
  keyOf: (el) => el.getAttribute("data-resource") ?? `heading:${el.textContent?.trim()}`,
  watch: ["data-resource"],
  settleMs: 6000,
  closes: "layout",
  handOff: (el) => {
    const scope = el.closest('[role="grid"]') ?? el.parentElement;
    const files = [...(scope?.querySelectorAll<HTMLElement>("[data-resource]") ?? [])].filter((n) => n.style.display !== "none");
    const heir = files.find((n) => el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)
      ?? files.reverse().find((n) => el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING);
    return { to: heir ?? null, back: () => {} };
  },
};

export function departFiles(names: string[]): Departure {
  if (typeof document === "undefined" || names.length === 0) return NOOP;
  const rows = names
    .map((name) => [...document.querySelectorAll(`[data-resource="${CSS.escape(name)}"]`)].find(shown))
    .filter((el): el is HTMLElement => !!el);
  return depart(rows, FILES);
}

export function departing<T>(names: string[], action: () => Promise<T>): Promise<T> {
  return around(departFiles(names), action);
}

export function namesOfNode(id: string): string[] {
  const name = useFileStore.getState().resources.find((r) => r.id === id)?.name;
  return name ? [name] : [];
}
