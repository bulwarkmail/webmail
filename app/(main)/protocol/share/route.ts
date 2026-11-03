/**
 * The manifest's share_target, when no service worker took it (public/sw.js
 * normally answers first): the first visit, a browser without one, or a worker
 * from before this existed. Nothing keeps files here, so the text and links go
 * on in the address and the page says the files are gone
 * (components/protocol/protocol-launch-handler-provider.tsx).
 *
 * Open to any origin, like a mailto: link: it writes nothing and acts as nobody.
 */

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
// A form with text and links is small. Anything bigger carries files, and
// isn't read into memory just to throw them away.
const MAX_READ_BYTES = 256 * 1024;

export const dynamic = "force-dynamic";

function land(query: string): Response {
  return new Response(null, { status: 303, headers: { Location: `${BASE_PATH}/${query}` } });
}

export async function POST(request: Request): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "");
  const params = new URLSearchParams({ share: "unavailable" });
  if (!Number.isFinite(length) || length <= 0 || length > MAX_READ_BYTES) {
    params.set("share_files", "1");
    return land(`?${params}`);
  }
  try {
    const form = await request.formData();
    const field = (name: string, max: number) => {
      const value = form.get(name);
      if (typeof value === "string" && value) params.set(`share_${name}`, value.slice(0, max));
    };
    // Short enough for what proxies in front allow in an address.
    field("title", 300);
    field("text", 4000);
    field("url", 2000);
    if (form.getAll("files").some((file) => typeof file !== "string" && file.size > 0)) {
      params.set("share_files", "1");
    }
  } catch {
    params.set("share_files", "1");
  }
  return land(`?${params}`);
}

/** Nothing to share: the app. */
export function GET(): Response {
  return land("");
}
