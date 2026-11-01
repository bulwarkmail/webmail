/**
 * The setup wizard's steps, in order. Their labels are setup.steps.<id>.
 * A plain module, so the wizard's page skeleton draws the same number.
 */
export const SETUP_STEPS = [
  { id: 'welcome' },
  { id: 'server' },
  { id: 'auth' },
  { id: 'security' },
  { id: 'logging' },
  { id: 'branding' },
  { id: 'review' },
] as const;
