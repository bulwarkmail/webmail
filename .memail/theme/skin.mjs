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

/* Keep Tabler's silhouettes and filled icons; normalize only outline strokes
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
`;
