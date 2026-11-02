// Scoped component styles shared by the built-in theme and installable ZIP.
export default String.raw`/* Memail skin. Scope every rule to the native theme lifecycle. Preserve row
   geometry (the list is virtualized), hit targets, user tag colors and mail HTML. */
body[data-theme-skin="builtin-memail"] {
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
}

/* Use the already self-hosted Geist family for utility text as well. Browser
   text scaling and the user's density settings continue to control sizing. */
body[data-theme-skin="builtin-memail"] .font-sans {
  font-family: var(--font-sans);
}
body[data-theme-skin="builtin-memail"] :is(button, input, select, textarea) {
  font-family: inherit;
}
body[data-theme-skin="builtin-memail"] :is([data-tour="sidebar"], [data-tour="email-list"]) .font-bold {
  font-weight: 650;
}

/* Preserve icon silhouettes and filled icons; normalize only outline strokes
   in interface controls, never in a message body or attachment preview. */
body[data-theme-skin="builtin-memail"] :is(button, [data-tour^="nav-"], [data-testid="folder-row"]) svg[stroke="currentColor"] {
  stroke-width: 1.75;
}

/* Quiet folder icons, with the selected mailbox carrying the accent. Tag
   icons use fill=currentColor and retain the user's chosen color. */
body[data-theme-skin="builtin-memail"] [data-testid="folder-row"] svg:not([fill="currentColor"]) {
  color: var(--color-muted-foreground);
}
body[data-theme-skin="builtin-memail"] [data-testid="folder-row"][data-selected="true"] {
  background-color: var(--color-sidebar-accent);
  color: var(--color-sidebar-accent-foreground);
  border-inline-start-color: var(--color-primary);
}
body[data-theme-skin="builtin-memail"] [data-testid="folder-row"][data-selected="true"] svg:not([fill="currentColor"]) {
  color: var(--color-primary);
}

/* Unread stays visible without tinting the whole inbox like a selection.
   Exclude plugin/user row tints: only override the host's own unread utility. */
body[data-theme-skin="builtin-memail"] [data-tour="email-list"] [data-unread="true"].bg-accent\/30:not(:hover):not(:is([aria-current="true"], [aria-selected="true"])) {
  background-color: var(--color-unread-wash);
}
body[data-theme-skin="builtin-memail"] [data-tour="email-list"] [aria-current="true"]::before {
  content: "";
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  width: 3px;
  background-color: var(--color-primary);
  pointer-events: none;
  z-index: 1;
}
body[data-theme-skin="builtin-memail"] [data-tour="email-list"] [data-unread="true"] .text-foreground:is(.font-semibold, .font-bold) {
  font-weight: 650;
}

/* Counters and navigation use the same brand; errors retain destructive. */
body[data-theme-skin="builtin-memail"] [data-tour^="nav-"] .bg-red-500 {
  background-color: var(--color-primary);
  color: var(--color-primary-foreground);
}
body[data-theme-skin="builtin-memail"] [data-tour^="nav-"][aria-current="page"] {
  color: var(--color-primary);
  background-color: var(--color-accent);
}

/* One ground behind the reader, and matching compose metadata surfaces.
   Never reach into the sanitized message document or rich-text editor. */
body[data-theme-skin="builtin-memail"] [data-tour="email-viewer"] .overflow-auto.bg-muted\/30 {
  background-color: var(--color-background);
}
body[data-theme-skin="builtin-memail"] [data-testid="composer-save-status"] {
  font-weight: 550;
}
body[data-theme-skin="builtin-memail"] [data-testid="composer-to"] {
  border-color: var(--color-border);
}
body[data-theme-skin="builtin-memail"] :is([role="menu"], [role="listbox"], [role="alertdialog"]) {
  border-radius: var(--radius-lg);
}

/* Focus remains explicit on keyboard navigation; no hover movement or custom
   animation is introduced, including when reduced motion is selected. */
body[data-theme-skin="builtin-memail"] :is(button, a, input, textarea, select):focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}
/* Quiet rounded navigation and a clear split selector. Preserve the native
   virtual row heights and user-controlled tag colors. */
body[data-theme-skin="builtin-memail"] [data-testid="folder-row"] {
  border-radius: 6px;
  margin-inline: 8px;
  width: auto;
}
body[data-theme-skin="builtin-memail"] [role="tablist"]:has([id*="memail-"]) {
  gap: 6px;
  padding: 8px 24px 12px;
}
body[data-theme-skin="builtin-memail"] [role="tab"][id*="memail-"] {
  border: 0;
  border-radius: 7px;
  margin-bottom: 0;
  padding: 8px 12px;
}
body[data-theme-skin="builtin-memail"] [role="tab"][id*="memail-"][aria-selected="true"] {
  background: var(--color-accent);
  color: var(--color-accent-foreground);
}
body[data-theme-skin="builtin-memail"] [data-testid="email-list-item"] {
  border-bottom-color: color-mix(in srgb, var(--color-border) 65%, transparent);
}
body[data-theme-skin="builtin-memail"] [data-memail-reader-column] {
  background: var(--color-background);
}
/* Match the compose canvas to the reader at wide sizes. Keep narrow panes
   fluid, and preserve the upstream editor, signature and attachment layout. */
@media (min-width: 1024px) {
  body[data-theme-skin="builtin-memail"] [data-tour="composer"] {
    max-width: 64rem;
    margin-inline: auto;
  }
}
body[data-theme-skin="builtin-memail"] [data-testid="composer-subject"] {
  font-weight: 600;
}
body[data-theme-skin="builtin-memail"] [data-testid="composer-save-status"] {
  font-size: 1rem;
  letter-spacing: -0.02em;
}

/* Navigation chrome: keep native row heights and user density settings. */
body[data-theme-skin="builtin-memail"] [data-memail-sidebar] {
  background-color: var(--color-sidebar);
}
body[data-theme-skin="builtin-memail"] [data-memail-sidebar] [data-folder-nav] {
  padding-inline: 0.75rem;
  padding-block-end: 1.25rem;
  scrollbar-width: thin;
}
body[data-theme-skin="builtin-memail"] [data-testid="folder-row"] {
  border-radius: var(--radius-md);
}
body[data-theme-skin="builtin-memail"] [data-memail-rail] nav {
  gap: 0.375rem;
  scrollbar-width: thin;
}
body[data-theme-skin="builtin-memail"] [data-memail-rail] [data-tour^="nav-"] {
  border-radius: var(--radius-lg);
}
body[data-theme-skin="builtin-memail"] [data-memail-rail] [aria-current="page"] {
  box-shadow: inset 0 0 0 1px var(--color-border);
}

body[data-theme-skin="builtin-memail"] [data-memail-sidebar="workspace"] [data-testid="folder-row"][data-selected="true"] {
  border-inline-start-color: transparent;
}
body[data-theme-skin="builtin-memail"] [data-memail-sidebar="workspace"][data-memail-collapsed="true"] [data-folder-nav] { padding-inline: 0.25rem; }
body[data-theme-skin="builtin-memail"] [data-tour="email-list"] [data-memail-message-row][aria-current="true"]::before {
  inset-block: 0.625rem;
  border-radius: 999px;
}
`;
