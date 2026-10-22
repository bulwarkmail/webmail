// xenaxio (step 16): the platform lets every colleague see a user's free/busy
// (busy times only). The mail server announces each of those grants as a
// share notification; they carry nothing the user needs to see, so they are
// acknowledged without a toast.
import type { ShareNotification } from "@/lib/jmap/types";
import { XENAXIO_BFF } from "./bff";

const onlyFreeBusy = (rights: Record<string, boolean> | null | undefined) =>
  !!rights?.mayReadFreeBusy && Object.entries(rights).every(([k, v]) => k === "mayReadFreeBusy" || v === false);
const nothing = (rights: Record<string, boolean> | null | undefined) => !rights || Object.values(rights).every((v) => v === false);

/** A calendar going from nothing to free/busy only, or back. */
export function isQuietFreeBusyNotice(n: ShareNotification): boolean {
  if (!XENAXIO_BFF || n.objectType !== "Calendar") return false;
  return (nothing(n.oldRights) && onlyFreeBusy(n.newRights)) || (onlyFreeBusy(n.oldRights) && nothing(n.newRights));
}
