// xenaxio step 118: the "Projekte" entry of the navigation (rail, Mountain View
// top bar, phone bar). Every company of the Xenaxio workspace has projects
// (D1); companies without email (XenRooms) get them with XenBoards later.
import { useEffect } from "react";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useXT } from "@/lib/xenaxio/i18n";
import { useXenaxioMeStore } from "@/lib/xenaxio/me-store";

export function useProjectsNavItem(): { visible: boolean; label: string } {
  const t = useXT();
  const me = useXenaxioMeStore((s) => s.me);
  const load = useXenaxioMeStore((s) => s.load);
  useEffect(() => {
    if (XENAXIO_BFF) void load();
  }, [load]);
  const workspace = !!me && (me.tenant.product ?? "workspace") === "workspace" && me.user.kind !== "chat";
  return { visible: XENAXIO_BFF && workspace, label: t("projects.nav") };
}
