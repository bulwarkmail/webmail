// Step 41: pictures of colleagues, shared mailboxes and resources. The
// platform answers which address of the company has one (aliases included);
// the mail app's Avatar shows it before any other source. Loaded once per page
// load, refreshed every few minutes and right after the user changes one.
import { useEffect } from "react";
import { create } from "zustand";
import { withBasePath } from "@/lib/browser-navigation";
import { xenaxio } from "@/lib/xenaxio/api";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";

const REFRESH_MS = 5 * 60_000;
/** Side of the square the browser sends (the platform keeps it as is). */
export const AVATAR_SIDE = 256;

interface AvatarState {
  byEmail: Record<string, string>;
  loadedAt: number;
  loading: boolean;
  load: (force?: boolean) => Promise<void>;
}

export const useXenaxioAvatarStore = create<AvatarState>((set, get) => ({
  byEmail: {},
  loadedAt: 0,
  loading: false,
  load: async (force = false) => {
    if (!XENAXIO_BFF || get().loading || (!force && Date.now() - get().loadedAt < REFRESH_MS)) return;
    set({ loading: true });
    try {
      const { avatars } = await xenaxio.avatars();
      set({ byEmail: Object.fromEntries(avatars.map((a) => [a.email.toLowerCase(), withBasePath(a.url)])), loadedAt: Date.now() });
    } catch {
      // Not signed in or offline: initials as before.
      set({ loadedAt: Date.now() });
    } finally {
      set({ loading: false });
    }
  },
}));

/** The company picture for this address; null outside the xenaxio build or without one. */
export function useXenaxioAvatar(email: string | undefined): string | null {
  const url = useXenaxioAvatarStore((s) => (email ? s.byEmail[email.toLowerCase()] : undefined));
  const load = useXenaxioAvatarStore((s) => s.load);
  useEffect(() => {
    if (XENAXIO_BFF && email) void load();
  }, [email, load]);
  return url ?? null;
}

/** Where to cut a w×h image so the middle square remains. */
export function centerSquare(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/**
 * Any photo (JPEG from a phone too) as a small square: the middle cut out,
 * scaled to 256 px, WebP where the browser can write it, PNG otherwise.
 */
export async function squareAvatar(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const { x, y, side } = centerSquare(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIDE;
    canvas.height = AVATAR_SIDE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, x, y, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
    const webp = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
    // Safari writes PNG when asked for WebP.
    if (webp && (webp.type === "image/webp" || webp.type === "image/png")) return webp;
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("no image");
    return png;
  } finally {
    bitmap.close();
  }
}
