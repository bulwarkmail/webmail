/**
 * Adopting the tags a server already keeps, as soon as an account connects.
 *
 * On most servers a tag's name and colour exist only in these settings, and
 * "Recover tags from the server" is the way back after they are lost: it walks
 * the mailbox looking for keywords nothing explains. That walk is the only
 * option when the server knows nothing, and it is expensive - tens of
 * thousands of messages read to learn a dozen names.
 *
 * A server that keeps labels of its own needs none of it. The Gmail bridge
 * reports every label through the keyword-enumeration capability, named and
 * coloured as the user has it, so the answer is one request and it is exact.
 * Asking at connection time means the labels arriving on mail are already
 * recognised the first time they are seen, instead of showing as raw ids until
 * somebody thinks to visit settings and press a button.
 *
 * Imported tags are hidden from the sidebar: on a server where a label is also
 * a folder, they are already listed there, and a second copy of every label
 * under Tags is noise rather than information. They still name and colour the
 * tag wherever it appears on a message, which is the point.
 */
import type { IJMAPClient } from "./jmap/client-interface";
import { findUnrecognizedKeywords } from "./keyword-discovery";
import { useSettingsStore } from "@/stores/settings-store";
import { debug } from "./debug";

/**
 * Defines any tag the server describes that this client cannot yet name.
 *
 * A no-op - without a request - on a server that cannot enumerate its
 * keywords, and on tags that already have a definition, so it is safe to call
 * on every connection. Returns how many definitions were added.
 */
export async function importDescribedTags(client: IJMAPClient): Promise<number> {
  if (!client.supportsKeywordEnumeration?.()) return 0;
  let described;
  try {
    const { labels } = await client.getKeywords();
    described = labels.filter((label) => label.isProviderLabel);
  } catch (error) {
    // Nothing here is worth failing a login over: the settings scan remains.
    debug.warn("jmap", "[Tags] could not read the server's own tags", error);
    return 0;
  }
  if (described.length === 0) return 0;

  const { emailKeywords, nestedTags, addKeyword } = useSettingsStore.getState();
  // No scanned keywords to offer: everything here is the server's own account
  // of itself, and anything already defined is left exactly as the user has it.
  const missing = findUnrecognizedKeywords({}, emailKeywords, nestedTags, described);
  for (const tag of missing) {
    addKeyword({ id: tag.id, label: tag.label, color: tag.color, visibility: "hide" });
  }
  if (missing.length > 0) {
    debug.log("jmap", `[Tags] adopted ${missing.length} tag(s) the server defines`);
  }
  return missing.length;
}
