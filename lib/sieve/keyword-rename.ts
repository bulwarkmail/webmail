/**
 * Following a renamed tag into the filters that name it.
 *
 * A tag is stored on messages as the keyword `$label:<id>`, and `id` is a slug
 * of the display name - so renaming a tag changes its id, and every message
 * carrying it has to be migrated (`IJMAPClient.migrateKeyword`). A Sieve rule
 * with an `add_label` action names that same id, in the generated `addflag`
 * line and in the metadata block the visual editor reads back. Migrating only
 * the messages leaves the rule writing the old keyword: new mail keeps arriving
 * under a tag no definition names any more, which reads as "the filter stopped
 * working" while the rule is in fact running exactly as written.
 *
 * This module is the rewrite half. It is pure - the caller fetches the script,
 * parses it, applies this, and writes the result back.
 */
import type { FilterAction, FilterRule } from '@/lib/jmap/sieve-types';
import { KEYWORD_PREFIX } from '@/lib/thread-utils';

/** The result of following a rename through a set of rules. */
export interface KeywordRenameResult {
  /** The rules, with every reference to the old id rewritten. */
  rules: FilterRule[];
  /** How many actions were rewritten. Zero means nothing referenced the tag. */
  changed: number;
}

/** The keyword an `add_label` action writes, as it appears in a script. */
function quotedKeyword(id: string): string {
  return `"${KEYWORD_PREFIX}${id}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How many times `script` writes the keyword of the tag `id`.
 *
 * Whole-token only: `$label:red-alert` is a different tag from `$label:red`
 * and must not be counted, which a plain substring search would get wrong. The
 * token ends at the closing quote or at a space, since the argument of an
 * `addflag` is a space-separated flag list (RFC 5232 section 3.2) and the tag
 * need not be the last flag in it.
 *
 * Used to tell whether a script this module cannot rewrite - a hand-edited one,
 * kept verbatim - still refers to a tag that has since been renamed.
 */
export function countKeywordUses(script: string, id: string): number {
  const pattern = new RegExp(`["\\s]${escapeRegExp(KEYWORD_PREFIX + id)}(?=["\\s])`, 'g');
  return script.match(pattern)?.length ?? 0;
}

/**
 * `rules` with every `add_label` action naming `oldId` rewritten to `newId`.
 *
 * Disabled rules are rewritten too: leaving one behind would have it tag under
 * the old id the moment it is switched back on. An external rule - one Bulwark
 * did not write, re-emitted from its `rawBlock` verbatim - has that block
 * rewritten as well, since its parsed actions never reach the generated script.
 * Only the operand of an `addflag` is touched there: a test comparing some
 * header against the same literal is the rule's own logic, and rewriting it
 * would change what the rule matches rather than what it tags.
 *
 * What is left naming the old id afterwards - that test, or an opaque rule,
 * which parses to no actions at all - is for the caller to count in the script
 * it ends up writing, with `countKeywordUses`. The input is left untouched, and
 * an id that did not actually change returns the very same array, so a caller
 * can skip writing anything.
 */
export function renameKeywordInRules(
  rules: FilterRule[],
  oldId: string,
  newId: string,
): KeywordRenameResult {
  if (!oldId || !newId || oldId === newId) return { rules, changed: 0 };

  let changed = 0;
  const rewritten = rules.map((rule) => {
    let ruleChanged = 0;
    const actions: FilterAction[] = rule.actions.map((action) => {
      if (action.type !== 'add_label' || action.value !== oldId) return action;
      ruleChanged++;
      return { ...action, value: newId };
    });
    if (ruleChanged === 0) return rule;

    changed += ruleChanged;
    const next: FilterRule = { ...rule, actions };
    if (next.rawBlock) next.rawBlock = renameInRawBlock(next.rawBlock, oldId, newId);
    return next;
  });

  return changed === 0 ? { rules, changed: 0 } : { rules: rewritten, changed };
}

/** Retags the `addflag` lines of a block that is otherwise kept verbatim. */
function renameInRawBlock(block: string, oldId: string, newId: string): string {
  const pattern = new RegExp(`(addflag\\s+)${escapeRegExp(quotedKeyword(oldId))}`, 'g');
  return block.replace(pattern, `$1${quotedKeyword(newId)}`);
}
