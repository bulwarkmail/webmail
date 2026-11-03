/**
 * The manifest's share_target, when no service worker took it (public/sw.js
 * normally answers first): the first visit, a browser without one, or a worker
 * from before this existed. Nothing keeps files here, so text and links go on
 * in the address's fragment, which stays out of access logs, and the page asks
 * the user and says the files are gone
 * (components/protocol/protocol-launch-handler-provider.tsx).
 *
 * Open to any origin, like a mailto: link: it writes nothing and acts as nobody.
 */

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
// A form with text and links is small. Anything bigger carries files, and
// isn't read into memory just to throw them away.
const MAX_READ_BYTES = 256 * 1024;
// Encoded lengths: a proxy in front has to pass the Location header, and one
// Japanese character takes 9 bytes in it.
const BUDGET = { title: 400, url: 1000, text: 1800 };

export const dynamic = "force-dynamic";

function land(fragment: string): Response {
  return new Response(null, { status: 303, headers: { Location: `${BASE_PATH}/${fragment}` } });
}

/** As much of `value` as takes up to `budget` bytes once encoded, whole characters only. */
function fitEncoded(value: string, budget: number): { value: string; cut: boolean } {
  let used = 0;
  let out = "";
  for (const character of value) {
    let size: number;
    try {
      size = encodeURIComponent(character).length;
    } catch {
      continue; // A lone surrogate.
    }
    used += size;
    if (used > budget) return { value: out, cut: true };
    out += character;
  }
  return { value: out, cut: false };
}

export async function POST(request: Request): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "");
  const params = new URLSearchParams({ share: "unavailable" });
  if (!Number.isFinite(length) || length <= 0 || length > MAX_READ_BYTES) {
    params.set("share_files", "1");
    return land(`#${params}`);
  }
  try {
    const form = await request.formData();
    let cut = false;
    for (const name of ["title", "text", "url"] as const) {
      const value = form.get(name);
      if (typeof value !== "string" || !value) continue;
      const fitted = fitEncoded(value, BUDGET[name]);
      params.set(`share_${name}`, fitted.value);
      cut ||= fitted.cut;
    }
    if (cut) params.set("share_cut", "1");
    if (form.getAll("files").some((file) => typeof file !== "string" && file.size > 0)) {
      params.set("share_files", "1");
    }
  } catch {
    params.set("share_files", "1");
  }
  return land(`#${params}`);
}

/** Nothing to share: the app. */
export function GET(): Response {
  return land("");
}
