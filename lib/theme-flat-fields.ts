// "Flat fields" - the bulwarkmail.org design system carried into the app.
//
// Neutral grounds, square panes, one regular-weight sans, and raspberry only
// as a small mark: the primary button, the unread square, the 3px edge on the
// active folder and the selected message, the focus ring and links. Errors,
// warnings and success have their own colours so nothing destructive can be
// mistaken for the brand.
//
// Contrast (WCAG 2.1) is checked for every foreground/background pair; the
// tightest is white on raspberry at 4.65:1, so button labels on primary stay
// at the base size and weight 500. Raspberry is never used as text: text
// links and `text-primary` take --color-ring, which reaches 4.5:1 on the grey
// surface in both variants.

export const flatFieldsCSS = `
:root {
  --color-background: #ffffff;
  --color-foreground: #18181b;
  --color-card: #ffffff;
  --color-card-foreground: #18181b;
  --color-popover: #ffffff;
  --color-popover-foreground: #18181b;
  --color-secondary: #f4f4f5;
  --color-secondary-foreground: #18181b;
  --color-muted: #f4f4f5;
  --color-muted-foreground: #56565d;
  --color-accent: #f4f4f5;
  --color-accent-foreground: #18181b;
  --color-sidebar: #ffffff;
  --color-sidebar-foreground: #18181b;
  --color-sidebar-border: #dddde1;
  --color-sidebar-accent: #f4f4f5;
  --color-sidebar-accent-foreground: #18181b;
  --color-selection: #f4f4f5;
  --color-selection-foreground: #18181b;
  --color-border: #dddde1;
  --color-input: #7f7f87;
  --color-ring: #c01f46;
  --color-primary: #db2d54;
  --color-primary-foreground: #ffffff;
  --color-unread: #db2d54;
  --color-destructive: #b42318;
  --color-destructive-foreground: #ffffff;
  --color-success: #17784a;
  --color-success-foreground: #ffffff;
  --color-warning: #8a5d00;
  --color-warning-foreground: #ffffff;
  --color-info: #1f5f9e;
  --color-info-foreground: #ffffff;
  --color-chart-1: #1f5f9e;
  --color-chart-2: #17784a;
  --color-chart-3: #8a5d00;
  --color-chart-4: #db2d54;
  --color-chart-5: #6b5bb5;

  /* Square system: 0 on surfaces, 2px on things you press or type into. */
  --radius-xs: 0px;
  --radius-sm: 0px;
  --radius-md: 2px;
  --radius-lg: 2px;
  --radius-xl: 2px;
  --radius-2xl: 2px;
  --radius-3xl: 2px;
  --radius-4xl: 2px;

  /* No frosted glass. */
  --blur-xs: 0px;
  --blur-sm: 0px;
  --blur-md: 0px;
  --blur-lg: 0px;
  --blur-xl: 0px;
  --blur-2xl: 0px;
  --blur-3xl: 0px;
}

.dark {
  --color-background: #131315;
  --color-foreground: #f2f2f3;
  --color-card: #1f1f22;
  --color-card-foreground: #f2f2f3;
  --color-popover: #1f1f22;
  --color-popover-foreground: #f2f2f3;
  --color-secondary: #1f1f22;
  --color-secondary-foreground: #f2f2f3;
  --color-muted: #1f1f22;
  --color-muted-foreground: #ababb2;
  /* A step above popover and muted so hover and selection stay visible
     inside menus and on the quiet surface. */
  --color-accent: #2a2a2e;
  --color-accent-foreground: #f2f2f3;
  --color-sidebar: #131315;
  --color-sidebar-foreground: #f2f2f3;
  --color-sidebar-border: #36363b;
  --color-sidebar-accent: #2a2a2e;
  --color-sidebar-accent-foreground: #f2f2f3;
  --color-selection: #2a2a2e;
  --color-selection-foreground: #f2f2f3;
  --color-border: #36363b;
  --color-input: #85858d;
  --color-ring: #ff91a8;
  --color-primary: #db2d54;
  --color-primary-foreground: #ffffff;
  --color-unread: #f0486f;
  --color-destructive: #ff9b8f;
  --color-destructive-foreground: #131315;
  --color-success: #4cc38a;
  --color-success-foreground: #131315;
  --color-warning: #e2b341;
  --color-warning-foreground: #131315;
  --color-info: #7fb2e8;
  --color-info-foreground: #131315;
  --color-chart-1: #7fb2e8;
  --color-chart-2: #4cc38a;
  --color-chart-3: #e2b341;
  --color-chart-4: #f0486f;
  --color-chart-5: #a99bf0;
}
`;

