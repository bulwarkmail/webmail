/**
 * Naming one member of an object in a JMAP PatchObject.
 *
 * A PatchObject key is a JSON Pointer (RFC 8620 section 5.3), so a slash in the
 * member's own name starts a new path segment unless it is escaped. That bites
 * keywords: a nested tag is stored as `$label:work/clients`, and the unescaped
 * pointer `keywords/$label:work/clients` asks for the `clients` member of the
 * `$label:work` keyword - not a boolean, so the patch is rejected or ignored
 * and the tag never lands.
 */

/** One JSON Pointer reference token: `~` -> `~0`, `/` -> `~1` (RFC 6901). */
export function pointerToken(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * The member name a reference token stands for: the inverse of
 * `pointerToken`. `~1` is read before `~0`, per RFC 6901 - the other order
 * would turn the escaped `~1` of `~01` back into a slash.
 */
export function pointerTokenValue(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** The PatchObject key that sets or clears the keyword `keyword`. */
export function keywordPointer(keyword: string): string {
  return `keywords/${pointerToken(keyword)}`;
}
