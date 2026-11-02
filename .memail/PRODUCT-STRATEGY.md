# Memail product strategy and phased transformation

Research date: 2 November 2026. Status: proposed product direction and execution backlog, not a claim that the listed features have shipped.

## Recommendation

Build a premium JMAP mail workspace for individuals and small teams: fast to operate, calm to read, reliable about unfinished work, and deployable under the user's control. Keep Bulwark's application and protocol foundation. Differentiate through complete daily workflows and measured interaction quality, then add optional AI.

The first compelling release should let a person triage a busy inbox, reply with the right identity, defer work safely, and recover the exact conversation later. Broad AI automation, a framework rewrite, and many integrations should follow that experience rather than compete with it for the first release.

Primary users: founders and operators handling several identities; technical professionals using Stalwart; small teams sharing operational mailboxes. Administrators are a second audience with clear deployment/policy needs. A marketing automation platform, full CRM and project-management suite are outside the initial scope.

## Research method and confidence

Compared official product pages/help documentation for Superhuman, Zero, Shortwave, Spark, HEY, Fastmail, Proton Mail, Missive and historical Notion Mail. Inspected the pinned Bulwark source and its plugin contracts. This is feature/workflow research, not hands-on benchmarking of all competitors, a security audit, or proof that a vendor's speed/privacy claims are true. Availability can differ by plan and platform. No competitor performance figures are adopted as our own.

