/**
 * Where the default layout puts Compose on a desktop: a floating button over
 * the message list, the top of the folder sidebar, or the top of the app
 * rail. Phones and Pro panes always have the floating button, and Mountain
 * View its own Compose button in the folder column.
 */
export const COMPOSE_PLACEMENTS = ['floating', 'sidebar', 'rail'] as const;

export type ComposePlacement = (typeof COMPOSE_PLACEMENTS)[number];

export const DEFAULT_COMPOSE_PLACEMENT: ComposePlacement = 'floating';

export function isComposePlacement(value: unknown): value is ComposePlacement {
  return typeof value === 'string' && (COMPOSE_PLACEMENTS as readonly string[]).includes(value);
}
