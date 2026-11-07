/**
 * The keywords of a message imported into a folder: read, and in Drafts also
 * a draft, so it opens in the composer to be edited and sent (#1535).
 */
export function importKeywords(role: string | null | undefined): Record<string, boolean> {
  return role === 'drafts' ? { $seen: true, $draft: true } : { $seen: true };
}
