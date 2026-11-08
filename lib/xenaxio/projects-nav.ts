// xenaxio steps 118–119: menu entries of object types (rail, Mountain View top
// bar, phone bar): Projects and the company's own types the admin put in the
// menu for this person, in their own order, without the ones they hid. Asked
// once per page load; "My menu" and the type editor refresh it.
import { useEffect } from "react";
import { create } from "zustand";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXenaxioMeStore } from "@/lib/xenaxio/me-store";
import { type MenuItem, projectsApi } from "@/lib/xenaxio/projects";

const useMenuStore = create<{ items: MenuItem[]; asked: boolean; ask: (force?: boolean) => void }>((set, get) => ({
  items: [],
  asked: false,
  ask: (force = false) => {
    if (get().asked && !force) return;
    set({ asked: true });
    void projectsApi
      .menu()
      .then((r) => set({ items: r.items }))
      .catch(() => undefined);
  },
}));

/** After a change to the menu (own order, the admin's editor): read it again. */
export function refreshObjectMenu(items?: MenuItem[]): void {
  if (items) useMenuStore.setState({ items, asked: true });
  else useMenuStore.getState().ask(true);
}

/** The person's visible menu entries of object types (none outside the Xenaxio workspace). */
export function useObjectMenu(): MenuItem[] {
  const me = useXenaxioMeStore((s) => s.me);
  const loadMe = useXenaxioMeStore((s) => s.load);
  const items = useMenuStore((s) => s.items);
  const ask = useMenuStore((s) => s.ask);
  const workspace = !!me && (me.tenant.product ?? "workspace") === "workspace" && me.user.kind !== "chat";
  useEffect(() => {
    if (XENAXIO_BFF) void loadMe();
  }, [loadMe]);
  useEffect(() => {
    if (XENAXIO_BFF && workspace) ask();
  }, [ask, workspace]);
  return XENAXIO_BFF && workspace ? items.filter((i) => !i.hidden) : [];
}
