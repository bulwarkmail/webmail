/**
 * The order of the shared (group/delegated) accounts in the sidebar's Shared
 * section. Stored per login as JMAP accountIds; accounts not in the list keep
 * their alphabetical place after the listed ones, so a newly shared account
 * lands at the end.
 */

/** JMAP accountIds in display order for this login. */
export function sharedMailOrderIds(
  order: Record<string, string[]> | undefined,
  loginId: string | null | undefined,
): string[] {
  if (!loginId || !order) return [];
  const ids = order[loginId];
  return Array.isArray(ids) ? ids : [];
}

/**
 * The shared account nodes with the stored ones first, in the stored order,
 * and the rest after them in the order they came in (alphabetical).
 */
export function sortSharedMailAccounts<T extends { accountId?: string }>(
  nodes: T[],
  orderIds: string[] | undefined,
): T[] {
  if (!orderIds || orderIds.length === 0) return nodes;
  const rank = new Map<string, number>();
  orderIds.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const listed: T[] = [];
  const rest: T[] = [];
  for (const node of nodes) {
    if (node.accountId !== undefined && rank.has(node.accountId)) listed.push(node);
    else rest.push(node);
  }
  listed.sort((a, b) => rank.get(a.accountId!)! - rank.get(b.accountId!)!);
  return [...listed, ...rest];
}

/**
 * The order map with `draggedId` moved to `targetId`'s position for a login.
 * `currentIds` is that login's full display order, hidden accounts included,
 * so an account hidden and shown again keeps its place. Stored ids whose
 * account is not present now are kept after the present ones.
 */
export function moveSharedMailAccount(
  orderMap: Record<string, string[]>,
  loginId: string,
  currentIds: string[],
  draggedId: string,
  targetId: string,
): Record<string, string[]> {
  const from = currentIds.indexOf(draggedId);
  const to = currentIds.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return orderMap;
  const next = [...currentIds];
  next.splice(from, 1);
  next.splice(to, 0, draggedId);
  const absent = sharedMailOrderIds(orderMap, loginId).filter((id) => !currentIds.includes(id));
  return { ...orderMap, [loginId]: [...next, ...absent] };
}