// Component-level rules the tokens cannot express. Stable hooks only:
// [data-tour], [role], data-* state attributes, and Tailwind utilities.
// Nothing here moves, hides or restructures a component.
export const flatFieldsSkin = `
/* ── Type: Hanken Grotesk (self-hosted by the root layout as --font-hanken,
   defined on <body>), then a system stack for scripts it does not cover. ── */
body[data-theme-skin="builtin-flat-fields"] {
  font-family: var(--font-hanken, "Hanken Grotesk"), ui-sans-serif, system-ui,
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
    Arial, "Noto Sans", "Noto Sans Thai", "Leelawadee UI", sans-serif;
}

body[data-theme-skin="builtin-flat-fields"] .font-bold {
  font-weight: 600;
}

/* Uppercase letter-spaced labels read as sentence-style small text. */
body[data-theme-skin="builtin-flat-fields"] .uppercase:not(.font-mono) {
  text-transform: none;
  letter-spacing: 0;
}

/* ── Flat: no shadows, glows or frosted glass. Clearing --tw-shadow keeps
   Tailwind's ring utilities working. ── */
body[data-theme-skin="builtin-flat-fields"] [class*="shadow"] {
  --tw-shadow: 0 0 #0000;
}

body[data-theme-skin="builtin-flat-fields"] [class*="backdrop-blur"] {
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

/* Grounds are flat; the sign-in page and empty states use soft washes. The
   image viewer's dark scrim keeps its controls legible and stays. */
body[data-theme-skin="builtin-flat-fields"] [class*="bg-gradient-to-"]:not([class*="from-black"]) {
  background-image: none;
}

/* ── Square. \`rounded\` and \`rounded-full\` compile to literals, not radius
   tokens. Pills, badges, toggles, counters, the compose button, swatches and
   status dots become 2px shapes; spinners stay round. ── */
body[data-theme-skin="builtin-flat-fields"] .rounded,
body[data-theme-skin="builtin-flat-fields"] .rounded-full:not(.animate-spin) {
  border-radius: var(--radius-md);
}

/* Calendar event chips (a colour edge on the left, \`rounded-r\`) are tiles. */
body[data-theme-skin="builtin-flat-fields"] :is(.rounded-r, .rounded-t) {
  border-radius: 0;
}

/* Avatars are images, and images are square. Initials without a photo sit on
   the quiet surface instead of a random saturated hue (which also fails
   contrast with white initials for yellows and greens). The hue is an inline
   style, hence the one !important. */
body[data-theme-skin="builtin-flat-fields"] .rounded-full.overflow-hidden.text-white[title] {
  border-radius: 0;
}

body[data-theme-skin="builtin-flat-fields"] .rounded-full.overflow-hidden.text-white[title]:not(:has(img)) {
  background-color: var(--color-muted) !important;
  color: var(--color-muted-foreground);
  font-weight: 500;
  box-shadow: inset 0 0 0 1px var(--color-border);
}

/* Icons take the text colour; the brand is reserved for marks. */
/* Folder role icons take the text colour; tag icons (filled with the tag's
   own colour) are user data and keep it. */
body[data-theme-skin="builtin-flat-fields"] [data-testid="folder-row"] svg:not([fill="currentColor"]) {
  color: var(--color-muted-foreground);
}

body[data-theme-skin="builtin-flat-fields"] [data-testid="folder-row"][data-selected="true"] svg:not([fill="currentColor"]) {
  color: var(--color-foreground);
}

/* Brand tints (bg-primary/5 to /20) are areas of pink: use the neutral
   selection grey. Strong fills (/40 and up) are progress and marks. */
body[data-theme-skin="builtin-flat-fields"] :is([class~="bg-primary/5"], [class~="bg-primary/10"], [class~="bg-primary/15"], [class~="bg-primary/20"], [class~="dark:bg-primary/10"]),
body[data-theme-skin="builtin-flat-fields"] :is([class~="hover:bg-primary/5"], [class~="hover:bg-primary/10"], [class~="hover:bg-primary/15"], [class~="hover:bg-primary/20"], [class~="hover:bg-primary/30"]):hover {
  background-color: var(--color-accent);
}

/* Checked and dragged rows: grey, without the pink ring. */
body[data-theme-skin="builtin-flat-fields"] :is([class~="ring-primary/20"], [class~="ring-primary/30"]) {
  --tw-ring-shadow: 0 0 #0000;
}

/* Layers: dialogs, menus and toasts are square, separated by a 1px border. */
body[data-theme-skin="builtin-flat-fields"] [role="dialog"],
body[data-theme-skin="builtin-flat-fields"] [role="alertdialog"],
body[data-theme-skin="builtin-flat-fields"] [role="menu"],
body[data-theme-skin="builtin-flat-fields"] [role="listbox"],
body[data-theme-skin="builtin-flat-fields"] .toast-item {
  border-radius: 0;
}

body[data-theme-skin="builtin-flat-fields"] [role="alertdialog"],
body[data-theme-skin="builtin-flat-fields"] [role="menu"],
body[data-theme-skin="builtin-flat-fields"] .toast-item {
  border: 1px solid var(--color-input);
}

body[data-theme-skin="builtin-flat-fields"] .toast-item {
  background-color: var(--color-popover);
}

/* ── Panes sit on the page ground, split by 1px rules, so grey only ever
   means "selected" or "under the pointer". ── */
body[data-theme-skin="builtin-flat-fields"] .w-14.bg-secondary,
body[data-theme-skin="builtin-flat-fields"] .border-e.bg-secondary,
body[data-theme-skin="builtin-flat-fields"] .flex-col.h-full.bg-secondary {
  background-color: var(--color-background);
}

/* ── Selection is grey plus a 3px brand edge. The folder row asks for
   border-primary, but the global \`* { border-color }\` rule wins over
   utilities, so the edge colour is set here. ── */
body[data-theme-skin="builtin-flat-fields"] [data-tour="sidebar"] [data-testid="folder-row"] {
  border-inline-start-color: transparent;
}

body[data-theme-skin="builtin-flat-fields"] [data-tour="sidebar"] [data-selected="true"] {
  border-inline-start-width: 3px;
  border-inline-start-color: var(--color-primary);
  font-weight: 500;
}

/* Side panes (settings, contacts, files, calendar) mark their active item
   only with bg-accent; give it the same edge. */
body[data-theme-skin="builtin-flat-fields"] :is(.border-e.bg-secondary, .flex-col.h-full.bg-secondary) button.bg-accent {
  box-shadow: inset 3px 0 0 var(--color-primary);
}

body[data-theme-skin="builtin-flat-fields"] [data-tour="contacts-list"] .bg-selection {
  box-shadow: inset 3px 0 0 var(--color-primary);
}

body[data-theme-skin="builtin-flat-fields"] [data-tour^="nav-"][aria-current="page"] {
  background-color: var(--color-accent);
  color: var(--color-accent-foreground);
  box-shadow: inset 3px 0 0 var(--color-primary);
}

/* The calendar's "now" line is drawn with the destructive colour; it marks
   time, not danger, so it takes the brand. */
body[data-theme-skin="builtin-flat-fields"] .pointer-events-none > .flex.items-center > .bg-destructive:is(.h-px, .w-2) {
  background-color: var(--color-primary);
}

/* Unread counters are brand marks, not alarm red. */
body[data-theme-skin="builtin-flat-fields"] [data-tour^="nav-"] .bg-red-500 {
  background-color: var(--color-primary);
  color: var(--color-primary-foreground);
}

body[data-theme-skin="builtin-flat-fields"] [data-tour="email-list"] [aria-current="true"]::before {
  content: "";
  position: absolute;
  inset-block: 0;
  inset-inline-start: 0;
  width: 3px;
  background-color: var(--color-primary);
  z-index: 1;
  pointer-events: none;
}

/* The reading pane is one white ground; no grey band below short messages. */
body[data-theme-skin="builtin-flat-fields"] [data-tour="email-viewer"] .overflow-auto.bg-muted\\/30 {
  background-color: var(--color-background);
}

/* Toggles: off is an outlined control with a grey thumb, on is a brand
   track with a white thumb. */
body[data-theme-skin="builtin-flat-fields"] [role="switch"][aria-checked="false"] {
  background-color: var(--color-background);
  box-shadow: inset 0 0 0 1px var(--color-input);
}

body[data-theme-skin="builtin-flat-fields"] [role="switch"][aria-checked="false"] > span {
  background-color: var(--color-input);
}

/* Things you type into or press carry the control border (3:1 on every
   ground). The app asks for border-input, but the global \`* { border-color }\`
   rule outranks utilities, so it is set here. Borderless fields are
   unaffected because they have no border width. */
body[data-theme-skin="builtin-flat-fields"] :is(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea, .border-input) {
  border-color: var(--color-input);
}

body[data-theme-skin="builtin-flat-fields"] :is(input[type="checkbox"], input[type="radio"]) {
  accent-color: var(--color-primary);
}

/* Unread is a small square and a 600 weight, not a tinted row. */
body[data-theme-skin="builtin-flat-fields"] [data-tour="email-list"] .bg-accent\\/30:not(:hover) {
  background-color: var(--color-background);
}

body[data-theme-skin="builtin-flat-fields"] [data-tour="email-list"] svg.fill-unread {
  color: transparent;
  fill: transparent;
  background-color: var(--color-unread);
  width: 7px;
  height: 7px;
}

/* The square sits clear of the 3px selection edge. */
body[data-theme-skin="builtin-flat-fields"] [data-tour="email-list"] div.absolute:has(> svg.fill-unread) {
  inset-inline-start: 6px;
}

/* In the split layout the app anchors the mark at "padding + half an
   avatar", but the avatar is centred in the row, so the mark lined up with
   nothing. Put it on the sender line it marks (text-sm in a 20-24px row).
   The other layouts already centre it on their single line. The offset is
   an inline style, hence !important. */
body[data-theme-skin="builtin-flat-fields"] [data-tour="email-list"] div.absolute[style*="+ 1.25rem"]:has(> svg.fill-unread) {
  top: calc(var(--density-item-py) + 0.75rem) !important;
}

/* ── Raspberry is too light for text on grey: text uses the link colour. ── */
body[data-theme-skin="builtin-flat-fields"] .text-primary {
  color: var(--color-ring);
}

body[data-theme-skin="builtin-flat-fields"] .email-content a,
body[data-theme-skin="builtin-flat-fields"] .email-content-text a {
  color: var(--color-ring);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}

/* ── Primary hover goes darker, never lighter or pinker. ── */
body[data-theme-skin="builtin-flat-fields"] .bg-primary:is(button, a):hover,
body[data-theme-skin="builtin-flat-fields"] [data-tour="compose-button"]:hover {
  background-color: color-mix(in srgb, var(--color-primary) 84%, #000);
}

/* Disabled is grey, not a faded pink. */
body[data-theme-skin="builtin-flat-fields"] button.bg-primary:disabled {
  background-color: var(--color-muted);
  color: var(--color-muted-foreground);
  opacity: 1;
}

/* A chosen option in a segmented control is filled with the text colour, as
   on the website's edition switch: a choice, not a call to action. */
body[data-theme-skin="builtin-flat-fields"] button[aria-pressed="true"].bg-primary,
body[data-theme-skin="builtin-flat-fields"] [role="radio"][aria-checked="true"].bg-primary,
body[data-theme-skin="builtin-flat-fields"] .flex.border.overflow-hidden > button.bg-primary {
  background-color: var(--color-foreground);
  color: var(--color-background);
}

/* The thread count stays a quiet label even when the thread has unread mail;
   the unread square already says so. */
body[data-theme-skin="builtin-flat-fields"] [data-tour="email-list"] span.bg-primary.text-primary-foreground {
  background-color: var(--color-muted);
  color: var(--color-foreground);
  font-weight: 600;
}

/* ── Icons follow the website's rule: 1.5 stroke, square caps, mitred joins. ── */
body[data-theme-skin="builtin-flat-fields"] svg.tabler-icon {
  stroke-width: 1.5;
  stroke-linecap: square;
  stroke-linejoin: miter;
}

/* ── Focus: one ring, 2px solid, 2px off the element. ── */
body[data-theme-skin="builtin-flat-fields"] :focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
  --tw-ring-shadow: 0 0 #0000;
  --tw-ring-offset-shadow: 0 0 #0000;
}

/* Text fields keep focus for as long as someone types, so the ring hugs the
   field instead of floating a box around it. */
body[data-theme-skin="builtin-flat-fields"] :is(input, textarea, select, [contenteditable="true"]):focus-visible {
  outline-offset: 0;
}
`;
