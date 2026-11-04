"use client";

import { usePathname } from "next/navigation";
import { isPopoutPath } from "@/lib/popout/window-role";

/**
 * What belongs to the app as a whole and not to each of its windows: live
 * push streams, install and update prompts, the command palette's jumps to
 * other surfaces. A pop-out shows one message or one draft, and the main
 * window does the rest.
 */
export function MainWindowOnly({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return isPopoutPath(pathname ?? "") ? null : <>{children}</>;
}
