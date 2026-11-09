# Accessibility

Bulwark should work for everyone who reads and writes mail, whether they use a mouse, a keyboard, a touch screen, speech input, a screen reader or magnification.

## What we aim for

- The target is WCAG 2.2 level AA for the whole webmail, as EN 301 549 V4.1.1 requires, plus the AAA criteria that are realistic for a mail client.
- Bulwark scales your browser's text size instead of replacing it, follows your system's contrast, motion and transparency settings, and leaves colours to Windows contrast themes.
- Everything can be reached with the keyboard. Single-key shortcuts can be turned off for speech input, F6 moves between panes, and Alt+Shift+A opens the accessibility options from anywhere.
- Screen readers get landmarks, headings and skip links, a message list that reads each message in one sentence, and announcements when a folder loads, a notification appears, an upload fails or the connection drops.

Settings > Accessibility has presets (screen reader, low vision, dyslexia, focus, keyboard and motor, motion and seizure safe, deaf and hard of hearing) and settings for text, colour, motion, pointer, timing and incoming mail. The [Accessibility](https://bulwarkmail.org/docs/features/accessibility) page in the documentation describes all of them.

If you run Bulwark for others:

- [Presets and locks for admins](https://bulwarkmail.org/docs/features/accessibility/admin) explains how to preset these options for your users and how to show links to your accessibility statement, barrier report, help, Easy Read and sign language pages on the sign-in page and in the app.
- [Accessibility law for operators](https://bulwarkmail.org/docs/legal/accessibility) covers EN 301 549, BITV 2.0 and the BFSG, with templates for an accessibility statement.

## Where this applies

The webmail and Bulwark Lite, in current desktop and mobile browsers. Everything in Settings > Accessibility also works in Lite.

The [mobile app](https://github.com/bulwarkmail/native) is a separate project and doesn't have these settings yet.

## Known barriers

- We haven't published a tested matrix of screen readers and browsers yet.
- There is no accessibility conformance report (ACR or VPAT) yet.
- Plain language mode is available in English and German only.
- The bundled reading fonts (Atkinson Hyperlegible, Lexend, OpenDyslexic) cover Latin script only.
- Bulwark can make incoming mail easier to read, but it can't fix a message the sender built badly: images without descriptions, text inside pictures, or meaning shown only by colour.
- Custom themes and plugins come from their authors and may not meet the same contrast and keyboard standards.

## Reporting a barrier

Open an [issue](https://github.com/bulwarkmail/webmail/issues/new) and put "Accessibility" in the title. Please include:

- what you were trying to do and what happened instead
- your browser and operating system
- any assistive technology you use, such as a screen reader, magnifier or speech input, with its version
- the Bulwark version, if you know it

If GitHub is hard to use for you, ask on [Discord](https://discord.gg/tYCujymGrT) and we'll open the issue for you.

If you use Bulwark through your employer or a mail provider, also tell them, through the barrier report link on their sign-in page if they have one. They are responsible for their own deployment, including their theme, plugins and texts.

## For contributors

Before you open a pull request that changes the interface:

- Try the change with the keyboard alone, and with a screen reader if you can.
- Give every control a name screen readers read out. For buttons that show only an icon, use the icon button in `components/ui/icon-button.tsx`, which requires a label.
- Keep text contrast at 4.5:1 or more in every built-in theme, light and dark, and don't show meaning by colour alone.
- Make targets at least 24 by 24 pixels, and give anything that needs dragging or hovering a button or menu entry as well.
- Respect reduced motion, and move the focus somewhere sensible when the element that had it goes away.

CI runs axe-core's WCAG 2.2 A and AA rules on the mail list, reading pane, composer, calendar, contacts and Settings > Accessibility, and fails on new serious or critical violations. It also checks that the focus outline stays visible in Windows contrast themes and that single-key shortcuts don't act behind an open dialog. To run it locally:

```bash
DEV_MOCK_JMAP=true npx next build --webpack
npm run test:a11y-guard
```

## Who looks after this

The Bulwark maintainers own accessibility for the project and triage barrier reports like other bugs. We update this page when accessibility features or known barriers change.