Notion's indexed official help pages announce Mail's shutdown on 22 September 2026; some live help URLs now redirect to the general help center. Treat its views/composition patterns as historical references, not an active platform dependency. [Official indexed notice](https://www.notion.com/help/compose-an-email), [historical launch](https://www.notion.com/releases/2025-04-15).

## What the modern clients teach us

| Reference | Documented strength | Memail direction |
| --- | --- | --- |
| [Superhuman split inbox](https://help.superhuman.com/hc/en-us/articles/46005619081101-Default-Split-Inbox) | Intentional inbox partitions, sender/domain rules, command-driven navigation | A few understandable focus views with predictable membership and fast keyboard switching |
| [Superhuman auto drafts/reminders](https://help.superhuman.com/hc/en-us/articles/46005658551053-Auto-Reminders-Auto-Drafts) | Follow-up/response drafts and reminders; an edited AI draft becomes a regular draft | Separate follow-up state from unread state; protect user edits and require review before sending |
| [Zero](https://0.email/) | Keyboard navigation, AI summaries/drafting, natural-language interaction and configurable processing flows | Offer contextual assistance inside mail actions, with a useful non-AI workflow |
| [Shortwave](https://www.shortwave.com/docs/guides/customize-your-shortwave-settings/) | Bundles, delivery schedules, todos and rules | Batch low-priority traffic and link messages to work instead of adding more notification badges |
| [Shortwave assistant](https://www.shortwave.com/docs/guides/ai-assistant/) | Inbox search, writing and thread-aware assistance | Answers linked back to source conversations and a clear path from an answer to an action |
| [Spark](https://sparkmailapp.com/features) | Priority/gatekeeper controls, unified inbox, command center, shared drafts and assignments | Optional sender screening, account clarity and explicit team ownership |
| [HEY](https://www.hey.com/how-it-works/) | Screener, important correspondence, feed/receipt destinations, reply-later workflow | Introduce helpful attention categories without forcing users into a completely new mailbox model |
| [Fastmail](https://www.fastmail.com/pricing/us/) | Standards-oriented mail plus aliases, rules, calendars and productivity tools | Preserve interoperability and mature everyday mail behavior alongside polish |
| [Proton tracking protection](https://proton.me/support/email-tracker-protection) | Visible protection from known trackers and link tracking | Make remote-content/privacy choices understandable; avoid adding invisible outgoing surveillance |
| [Missive](https://missiveapp.com/features) | Assignment, internal discussion, collaborative drafting, tasks and auditability | Treat collaboration as a permissioned workflow with ownership, not just a shared folder |
| Historical Notion Mail | Custom views and structured composition with scheduling | Save workflows as views; make repetitive writing and scheduling lightweight |

We should combine these lessons, not combine every interface and every feature. The shared product loop is **focus -> decide -> act -> return -> find**.

## What Bulwark already gives us

Preserve and validate its mail, drafts, threading, attachments, full-text search, virtualization, shortcuts, command palette, themes, scheduling, undo, unified views and groupware. Features have server/edition/policy dependencies; documented availability is not the same as tested parity. [Upstream feature inventory](https://bulwarkmail.org/docs/features/overview).

Particularly useful source boundaries at upstream commit 3f3dfebb8444e945a5cf8a42d6932e9475c7160e:

- `lib/plugin-types.ts`: `api.tabs.set`, query-based or keyword-based native category tabs, and recategorization hooks.
- `stores/message-list-tabs-store.ts`: validates tabs, resolves active server-side JMAP filters, and maintains tab state.
- `lib/jmap/search-utils.ts`: typed filters and validation of plugin-supplied JMAP queries. Metadata filter restrictions must remain intact.
- `lib/command-registry.ts` and `lib/app-commands.ts`: native command registration and routing.
- `lib/plugin-slot-catalog.ts`: message-list/header/sidebar/command actions that avoid replacing the shell.
- `lib/plugin-hook-catalog.ts`: mail, search, compose, organization and lifecycle extension hooks.
- `stores/email-store.ts`: existing query, action and synchronization behavior; reuse rather than duplicate it.

The official plugin repository already includes AI writing, email-to-task, auto-tagging and team-inbox packages. These are evaluation/reuse candidates, not missing functionality we should automatically implement again. [Plugin repository](https://github.com/bulwarkmail/plugins), [plugin guide](https://bulwarkmail.org/docs/guides/plugins).

The team-inbox plugin already supports shared-mailbox assignment and completion, with edition/version constraints. It does not establish full Missive-like collaborative editing, internal comments or a CRM. [Team inbox](https://bulwarkmail.org/docs/guides/organisation/team-inbox).

## Product behavior we should design deliberately

### Focus views

Start with All inbox, Focus, Team/VIP and Updates as configurable presets, not four mandatory folders. Let the person remove or rename them. Add custom saved views after the basic flow works.

A view is a versioned filter over a defined account/mailbox scope. Viewing a split does not move mail, mark it read or rewrite server rules. Display why a message matches. Define whether memberships overlap; a catch-all view must always expose excluded messages. The default complement bucket in Bulwark's tab API has specific semantics, so test those rather than assume Superhuman semantics.

Use exact sender identities and explicit domain membership where needed; free-text `from` matching is not an authorization or trust check. Apply query filters and pagination on the server, never just to the first loaded page. Counts and selected rows must stay coherent after push, filing and read-state changes.

Rules come first: sender, recipient identity, List-Unsubscribe/list headers, tags and attachments. AI classification comes later with explanations and an easy correction path. Rule-based classification and sender screening must remain distinct from spam/security decisions.

### Action and follow-through

Make Archive, Reply, Reply all, Move, Star and Undo excellent before inventing replacements. Add explicit states for needs action, waiting for reply and read later where research confirms they help. Unread remains a mail-reading state; it is not the task database.

Distinguish snooze (return regardless), follow-up (return unless the relevant reply arrived), and scheduled sending (submit later). Show absolute dates/timezones in confirmations. Define behavior for new replies, deleted threads, account removal and edits. A reminder must survive closing every browser tab and restarting the service.

For sending, preserve the identity and attachment safeguards upstream already provides. A submission with an unknown network outcome must be reconciled before retrying; do not promise exactly-once delivery or retry blindly. Server delayed-submission capability should be reused when available.

### Reading and writing

The message body should dominate the reader; secondary controls can live in menus and the command palette. Keep trust/identity and attachment information discoverable. Provide one coherent set of commands across the list, reader, selection and phone menus.

Reuse existing templates/snippets, then improve discovery and variable completion. Keep autosave, reply headers, aliases, signatures, attachments and plain-text behavior correct. Add concise attachment/recipient/subject checks, not a confirmation for every ordinary action.

### Search as a workflow

Start with typed search and saved views. Next add human-friendly query entry that shows the interpreted scope and filters before running. Later, semantic retrieval may help find concepts absent from exact keywords. Answers must reference accessible messages, identify date/account scope and distinguish no evidence from a confident answer.

Do not send the whole mailbox to an external model merely to translate a short query. Search authorization must be enforced before retrieval and again when opening sources.

### Optional AI

Evaluate the existing AI-writing plugin before building an alternative. Start with selected-message summary, rewrite/translate, draft assistance and action-item extraction. Next add grounded search and suggested classifications. Background drafts are later: never overwrite human edits, infer fabricated commitments, or send unattended.

Support an administrator-controlled provider configuration and the ability to turn AI off. Keep secrets server-side, expose which content leaves the deployment, set retention/cost budgets and bound retrieval. A local model can be an option, not a claimed privacy guarantee.

Treat incoming messages and retrieved attachments as untrusted data. They cannot authorize actions, change tool permissions, expand retrieval scope, or instruct the assistant to disclose another conversation. Separate draft/read capabilities from send/delete/share capabilities; apply review, audit and cancellation paths to actions.

### Collaboration

First validate upstream's team-inbox plugin and sharing rights. Build team ownership, assignment and completion into the experience before considering collaborative drafts or private comments. Such comments need their own access-controlled storage and retention/export behavior; they must not leak into outgoing MIME bodies.

Assignment is not a mail access grant. Deep links and search must respect the existing mailbox rights. Shared labels, team templates, audit trails, notification targeting and collision handling require real multi-user tests.

## Architecture and upstream strategy

Retain Next.js, React, TypeScript, Tailwind, Zustand and the existing JMAP stack. Do not introduce TanStack Query as a second mailbox cache. TanStack tools can be adopted for a specific measured gap, not as a prerequisite for polish. Rust is reserved for a demonstrated gateway/native/background-processing requirement.

Use four implementation levels, in order:

1. Runtime configuration and a supported theme package.
2. A versioned Memail plugin for view definitions, optional commands and supported integrations.
3. Focused components/adapters at existing extension boundaries when the public API is insufficient.
4. Small documented core patches only when the first three cannot satisfy the workflow; isolate upstreamable fixes from product preferences.

Native category tabs let the split-inbox MVP render using the host's controls without a plugin iframe replacing the message list. Plugins do not run in Lite. Decide and document full-edition versus Lite behavior for every addition; hide unsupported controls or offer a deliberate native fallback rather than silently failing.

A durable reminder/follow-up service is a server capability, not plugin-local browser storage. Prefer an upstream extension point or server-supported mechanism. If a new service is necessary, define account-scoped persistence, leases, deduplication, cancellation, crash recovery and export before UI integration.

Keep mail in Stalwart. Use JMAP state and existing client caches for synchronization. Store only necessary view/preferences/workflow metadata separately. Offline caches need account isolation, sign-out cleanup and organization policy controls; self-hosting is not equivalent to end-to-end encryption.

Use free MIT ReUI components where they fit an actual new surface. Standard ReUI Pro source cannot be published in this public fork. Preserve Bulwark's AGPL/license notices; any premium redistribution needs explicitly compatible written rights. No blanket visual rewrite of upstream components is proposed.

## Phased delivery with exit gates

| Phase | Deliverable | Exit gate |
| --- | --- | --- |
| 0 - Trustworthy foundation | Fork policy, branding/theme, reproducible demo, CI/baseline inventory, Stalwart test environment and failure fixtures | Build/typecheck/lint documented; new checks pass; baseline test failures triaged; real server read/draft/send/attachment/push smoke passes |
| 1 - Focused inbox | A Memail plugin registering native query-based tabs, curated presets, account scope, counts and command access | Membership/count correctness across pagination/push; keyboard and phone access; no hidden mail or mutation from switching views |
| 2 - Finish and return | Better snippet workflow, action/waiting/read-later states, durable reminder/follow-up behavior, clearer scheduled-send state | Reminders work with browser closed, after restart and around timezone/DST changes; replies cancel appropriate follow-ups; send-outcome reconciliation passes |
| 3 - Grounded assistance | Existing writing plugin evaluation, selected-thread summaries, reviewed drafts, transparent query interpretation and source-linked answers | Tenant/account isolation; prompt-injection fixtures; no external content sent when disabled; unsupported facts flagged; measurable usefulness on a consented test set |
| 4 - Team operations | Upstream team-inbox integration, assignment/completion polish, shared templates, audit/notifications; comments/draft collaboration only after scope validation | Two-user permission/concurrency tests; no wrong-account send; no private-comment leakage; export and retention behavior defined |
| 5 - Product hardening and ecosystem | Mobile/PWA finish, large-mailbox performance, accessibility/RTL, import/export of Memail metadata, deployment/backup guide; additional provider study | Pilot acceptance, upgrade rehearsal, offline/reconnect correctness, accessibility and performance budgets met |

Release proposal: v0.1 private pilot after phases 0-1; v0.2 after phase 2; optional AI preview after phase 3; v1 based on quality/operability gates, not the number of integrations. No calendar dates or delivery estimates are committed before the first vertical slice and baseline measurements.

Privacy, accessibility, localization and upstream compatibility are acceptance criteria in every phase, not cleanup reserved for phase 5.

## Proposed success measures

These are targets to validate, not measured achievements:

- Keyboard feedback p95 under 100 ms; cached reader open p95 under 200 ms on a documented reference device/corpus. Measure network-bound completion separately from immediate UI acknowledgment.
- Zero lost draft edits, wrong-account sends, cross-account source leaks or duplicate sends in release regression fixtures.
- A representative 100-message triage exercise needs materially fewer actions and less time than stock Bulwark; use identical accounts/messages and record errors as well as speed. Set the improvement threshold after the baseline run.
- Focus-view precision is measured separately from recall. No priority message may disappear without remaining visible in All inbox and an explanation/correction path.
- Follow-up scheduling survives restarts and missed wakeups with a documented delivery tolerance and observable retries.
- Search evaluation includes known-answer tasks, relevant-source ranking, empty results and permission-denied material. AI quality measures factual support and user editing effort, not just generation speed.
- Accessibility checks cover keyboard-only use, focus return, screen-reader announcements, 200% text, 390px layout, reduced motion and RTL.
- Upgrade quality: each release rehearses a Bulwark upstream merge and reports core files changed, conflicts and regression results. Set a patch-size budget after the plugin MVP; do not hide maintenance cost.

Use synthetic fixtures for CI and performance work. Product analytics should be opt-in and aggregate; never include subjects, recipients or message bodies in telemetry. Pilot studies require informed participation.

## First implementation backlog

1. Finish phase 0: collect the outstanding full-suite result, classify baseline failures, and complete a disposable Stalwart smoke test. Keep the current branding PR in draft until its validation status is clear.
2. Build a throwaway plugin spike using `api.tabs.set`: All/Focus/Updates, fixed synthetic rules, no new runtime dependencies. Confirm counts, pagination, keyboard and mobile behavior. Define All separately from the host's default-complement tab semantics.
3. Add plugin settings for account-scoped sender/domain rules and saved-view export/import, with clear overlap semantics. Audit persistence/sync behavior instead of assuming browser plugin storage syncs across devices.
4. Add native command-palette entries through the existing action surface, with current-context selection and accessible labels. Reuse existing shortcuts; do not shadow browser/editor commands.
5. Validate the optional Memail theme in real inbox/reader/composer/settings states at desktop and phone widths; adjust tokens only for observed contrast/readability problems.
6. Measure the resulting workflow against stock Bulwark before broadening the scope.

## Deliberately deferred

Gmail/Graph/IMAP gateways, Rust rewrites, a new framework, a full CRM, omnichannel chat, invisible open tracking and autonomous outgoing mail are not first-release dependencies. Provider portability is a later design study: JMAP-standard features first, capability-gated Stalwart extensions second, and explicit limitations for other providers. Fastmail's own help says its snooze feature is not exposed to third-party clients, which is a concrete reason not to assume a common JMAP endpoint grants every provider-specific feature. [Fastmail snooze limitations](https://www.fastmail.help/hc/en-us/articles/360058753634-Snoozing-mail).

## Current implementation status

Branding/theme work is in [draft PR 1](https://github.com/Saivra/memail/pull/1), not merged. Production build and typecheck passed; lint had zero errors with existing upstream warnings; 66 targeted tests and the Git merge regression test passed. The broad upstream suite was still running when this research was prepared; no complete baseline pass or live Stalwart integration result is claimed.

This plan supersedes the earlier assumption that we needed to build category tabs, command infrastructure or AI writing from scratch. The focus plugin spike is complete. The user rejected theme-only customization and selected a Superhuman-led workspace redesign on 2 November 2026. The next milestone is an integrated shell and triage experience.

## Accepted workspace redesign

The user selected a Superhuman-led workspace after reviewing and rejecting the theme-only result. Theme 0.2 is groundwork, not design acceptance.

Deliver one coherent daily-mail flow: persistent Compose and compact navigation; prominent All/Focus/Newsletters splits connected to server queries; dense conversation rows with clear sender, subject, unread and selection hierarchy; a focused reading surface with primary reply/archive actions; keyboard navigation, command discovery and undo. Existing split-pane and mobile behavior must remain usable.

Acceptance requires an actual inbox-to-reply-to-archive browser walkthrough and screenshots of the new layout, with working split counts and empty/loading/error states. Optional plugin ZIPs, CSS-only changes, settings-only presets and decorative controls do not satisfy this milestone. Durable snooze/follow-up and contextual AI follow with their own backend acceptance, not simulated timers or fabricated responses.

### Delivery gates for the accepted design

1. Inbox workspace: persistent Compose, integrated configurable splits, a clear folder heading, compact full-width conversation hierarchy, and visible view controls. Demonstrate All/Focus/Newsletters membership, keyboard selection and archive/undo with server-backed counts.
2. Reading and composition: message-centered reading width, deliberate primary reply/archive actions, quiet secondary actions, recipient/identity clarity, attachment states and draft recovery. Demonstrate reply/save/reopen without losing edits.
3. Follow-through: durable waiting/read-later/reminder state with account-scoped persistence and restart recovery, then contextual AI behind explicit provider configuration.

The integrated view controls are implemented. Conversation hierarchy refinement, reader/composer redesign and browser acceptance remain open. Current workspace preferences are local to the device; they are not advertised as cross-device settings.


### Composition fidelity checkpoint

Implemented editable rich HTML paste, GFM Markdown insertion and recognized Markdown clipboard conversion, fonts with fallback stacks, six heading levels, styled table cells and Word list/style normalization. Explicit plain-text paste bypasses Markdown conversion. The native draft pipeline retains the resulting HTML in the HTTP demo.

Acceptance still needs live copy/paste samples from Word desktop, Google Docs and major LLM clients across browsers; representative Gmail/Outlook/Apple Mail received-message rendering; mobile toolbar review; and localization. Arbitrary document page layout and embedded fonts are not promised. Account-scoped device-local saved searches are also implemented; cross-device synchronization remains a later phase.
