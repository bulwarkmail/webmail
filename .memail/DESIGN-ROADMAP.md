# Memail UI and feature overhaul

Decision: 2026-11-02. ReUI remains postponed. The owner wants multiple AI providers, with AI implementation starting only after the UI/UX and core mail features are complete.

## Research and direction

- [Superhuman inbox structure](https://help.superhuman.com/hc/en-us/articles/46005793275277-Structure-Your-Inbox): deliberate inbox partitions and command-driven organization. Make focus views understandable, fast to switch, and explicit about count semantics.
- [Zero](https://0.email/): natural-language AI email chat. The homepage did not expose a readable feature inventory during this review; this is a high-level reference, not verified workflow parity or visual benchmarking.
- [Shortwave assistant](https://www.shortwave.com/docs/guides/ai-assistant/): contextual writing, search, summaries and action extraction. Keep assistance beside the relevant conversation or draft, with links to sources.

These are official product descriptions, not hands-on quality or speed comparisons. Our own direction is a labeled application dock, account-aware sidebar, one workspace header, dense conversation queue, focused reader, and capable composer.

## 1. Identity and workspace shell — implemented locally, under review

An 80px labeled desktop dock across the standard apps, a charcoal/forest theme, a shared inbox/reader header, and 52 primary duotone interface glyphs. Compact Pro/admin rails and phone navigation retain their behavior. Keep native account scope, threading, virtualization, resizing, drafts and navigation guards.

Acceptance: named app destinations, visible active app, usable short-height rail, phone panels within viewport, keyboard focus without accidental navigation, light/dark contrast, and working native mail actions. Detailed evidence belongs in VALIDATION.md. This phase is not the complete overhaul.

## 2. Inbox and navigation

Progress: native sidebar hierarchy, expanded primary glyph coverage, desktop/keyboard folder options and account-scoped saved views are implemented for review. Inbox row hierarchy, responsive preview depth, precise date tooltips and all four native spacing controls are also implemented for review. Remaining phase acceptance below is still open.

Make saved views first-class navigation; clarify folders, labels and account hierarchy; unify selection, hover and batch actions. Add custom views and sender-focused triage using native JMAP filters. Preserve missing-folder recovery and shared-account boundaries. Loaded-page counts must not be presented as mailbox-wide totals; unread must not be treated as unfinished work.

Acceptance: keyboard/mouse/touch triage, large-mailbox pagination and virtualization, account switching, reversible actions, and useful loading/error/empty states.

## 3. Reader and composer

Progress: attachment finder and responsive grids, extension-preserving composer chips, reader subject wrapping and composer field polish are implemented for review. Reader metadata now has pane-responsive cards, recipient overflow disclosure, close/Escape focus return and compact phone dates. Native composers have a compact expandable formatting strip and inherited pasted-font feedback, with action parity and keyboard coverage. Draft/upload/content regressions pass targeted checks; full phase acceptance remains open.

Unify conversation metadata, attachments, action hierarchy, reply transitions and compose layout. Preserve and improve rich paste, Markdown/HTML import, fonts, spacing, undo and draft recovery using real Word, Docs and LLM samples. Preserve identities, signatures, quoted originals, inline images and scheduling.

Acceptance: save/reopen/reload/account-switch recovery; reply/forward correctness; attachment and formatted-text round trips; sanitized received HTML; documented document-layout limits.

## 4. Search, settings and connected apps

Progress: settings all-match expansion, keyboard/focus recovery, active-filter controls and Heroicons folder/app/settings navigation are implemented for review. Shared menus now have consistent row/panel spacing, type-to-focus command navigation and visible focused items in long lists. Files now has pane-responsive tools, separate account context, compact deep paths, keyboard view switching and search focus recovery. Contacts now has a dedicated search row, explicit presence filters, bounded pane-responsive filter layout, disclosure focus return and no-results recovery. Calendar now has separated phone navigation rows, keyboard view selection, accessible calendar visibility and pane-responsive desktop tools. Heroicons now cover all built-in application exports. Calendar search now has pane-local keyboard navigation, responsive result rows, unique/sticky section headings and search-close focus recovery. Remaining connected-app consistency and full phase acceptance remain open.

Unify saved and advanced search, organize settings by task, and bring Calendar/Contacts/Files into the same navigation and menu system. Improve shortcut discovery and focus return. Translate downstream strings and verify RTL, zoom, reduced motion, mobile safe areas and touch targets.

Acceptance: complete desktop/phone task walkthroughs with reachable actions and explicit recovery from errors.

## 5. Reliability and release gate

Run real Stalwart integration, offline/reconnect recovery, account/identity checks, recipient-client rendering samples and an upstream merge rehearsal. Verify migration and rollback before deployment. Demo or build success alone is not mail acceptance.

## 6. Multi-provider AI — deferred until core acceptance

Support multiple hosted providers and compatible self-hosted endpoints through provider profiles, model selection and administrator policy. Reuse the existing server-side plugin credential vault/proxy where appropriate; preserve its origin-bound credential handling. Provider adapters must account for different capabilities.

Start with explicit summarize-thread, extract-actions, draft-reply and rewrite-selection commands. Show the provider and content scope; default to bounded selected context. Provide cancellation, retry and useful errors. Apply generated edits only on user request, with stale-draft checks and undo. Treat email text as untrusted data. Do not automatically send or delete mail.

Later evaluate source-linked mailbox answers and suggested categorization. Background indexing and sent-mail personalization require separate product decisions. This plan does not enable a provider or upload mail content.
