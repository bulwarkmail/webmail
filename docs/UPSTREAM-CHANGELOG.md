# Changelog

## 1.19.1 (2026-10-31)

1.19.1 shows a card above booking, shipping and order mail, with the times, tracking and status that matter, and can put a booking in the calendar and keep it up to date. Mail that passes DMARC shows the sender's BIMI logo as its icon. Archiving, moving and reporting spam from an open message now follow "Return to list", archiving in unread first opens the next unread message, and a shared mailbox sends through its own identity. Plugins can forward a message to an address the user allowed and print a page they made, and new mail plays the Involved sound by default.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@systemflair](https://github.com/systemflair)
- [@bultester](https://github.com/bultester)
- Anonymous
- Anonymous
- Anonymous

**Monthly**

- [@Focus-On-Agency](https://github.com/Focus-On-Agency)
- Anonymous
- [@superspacehosting](https://github.com/superspacehosting)
- [@naokton](https://github.com/naokton)
- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Changes

- **Notifications**: New mail plays the Involved sound by default instead of the beep. If you never picked a sound you get Involved too; a sound you chose stays
- **Appearance**: List rows are no longer tinted with their first tag's colour by default. If you turned "Tint list rows by tag color" on yourself it stays on

### Features

- **Mail**: Booking, shipping and order mail that carries schema.org markup gets a card above the message: route and local times for flights, trains and buses, check-in and check-out for hotels, rental cars, events and restaurants, tracking for parcels and status for orders, with copy buttons and links that show where they lead. Flights, hotels and the other bookings can be added to a calendar you pick; a later mail about the same booking offers to update the event and a cancellation to remove it. Apple Wallet boarding passes and event tickets attached to a mail give the same cards. Cards appear only when the receiving server verified the sender's domain, never for forwarded mail, and everything is read in the browser without contacting airlines or carriers. Admins can turn them off under Policy
- **Mail**: Mail that passes DMARC for its From domain shows the sender's BIMI logo as the sender icon, with a check mark beside the name when a Verified Mark or Common Mark Certificate backs it. Bulwark checks the record and the certificate itself, since Stalwart doesn't do BIMI. A contact photo still comes first, and logos follow the sender icons setting and stay off when third-party traffic is turned off. Admins can limit logos to certificate-backed ones with "Require a mark certificate" or `BIMI_REQUIRE_CERTIFICATE`
- **Mail**: Expanded message headers in Mountain View have Reply all next to Reply (#1404, thanks @pcatapan)
- **Accessibility**: Each preset on the Accessibility page shows a small picture of what it changes
- **Admin**: On Stalwart 1.0, Auto-configure OAuth also registers a client for Bulwark Mobile, so the app signs in as a first-party client and gets the account security settings (#1459, thanks @Chaoskjell44)
- **Admin**: The marketplace shows the changelog of every version an update brings, not only the newest, and a rollback lists what it undoes
- **Plugins**: `api.email.forward` forwards a message with its attachments, from team mailboxes too, under the new `email:forward` permission. The user allows each address once, and can see and remove allowed addresses in Settings > Add-ons. A forward goes through the same checks and undo delay as a normal send
- **Plugins**: `api.ui.print` prints a page the plugin made, such as a readable invoice, without scripts or network access. The UI kit has a `Table` for line items and totals, and admin settings of type string can ask for a multi-line box with `multiline: true`

### Fixes

- **Mail**: Archiving, moving or reporting the open message as spam returns to the list when "Return to list after delete, archive, move or mark unread" is on, in Mountain View too (#1458, thanks @cmess0822)
- **Mail**: Archiving in unread first opens the next unread message instead of the first read one (#1453, thanks @ottsch)
- **Mail**: Search results can be moved into the folder that is open (#1452, thanks @sandrobraendli)
- **Mail**: A message sent from a shared mailbox uses that mailbox's identity for its From address, so the server no longer takes the envelope sender from one of your own identities (#1450, thanks @robinbohnen)
- **Mail**: Mountain View no longer offers Reply on drafts and scheduled messages in a conversation (#1404)
- **Mail**: Quick reply asks the same questions as the composer before sending: unfilled placeholders, a forgotten attachment and "Confirm before sending"
- **Mail**: The delivery report of a bounce or read receipt no longer shows as an attachment chip in the list or goes along when the message is forwarded
- **Mail**: The message list no longer jumps back while you scroll, the quick actions on the open message hide once the pointer leaves it, and a one-digit unread count stays next to the folder's total
- **Mail**: When two accounts have the same name, the account switcher shows the address as the title
- **Themes**: Unread mail stands out in Flat fields with a tint and a bar beside the avatar
- **Settings**: The density sample leaves out the preview line while "Show preview text" is off, and the search filter panel's button says Search instead of Done
- **Sidebar**: The gear and plus buttons in the header no longer run into the folder row below, and demo mode shows as a plain row instead of a tinted box
- **Accessibility**: With reduce motion, menus open in place instead of flashing in the corner first
- **Plugins**: Badges show on message rows drawn before the plugin started, and dev plugins whose dependencies only declare `main` or reach for Node built-ins now bundle
- **Server**: `npm start` listens on the `HOSTNAME` and `PORT` from `.env.local` (#1441, thanks @garceri)
- **Demo**: Replies sent in demo mode show in the conversation they answer, and the personal demo account has contact photos

## 1.19.0 (2026-10-29)

1.19.0 gives admins an Organisation area: signatures, disclaimers and template libraries per domain or group, external mail warnings, idle and session time limits, settings locked to a value, and one switch that stops all traffic to third-party services. On Stalwart 1.0, group mailboxes share tags and templates, a colleague can be made a delegate in one step, and mail deleted for good can be recovered from Stalwart's archive. A new Accessibility page in Settings has presets, text size and spacing, reading aids for mail and keyboard options, and the app was gone through with screen readers, the keyboard, contrast themes and large text. A usability pass made dialogs, menus, wording and phone layouts work the same way in Mail, Calendar, Contacts and Files, and added Undo for most mail actions, a Files trash and printing. Thai is a new language.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@systemflair](https://github.com/systemflair)
- [@bultester](https://github.com/bultester)
- Anonymous
- Anonymous
- Anonymous

**Monthly**

- [@Focus-On-Agency](https://github.com/Focus-On-Agency)
- Anonymous
- [@superspacehosting](https://github.com/superspacehosting)
- [@naokton](https://github.com/naokton)
- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Changes

- **Accessibility**: Text size is now a share of the text size set in the browser, from 87.5% to 200%, instead of a fixed 14, 16 or 18 px, and small text everywhere follows it. The Animations switch is now Reduce motion, which follows the system unless you set it

### Features

- **Organisation**: The admin panel has an Organisation area where the user policy applies to everyone, a domain or a group. Admins can lock any setting to a chosen value or only preset it, accessibility options included, and export and import the whole policy as one file; an import names the locks and defaults it changes. Users see "Set by your organisation" next to a locked setting
- **Organisation**: Admins can set an organisation signature with placeholders for each user's name, address, company, job title, department and phone numbers, per domain or group, and lock it so it replaces everyone's own signature. Users fill in their details once under Settings > Account. Lines whose details are empty are left out (#908, thanks @chutescarabee7)
- **Organisation**: Admins can add a legal disclaimer that goes below every message when it is sent, never into drafts, and is shown read-only in the composer
- **Organisation**: Admins can give every user a library of templates, per domain or group, that users pick under "Organisation" in the template picker and can copy but not change
- **Templates**: On Stalwart 1.0, members of a group mailbox share team templates, and users' own templates are kept in their account so they follow them to every browser. Templates already in a browser move over on the first sign-in. Admins can lock team templates or leave users only the organisation and team templates
- **Tags**: On Stalwart 1.0, members of a group mailbox see the same tag names and colors on its mail, in the list, the tag picker, the sidebar and the unified inbox. They edit them under Settings > Folders & tags, where tags already on the group's mail can be given a name. Admins can lock the list per domain or group, for example so only team leads change it (#470, #1310, thanks @andrei-miron and @HOLOEYE-JZ)
- **Organisation**: Admins can label mail from outside the organisation with an "External" chip and have users confirm before sending to or inviting external recipients (composer, quick reply and meeting invitations), per domain or group. Partner domains and contacts count as internal. This replaces the External Mail Warning plugin, whose safe domains can be imported. Plugins can read `api.host.features.externalSenderLabel` and `externalRecipientWarning`
- **Organisation**: Admins can sign users out after a time without activity or a fixed time after sign-in, per domain or group. A countdown with "Stay signed in" comes first, open and minimised messages and quick replies are saved as drafts, and the login page says why
- **Delegates**: Settings > Sharing gives a colleague read, or read and write, access to all mail folders or just the Inbox, calendars and contacts in one step, lists who has access to what, and removes access everywhere at once. Admins can hide it per domain or group and limit every share dialog to read access on Organisation > Sharing
- **Recover deleted items**: On Stalwart Enterprise with archiving turned on, users bring back mail they deleted for good under Settings > Recover deleted items, or from a link in Trash when there is something to recover. Restored mail goes back to the Inbox unread. Admins can limit how many days back it lists or hide it per domain or group (#1319, thanks @svandive)
- **Privacy**: One switch, `NO_THIRD_PARTY_TRAFFIC` or Organisation > Security, stops every connection to services outside your own servers: telemetry, the version check, the built-in push relay, the official extension directory, sender icons, MyMemory translation, map links, OpenPGP key lookups and remote pictures in mail. Plugins that need network access don't run, and the page's CSP allows only the hosts you configured. Push registrations move to your own relay. The admin page lists what stays reachable (#903, thanks @rickgoud)
- **Team inbox**: The new official Team inbox plugin lets members of a team mailbox assign messages to each other, mark them done, and filter by "Assigned to me" and "Open"
- **Plugins**: Plugins can add keyword filters to the message list, shown as chips above it, put icons on row badges, show actions only in team mailboxes or for some keywords, change several keywords in one step, see the user's own account and which mailboxes are team mailboxes, and keep a small shared value in a team mailbox on Stalwart 1.0. Looking people up in the directory needs the new `directory:read` permission. Plugins can no longer set `$draft`, `$junk`, `$notjunk` or `$phishing`
- **Plugins**: `api.ui.openPage` moves the tab to one of the plugin's own pages (#1406, thanks @HOLOEYE-JZ). A plugin's search result snippet can mark what matched (#1418, thanks @HOLOEYE-JZ), and the results block holds its place while a plugin is still searching (#1419, thanks @HOLOEYE-JZ)
- **Accessibility**: Settings has an Accessibility page. Presets for screen readers, low vision, dyslexia, focus, keyboard and motor, motion and seizure safety, and deaf and hard of hearing users change several options at once and can be undone. Alt+Shift+A opens text size, contrast, motion and the presets from anywhere, and a button in the navigation bar can do the same
- **Accessibility**: Text can use Atkinson Hyperlegible Next, Lexend or OpenDyslexic, with more line, letter, word and paragraph spacing. More contrast works on any theme, and transparency can be reduced, links underlined, the focus outline made thicker and the pointer made larger
- **Accessibility**: Reading aids for mail: a reader view in the app's font, spacing and colours, read aloud with the browser's voice while highlighting what it reads, a reading mask that dims all but a band of lines, animated images paused behind a play button, HTML mail as plain text by default or per message, lines of about 80 characters, wide mail scaled down to the pane, HTML mail in the app's font and colours, and message bodies at the chosen text size
- **Accessibility**: Calendar, tag and folder colours can use a colour-blind-safe palette, and names can show next to colours: a tag's letter in its dot and the calendar's name on events
- **Accessibility**: Large targets make buttons, menu items, rows and switches 44 px. Simple mode shows one column and, if wanted, a paged message list. Submenus, previews and the rail peek can open only on click, and tags, filter rules, apps, accounts and Pro tabs can be reordered without dragging
- **Accessibility**: Single-key shortcuts can be turned off. Every app has landmarks, a page heading, skip links and F6 to move between panes, and ? opens the keyboard shortcuts of the app you are in
- **Accessibility**: Screen readers are told when a folder or search has loaded, how much new mail came, when a draft is saved and when the connection drops, and toasts are read out, errors assertively. Toasts stay while focused, Alt+Shift+N jumps to the newest, and the notification duration also covers undo toasts, errors and reminders. Visual alerts flash the tab title slowly, and plugin notifications stay off the desktop during do not disturb
- **Accessibility**: Plain language gives simpler English and German wording for sign-in, errors and Settings. Technical terms in Settings and the admin area get short explanations that work with keyboard, touch and screen readers
- **Accessibility**: Optional confirmations before deleting, archiving and sending, a prompt for alt text when an image goes into a message, an accessible example message in the template picker, and a default font and size for new messages
- **Admin**: Links to an accessibility statement, a barrier report, help, Easy Read and sign language show on the login page, in the settings sidebar and in the account menu when set with `ACCESSIBILITY_STATEMENT_URL`, `ACCESSIBILITY_FEEDBACK_URL`, `HELP_URL`, `EASY_READ_URL` and `SIGN_LANGUAGE_URL`
- **Admin**: `OAUTH_REVOKE_ON_SIGN_OUT=false` keeps the refresh token valid on sign-out, so Stalwart 1.0 keeps Bulwark in the user's connected applications and doesn't ask for consent again (#1388, thanks @Beckid)
- **Login**: `LOGIN_USERNAME_PLACEHOLDER` sets the placeholder of the login email field (#1423, thanks @DerFolder)
- **Login**: The SSO-only login page offers "Remember me", and the box decides for every single sign-on path (#1437, thanks @marketstead-dave)
- **Setup**: The setup wizard shows in the browser's language, in all 29 languages
- **Mail**: Ctrl+Z or z undoes the last mail actions, newest first, marking read or unread, stars and tags included. Delete to Trash, archive, move, spam report and remove from folder offer Undo in their toast, also after a move to another account and in lists that mix accounts
- **Mail**: Scheduled messages can be cancelled back into Drafts and rescheduled in the Schedule send dialog. "This morning" and "This afternoon" are offered as schedule times while they are still ahead (#1390, thanks @PoltoS)
- **Mail**: Before sending, Bulwark warns about unfilled placeholders such as [Your name], in every app language, and about unfinished text. The warning can be turned off
- **Mail**: Attachments can be saved to Files from the message, from shared and group mailboxes too
- **Mail**: The list header has a Sort menu and the folder's actions, and the filter panel is simpler, with on/off toggles, date and size ranges and every field in view
- **Mail**: A click anywhere beside a row's avatar or checkbox ticks it (#1381, thanks @mmomjian)
- **Mail**: A message whose sender check failed shows a warning shield instead of the sender icon
- **Composer**: Quoted reply history collapses behind an ellipsis (#1405, thanks @pcatapan)
- **Composer**: A recipient chip's menu moves it between To, Cc and Bcc, and the tag and template pickers can make a new tag or open the template manager
- **Command palette**: Mail's commands (reply, archive, delete, move, read state, spam, go to a folder), Calendar's, Contacts' and Files' commands, plugin pages, account switching and "search everything" are in the palette. Apps can add their own commands
- **Print**: Print or Ctrl+P prints a clean copy of the page instead of the app shell: the calendar's month, week, day, agenda, tasks and single events, and contact lists, contacts, groups and directory entries
- **Calendar**: Events can be searched from the toolbar, with / and from the command palette
- **Calendar**: Light event colours show events tinted with a colour bar, as in Outlook
- **Calendar**: A cancellation mail offers to remove the cancelled meeting from the calendar (#1425, thanks @chutescarabee7)
- **Calendar**: Dragging or resizing a repeating event asks which occurrences move, and the move can be undone. A single click on a month day or the all-day row opens the quick editor for an all-day event, and Shift+F10 opens an event's menu
- **Contacts**: Address books and contact categories can be deleted in Settings, and contacts move with Move to…
- **Files**: Deleted files go to a trash with Restore, Delete permanently and Empty trash. Files and folders move with Move to… and a folder picker, a folder downloads as a zip built in the browser with progress and cancel, and images and other files open in one preview with ←/→ to the next file
- **Files**: With a document editor configured, "New file" also creates Word, Excel, PowerPoint, OpenDocument and (where the editor edits PDFs) PDF files and opens them in the editor. It offers the formats the editor can edit; admins can narrow the list with `WOPI_NEW_FILE_FORMATS` and add their own blank templates, or other formats, with `WOPI_TEMPLATE_DIR` (#1393, thanks @Monarobase)
- **Files**: The Files settings sync with the other settings, with export, reset and a one-time move from this device
- **Phone**: Every app's phone header has notifications, the command palette and the account avatar, and Contacts gets a create button and long-press menus like Mail and Files
- **i18n**: Thai (#1379, thanks @phumiphat2201)

### Performance

- **Mail**: Shared accounts' folders load in batched, parallel requests instead of one request per account (#1409, thanks @truesysadmin)
- **Tags**: Tag counts come from one Keyword/get on servers that count keywords (#1399, thanks @lucamzanon), and a hidden tab recounts once it is shown instead of on every push (#1400, thanks @lucamzanon)
- **Push**: The keep-alive echo is skipped while the push stream is live (#1401, thanks @lucamzanon)

### Fixes

- **Accessibility**: Every form field, icon button and switch has a name screen readers read out, and password managers can fill the sign-in form. Dialogs, file previews, the document editor, the search palette and plugin dialogs keep the focus inside and give it back when they close
- **Accessibility**: The message list is one Tab stop that screen readers read row by row. The calendar grid and mini calendar work with arrow keys and read events with their date, the contact and files lists move with the keyboard, and menus, grid cells and other roving-focus controls show the focus outline
- **Accessibility**: Text contrast is at least 4.5:1 in every built-in theme, light and dark. Switches, selections and pressed buttons stay visible in Windows contrast themes, small controls have at least a 24 px target, and toasts move away from the focused control
- **Accessibility**: With a large browser text size the message list stays visible next to the reader and cut-off labels wrap, Aurora Glass turns solid when transparency is reduced, and animations inside mail stop with reduce motion
- **Dialogs**: Dialogs share one shell with the close button at the end, Escape, outside click and a discard prompt for typed changes, and their title stays in view while the content scrolls. The app's own dialogs replace browser prompts and confirm boxes, and leaving an editor or admin page with unsaved changes asks first, also on browser Back
- **Wording**: The same action has the same word, icon and place across Mail, Calendar, Contacts, Files and Settings, labels use sentence case, delete prompts say what is lost, and German addresses you formally everywhere
- **Mail**: A message has the same actions in its row menu, the reader's ⋮ and the phone panel. The selection bar has Archive, Report spam and a menu with the rest, the phone conversation view has Archive, Delete, Report spam, Mark as unread and Move, and a swipe archives or deletes a conversation row too
- **Mail**: Delete follows the Delete action setting, archiving a conversation leaves your sent copy in Sent, Undo after Report spam puts the message back, and View source shows the message's real source
- **Mail**: Clearing search filters keeps the open folder (#1430, thanks @creyD), system folder names are translated in advanced search (#1429, thanks @creyD), and a rule run on existing messages reads From, To and Cc conditions on Stalwart (#1424, thanks @creyD)
- **Mail**: A dmarc pass no longer comes with a warning about failed checks (#1403, thanks @Fneufneu), a DKIM pass reported only by `header.i` counts (#1420, thanks @DerFolder), and invitations from users on your own domains aren't flagged as unverified (#1374, thanks @chlw)
- **Mail**: Failed attachment downloads and partial or failed "Download all" say so (#1426, #1428, thanks @VasilisNtovolos), permanent bulk deletes that partly failed are reconciled (#1384, thanks @VasilisNtovolos), and the attachments of a previewed .eml preview too (#1395, thanks @lucamzanon)
- **Mail**: Conversations show the scheduled status (#1359, thanks @arnauda-gh), folder counts update as soon as a send removes its draft (#1412, thanks @NobinKhan), and a mail sent right after a proxy outage goes out from the account's identity (#1377, thanks @kisaanu)
- **Mail**: Attachment icons in the reader are coloured by file type like in the list, a mail's own overflow no longer adds a second scrollbar, and pushed notifications stay silent during do not disturb
- **Composer**: A send no longer races the autosave (#1394, thanks @lucamzanon), a draft written in another client keeps its paragraph spacing (#1416, thanks @b3rsrk), the footer drops its labels when the composer is narrow (#1375, thanks @rgaliull), and the install card stays off the Send button and remembers "Not now" (#1411, thanks @NobinKhan)
- **Sign-in**: The two-factor prompt shows as the next step instead of an error (#1422, thanks @DerFolder), password and two-factor settings show after a password and code sign-in (#1432, thanks @JamesJosephFinn), Lite on Stalwart no longer opens the browser's login dialog when the access token expired, uploads included (#1396, thanks @robinbohnen), and the account security docs open on bulwarkmail.org (#1387, thanks @DodoLeDev). Every app asks for a fresh two-factor code, not only Mail
- **Calendar**: Default alerts get account-wide unique ids (#1435, thanks @rich0), a shared calendar shows the colour the server gives it (#1414, thanks @chodid), and one account's tasks stay out of another's task list (#1380, thanks @HOLOEYE-JZ)
- **Calendar**: Week and day view fill with the visible hours and mark events that run past them, a saved event comes into view, short events open on click, and events you can't change offer no Edit, Delete, drag or resize
- **Contacts**: Exports are valid vCard 4.0 (#1407, thanks @motofix), escaped colons in imported vCard notes are decoded (#1438, thanks @tacky6775), and a new or duplicated contact shows after saving
- **Files**: Files list on Stalwart 1.0 when the account holds more nodes than one request returns (#1385, thanks @IchiganCS), and Back closes a preview or the document editor instead of leaving Files
- **Plugins**: Full-height app pages fill the page (#1357, thanks @yontani), and search stops waiting for plugin results when it fails
- **Right-to-left**: In Arabic, Hebrew and Persian, arrows, panels, drawers and the phone sidebar are mirrored, events sit on the right day, and senders, subjects and event titles keep their own text direction
- **Phone**: Tour steps open the screen they point at, toasts sit above the bottom bars and can be swiped away, and calendar, contact and settings rows put their actions behind a ⋮ menu
- **Build**: The production build's type check stays within 2 GB of memory (#1431, thanks @bagasme)
- **Demo**: Switching demo accounts no longer crashes, and forwarding as attachment, export, view source and file previews work in the demo

## 1.18.0 (2026-10-26)

1.18.0 works with Stalwart 1.0, released today, as well as with 0.16. Sign-in, calendars, contacts, files and sending were adapted to what changed in 1.0, and a Stalwart that was moved from 0.16 to 1.0 with Stalwart's migration tool keeps working with the same open tabs. It also fixes the findings of a security review of the whole webmail, more places where an action in a view that mixes accounts could hit another account's message with the same id, and a series of calendar bugs around repeating events. Plugins can show their own search results and a count on their buttons, quick reply can be turned off, and a new device offers to restore your saved account list.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@bultester](https://github.com/bultester)
- Anonymous
- Anonymous
- Anonymous
- Anonymous

**Monthly**

- Anonymous
- [@superspacehosting](https://github.com/superspacehosting)
- [@naokton](https://github.com/naokton)
- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Upgrading to Stalwart 1.0

- After moving Stalwart to 1.0, run **Auto-configure OAuth** once on the admin **Authentication** page. It registers Bulwark with Stalwart as a first-party client. Without it, mail, contacts, calendars and files work, but the account security settings (password, two-factor, app passwords) are not available, and single sign-on through Stalwart needs the registered client
- Stalwart 1.0 can't be installed over 0.16: its migration tool (`stalwart-migrate`) copies the data into a new store. Ids and sync state are kept, so Bulwark carries on without reloading anything, but OAuth tokens are not migrated: everyone who signed in with single sign-on, or with a password and a two-factor code, signs in again. Keep the server's public URL the same
- Admin sessions are signed out once by this update, and they now also end when you sign out or change the admin password

### Security

- **Plugins**: `/api/plugin-approval-status` refuses plugin packages while user plugins, plugin uploads or their review are turned off. Any signed-in user could fill the admin's review queue and the data directory with packages (GHSA-qc44-275p-gqw9, thanks @oguzyilmaznet)
- **Sidebar apps**: With `COOKIE_SECURE=true`, the unprefixed sidebar-app cookie is no longer trusted behind a TLS proxy that sends no `X-Forwarded-Proto`, so a sibling subdomain can't add origins to the page's `frame-src` (GHSA-cjm9-m826-mh78, thanks @oguzyilmaznet)
- **Sign-in**: A stored credential that the mail server refused (password changed, app password revoked) is not sent again for an hour, and a global cap stops a loop of them, so a stale session can't get the webmail's address banned by Stalwart for every user. Server-side calls forward the client address (GHSA-g6c7-r7wq-xrm2, thanks @oguzyilmaznet)
- **Multi-account**: More actions name both the login and the account. Removing a login whose folder was open, the Scheduled list, contacts in shared address books or another login, plugin moves, single-message archive and delete, the replied/forwarded flags, scheduled badges and Undo for a signed-out login could act on another account's message, contact or submission with the same id (GHSA-8x23-qw3w-mhrx)
- **Sign-in**: On a server that reports a bare login name, a token sign-in could claim that name on any domain and reach the synced settings and stored plugin credentials of that address
- **Sign-in**: A password and two-factor sign-in to a server you typed went to the default server when custom servers are allowed, and the password sign-in followed a mail server's redirect to another host with the password
- **Sign-in**: A password and two-factor sign-in without "Remember me" ends with the browser session instead of staying signed in for 30 days
- **Mail**: A link in a printed message can't redirect the webmail tab, links in conversation messages go through the same link check as the reader, a winmail.dat part whose type a browser would drop is downloaded instead of opened, and an unquoted `cid:` image no longer hides the rest of the message
- **Mail**: Outlook-style replies (plugin) no longer load the quoted message's remote images
- **Calendar**: Only a counter proposal from one of the meeting's participants can be applied to your meeting; anyone who knew its UID could propose a new time or place to all attendees
- **Admin**: `config.json`, the admin password hash and the setup token are written readable only by the app's user, a synced settings file can no longer pass as an admin session, and the setup wizard refuses a session secret under 32 characters
- **Server**: Request bodies over 10 MB are no longer buffered for every path before routing (only WebDAV uploads, the plugin proxy and office saves take more, and cap it themselves), answers from a mail server you picked are read up to a size limit, and the app files in the Docker image are read-only for the user it runs as
- **Dependencies**: undici 7.30.1 (GHSA-xjj6-f33q-929c)

### Features

- **Stalwart 1.0**: Calendars, tasks, contact photos, files, free/busy, sending past Stalwart 1.0's submission limit, phrase search, and its rules for keywords, file names and time zones work on 1.0 as on 0.16. Bulwark Lite installs as a Stalwart 1.0 Application
- **Plugins**: Plugins can show their own results in search and open the message a result names (#1336, #1338, thanks @HOLOEYE-JZ), and show a count on their buttons (#1345, thanks @HOLOEYE-JZ). `email.get`, `email.getRaw` and `email.getAttachment` take an optional account id, and summaries carry it
- **Accounts**: A new device offers to restore the saved account list (#1363, thanks @lucamzanon)
- **Mail**: Quick reply below messages can be turned off in Settings (#1370, thanks @maxhaomh)
- **Mountain View**: The inbox splits into Unread and Everything else, and attachment and code chips look like Gmail's
- **Server**: iCal subscriptions and other server-side fetches go through the outbound proxy when `NODE_USE_ENV_PROXY=1` is set. Bulwark still checks the address itself and asks the proxy for exactly that address (#1367, thanks @Jan0oo)

### Fixes

- **Sign-in**: Password and two-factor sign-in, Bulwark Lite and phone pairing work on Stalwart 1.0, single sign-on asks for mail, contacts, calendar and file access there, and a background account signed in with OAuth renews its own token instead of the active account's (#989, thanks @Almost-Senseless-Coder)
- **Sign-in**: Signing out of one login switches to the remaining one when it was signed in before the page loaded, instead of signing out of all, and an OAuth account that can't be restored has its refresh token cleared
- **Mail**: Bulk archive in the unified inbox creates each account's Archive, and a group account's year and month archive folders are reused
- **Mail**: The unified inbox shows new mail of a group or shared account and of another signed-in login without a click (#1350, thanks @ClapsAndJiggles), and message links open the message of the account they name (#1351, thanks @ClapsAndJiggles)
- **Mail**: The list keeps loading older mail when the server sent no total (#1364, thanks @inceblog), inline images whose part name is a path show (#1371, #1373, thanks @motofix), and Outlook-style HTML quotes without a border are kept (#1355, thanks @maxhaomh)
- **Mail**: Sent paragraphs keep the spacing the composer shows (#1340, thanks @arnauda-gh), replies to deeply nested quotes and mails full of blockquotes no longer freeze the page, and attachment names drop direction-override characters everywhere
- **Sending**: "Send now" of a group identity's delayed mail no longer drops it back into Drafts, own and group scheduled mail stay apart, a send refused for some recipients says so, and a held reply from a Pro compose tab still marks the original as answered
- **Calendar**: The open calendar updates and reminders fire on time when events change elsewhere (#1349, thanks @ClapsAndJiggles), events sit and resize at their clock time on DST change days (#1348, thanks @ClapsAndJiggles), a calendar added later follows the server's visibility (#1372, thanks @somus), a colour from the system colour dialog is applied (#1366, thanks @chodid), and hiding every calendar sticks
- **Calendar**: Editing, moving, splitting and answering repeating events keeps their changed and cancelled occurrences, organizer and answers, and asks attendees again only when the time changes
- **Calendar**: A subscribed feed's changes to events it still carries are applied, meeting replies are checked against the attendee who answers, exported events keep emoji and names with a colon, and the Calendar Agenda shows all-day events on their day west of the server
- **Contacts**: Photos, UIDs and group members are kept on Stalwart 1.0, and a closed directory says so instead of reporting a failed refresh
- **Files**: Folders and uploads work on Stalwart 1.0, symlinks show as links, shared folders sit under "Shared with me", and files copy between your drive and shared drives
- **Push**: Mail in an account shared into another signed-in login gets its notification again, previews work when the webmail reaches Stalwart on an internal address, and two logins with the same account id get a plain notification instead of the wrong preview
- **Lite**: A replayed deep link keeps its query parameters (#1352, thanks @ClapsAndJiggles)
- **Admin**: The allowed frame ancestors saved in the dashboard reach the header, and `setup.sh` asks again for a pasted session secret under 32 characters
- **Accessibility**: The rail's Mail entry is named "Mail" for screen readers, not its unread count
- **i18n**: Missing Estonian strings and the quick reply setting are translated, and the German account-list restore prompt addresses you formally

## 1.17.2 (2026-10-24)

1.17.2 fixes a cross-site scripting hole in re-opened drafts and keeps Safari from dropping push subscriptions after pushes that had nothing new to show. Drafts written as a group identity now stay in the group's Drafts, and bulk delete, trash and move with several accounts on different servers act on the right server. Plugins can update and remove their own tags, format dates in the user's regional settings and put buttons beside a sidebar section's title. User-facing texts use the configured app name instead of "Bulwark".

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@bultester](https://github.com/bultester)
- Anonymous
- Anonymous
- Anonymous

**Monthly**

- Anonymous
- [@superspacehosting](https://github.com/superspacehosting)
- [@naokton](https://github.com/naokton)
- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Security

- **Composer**: The quoted original and the signature in a re-opened draft are sanitized before they render. A draft written by another client, or by another member of a shared mailbox, could carry markup that ran script in the webmail when you opened it (GHSA-g35q-3gpc-x2rr, thanks @muhammad-zeeshan1337)

### Features

- **Plugins**: Plugins can change the label, colour and visibility of the tags they added and remove them again with `keywords.update` and `keywords.remove`. Both need `settings:write` and never touch the user's own tags or another plugin's (#1333, thanks @HOLOEYE-JZ)
- **Plugins**: Plugin frames get the user's date locale, 12/24-hour setting, time zone and first day of the week, and can format with `api.i18n.formatDate` and `api.i18n.formatTime`, without asking for `settings:read` (#1335, thanks @tobiasge)
- **Plugins**: A new `sidebar-section-actions` slot puts a plugin's buttons beside its sidebar section's title instead of in a row below it (#1317, thanks @LeonardNJU)
- **Admin**: A policy switch lists the Tags above the shared mailboxes in the sidebar, so they stay in sight when many shared mailboxes are expanded. It is off by default (#1334, thanks @HOLOEYE-JZ)
- **Branding**: Default apps in Settings, the "Open Bulwark" notification, the rate-limit banner, the plugin connect dialog and the connector page use the configured `APP_NAME`, and the settings search finds them by it (#1314, thanks @ghozty)

### Fixes

- **Push**: Every push ends with a notification, also one that brings nothing new (a redelivery, mail already read or already announced), and a slow preview gives way to the generic notification after 10 seconds. Safari treats a push without a notification as silent and drops the subscription after three (#1322, thanks @oguzyilmaznet)
- **Mail**: A draft written as a group identity is saved in the group account's Drafts, where its Sent copy also goes, instead of in your own (#1090, thanks @hildebrandttk)
- **Mail**: A sub-address of your own address (you+tag@) sends from your account, even when a shared catch-all account has a wildcard identity for the domain
- **Mail**: Bulk delete, trash and move send each message through the login that owns it. With accounts on two servers that use the same account id, they went through the first login and could hit an unselected message on the other server (#1307, #1326, thanks @VasilisNtovolos)
- **Mail**: Dragging several messages out as a ZIP fails with a message when one of them can't be fetched, instead of leaving it out, and the same selection can be tried again (#1306, thanks @VasilisNtovolos)
- **Tasks**: A task alert relative to the start fires from the task's start instead of its due date. A task without a start still counts from its due date (#1328, thanks @ClapsAndJiggles)
- **Plugins**: Plugins installed by the admin are listed in browsers that can't cache their code, such as some private windows (#1327, thanks @ovizii)
- **i18n**: The Ukrainian "Forward" and "Move to" are translated as the actions, not as "ahead" and "go to" (#1311, thanks @vladonv)

## 1.17.1 (2026-10-22)

### Security

- **Dependencies**: Next.js 16.4.2 and DOMPurify 3.4.17 fix six published advisories, three of them critical. None of them reached Bulwark: the webmail has no `use cache` functions and no Server Actions, its image optimizer refuses SVG and runs on sharp 0.35.5, which already carries the fix, and the mail sanitizer uses none of the DOMPurify modes the bypasses need (SAFE_FOR_TEMPLATES, IN_PLACE, XHTML parsing). Updating is still recommended

1.17.1 stops the background-notifications prompt from asking you to turn push on while the app is still restoring a subscription the browser dropped, and an open tab now repairs a dropped subscription on its own. The message list stays within the screen on phones, and a browser that was already signed in hands a mobile sign-in to the app again.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@bultester](https://github.com/bultester)
- Anonymous
- Anonymous
- Anonymous

**Monthly**

- [@superspacehosting](https://github.com/superspacehosting)
- [@naokton](https://github.com/naokton)
- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Changes

- **Dependencies**: vitest 4.1.12 and vite 8.3.5 (npm audit)

### Fixes

- **Push**: The background-notifications prompt waits for the background re-sync and only asks if push is still off afterwards, instead of appearing while the app is restoring a subscription Safari dropped (#1321, thanks @oguzyilmaznet)
- **Push**: A tab that stays open notices when the browser drops or replaces its push subscription and registers the new one at once, and coming back to the tab recreates a lost subscription instead of waiting for the next reload (#1321)
- **Mobile**: On phones, the message list is never wider than the screen, so the header's buttons, each row's date and the subject's ellipsis stay on screen and the selection toolbar compacts its buttons
- **Login**: A mobile sign-in opened in a browser that was already signed in keeps the sign-in form and hands the sign-in to the app, instead of opening the mailbox and leaving the app stuck in its sign-in sheet

## 1.17.0 (2026-10-21)

1.17.0 gives plugins real panels: a panel next to the message you write or read can fill its height, start folded, be opened by the plugin, and be dragged wider, and plugins get right-click menus on selected text in the composer and in a message. Plugins can also search mail and the settings, read the user's preferences and the app's version. The AI Writing Assistant in the marketplace builds on this and needs this release. The reader's side panel stays open from message to message, and the admin panel is reworked around a settings-style sidebar with one URL per page. The Docker images move to Node.js 24.22.1 for a Node.js security fix.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@bultester](https://github.com/bultester)
- Anonymous
- Anonymous
- Anonymous

**Monthly**

- [@superspacehosting](https://github.com/superspacehosting)
- [@naokton](https://github.com/naokton)
- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Security

- **Server**: The Docker images are built on Node.js 24.22.1, which fixes an out-of-bounds write in the Brotli decoder (CVE-2026-111497). The server decodes Brotli responses when it fetches a calendar subscription, a WebDAV share or a plugin request, so a signed-in user could point it at a host that sends a crafted response and run code on the server. The same Node.js release fixes TLS hostname checks for servers addressed by IP. Standalone installs run on the system's Node.js: update it to 22.23.4, 24.22.1 or 26.12.1

### Features

- **Plugins**: A panel slot (`composer-sidebar`, `composer-sidebar-right`, `email-detail-sidebar`) can fill its panel and scroll inside (`fill`), start folded until the user or the plugin opens it (`startFolded`), and be opened, closed and toggled by the plugin with `api.ui.openPanel`, `closePanel` and `togglePanel`, which answer null where no panel is on screen (phones), so a plugin can fall back to a dialog. A panel opened this way gets a `focusRequest` prop
- **Plugins**: The composer's plugin panels get the composer id, the draft and the selected text as it changes; the reader's side panel gets the selected text; reader frames learn whether they are on a phone, a tablet or a desktop (`deviceType`)
- **Plugins**: Right-click menus on selected text: `composer-selection-menu` in the message being written and `reader-selection-menu` in an open message. The browser's own menu stays until a plugin adds entries; the webmail then draws Cut and Copy and the plugin's entries, and the click carries the selected text
- **Plugins**: Text selected inside a message's body (an HTML mail in its frame) now reaches `onTextSelectionChange`
- **Plugins**: Plugins can search mail with `api.email.search`, search the settings and read the user's preferences, and read the app's name and version with `api.app.getInfo`
- **Mail**: The reader's side panel stays open when you move to another message, and its toggle sits in the reader toolbar, which now runs over the side panels to the right edge
- **Composer**: The plugin panels beside the composer can be dragged wider or narrower, and keep their width
- **Admin**: The admin panel is reworked around a settings-style sidebar with one URL per page, the real navigation rail and extension icons

### Fixes

- **Mail**: Rescheduling a scheduled message cancels the original send before creating the new one, so it works on servers that allow one active submission per message (#1308)
- **Mail**: Dragging messages out of the list and downloading attachments, inline images and the raw message in the Pro view use the account that owns the message, so shared and secondary-account messages no longer fail (#1299, #1300, thanks @VasilisNtovolos)
- **Mail**: Deleting a message from its hover actions shows the actions on the next row that slides under the pointer, so you can delete one after another from the same spot (#1297, thanks @dealerweb)
- **Mail**: PDF attachment previews open in Safari (#1301)
- **Mail**: The contact card for a sender or recipient opens in place instead of sliding in from the top left
- **Plugins**: A plugin's passphrase dialog stays open while you type (#1302)
- **Plugins**: The push preference mirror no longer throws in sandboxed plugin frames (#1298, thanks @dealerweb)
- **Layout**: A pane divider stops following the mouse when the button is released over a frame
- **i18n**: The German dialog that hands a sign-in to the mobile app is translated (#1296, thanks @dealerweb)

## 1.16.0 (2026-10-19)

1.16.0 regroups the settings into fewer pages with an Advanced switch for the power-user options, shows the message list as columns on request, turns @mentions into contact chips, and opens the company directory in contacts and the composer. The marketplace can install any version of an extension and roll back to a replaced one, admins get policies for the colour mode, archiving and the provider sign-out, and the Estonian locale arrives. A security audit of the whole app fixed cross-account actions on repeated message ids and about thirty smaller findings.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@bultester](https://github.com/bultester)
- Anonymous
- Anonymous
- Anonymous

**Monthly**

- [@superspacehosting](https://github.com/superspacehosting)
- [@naokton](https://github.com/naokton)
- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Security

- **Mail**: Delete, move and drag in merged views and cross-account search act on the clicked message. When two accounts had messages with the same id, the action could hit the other account's message, which also made sent mail vanish from the Sent folder (#857, GHSA-8x23-qw3w-mhrx, thanks @FeliceBalsamo and @knittingcode)
- **Mail**: HTML attachments preview as sanitised text in a locked frame. The preview used to open the sender's HTML as a same-origin document that could run script in the webmail origin
- **Mail**: A crafted style attribute, read-receipt header, mail body or subject no longer freezes the reader or the message list
- **Mail**: Only an SPF or DKIM pass aligned with the From domain counts as sender verification, and oversized winmail.dat and embedded message parts stay attachments instead of being decoded on open
- **Mail**: Attachment names show without directional override characters, and imported and synced HTML templates are sanitised before the composer previews them
- **Login**: The login page asks before handing a sign-in to the mobile app, and only hands it to the app's own callback link
- **Login**: Failed sign-ins are capped per client at 5 in 15 minutes, and the client address is forwarded to the mail server as X-Forwarded-For so the server's own limits hit the client instead of the webmail. Add the webmail to Stalwart's server.proxy.trusted-networks for that to take effect
- **Login**: Synced settings are keyed on the account a token login resolves to, not on the claimed name, so two users can no longer share a settings blob
- **Admin**: OAuth client secrets and the session secret stay out of the admin audit log, the config API and dashboard writes
- **Admin**: OAuth discovery no longer follows a redirect to another host, the extension directory URL cannot point at a private address, a directory keyring older than the newest one seen is refused, marketplace versions are validated and a silent downgrade on update is refused, and the installer writes its env file readable by its owner only
- **Plugins**: Plugin POSTs stay off the plugin proxy, secrets, agenda, ical and translate routes, only a plugin known to the server can connect and use credentials, plugin-authored HTML drops remote images, and a plugin frame that navigated to another document gets no more host messages
- **Server**: TLS responses carry HSTS and the X-Powered-By header is gone. Upstream mail server requests get a deadline, CalDAV discovery probes and concurrent favicon fetches are bounded, and calendar feeds, synced settings blobs and the settings route have size caps

### Features

- **Settings**: The settings are regrouped into Account, Security, Notifications, General and Appearance, the mail pages Message list, Reading, Composing, Folders & tags, Filters and Out of office, then Calendar, Contacts, Files and Add-ons with the plugin pages under it, and Backup & reset. Every page has a jump row to its sections, settings links can name a section, and old settings links keep working
- **Settings**: An Advanced switch hides power-user settings until turned on. Search results and section links that point at a hidden setting turn it on
- **Settings**: Themes show as one row with a Show all button, and the settings search box looks like the mail search box
- **UI**: The message list can show as columns with one-line conversation rows (#262, thanks @fdisamuel)
- **Composer**: Typing @ offers contacts and adds the picked one as a recipient. Mentions become chips with a contact card on hover, in the composer and in received mail
- **Contacts**: The company directory can be browsed in contacts and the composer (#1253, thanks @diegonix)
- **Mail**: "Remove from this folder" takes a message out of just the open folder when it is in several (#615, thanks @arnauda-gh)
- **Mail**: n jumps to the next unread message (#514, thanks @muelli)
- **Mail**: Shift+arrow keys extend the selection (#992, thanks @IntExCZ), and while selecting, a click anywhere on a row ticks it (#1014, thanks @mmomjian)
- **Mail**: Search results from all folders show the folder (#1172, thanks @PoltoS)
- **Mail**: Your own folders are listed in a separate section of the sidebar (#1205, thanks @roedy-dev)
- **Mail**: The counter can be set per folder, e.g. keep the Drafts count with totals off (#982, thanks @mbjboon-netizen)
- **Mail**: The account dot in the unified view can be hidden (#912, thanks @mmomjian)
- **Mail**: Sender icons are refreshed when they changed on the sender's website (#960, thanks @IntExCZ)
- **Composer**: Message priority can be set in the composer (#970, thanks @douwezijlstra-frl)
- **Composer**: Templates get numeric date, day, month and year placeholders (#1284, thanks @Yahatix)
- **Accounts**: When the admin turns on "Account List Backup: Passwords", saving the account list offers to include the passwords of accounts signed in with a plain password, encrypted in the browser. Restoring signs those accounts in in the background (#1247, thanks @lucamzanon)
- **Admin**: The theme policy can set and lock the colour mode (#1280, thanks @chodid)
- **Admin**: A configured logout URL ends the provider session for providers whose discovery has no end_session_endpoint (#1279, thanks @chodid)
- **Admin**: A policy gate turns archiving off (#1257, #1258, thanks @HOLOEYE-JZ)
- **Admin**: The admin panel asks before leaving with unsaved changes (#1255, thanks @passibe15)
- **Admin**: The version is hidden from the connector probe when the login page hides it (#896, thanks @x86dev)
- **Marketplace**: Any version of an extension can be installed. The detail page lists every version, previews the picked one and warns about withdrawn versions, advisories, deprecations and suspensions, the listing can be sorted and filtered to installed extensions with an updates strip, and an install link can name the version to offer
- **Marketplace**: Replaced plugin and theme versions are kept and can be rolled back to
- **Plugins**: The UI kit gets a Combobox (#1251, thanks @tobiasge)
- **Translations**: Estonian is a new locale, including the company directory and the strings added since (#1254, thanks @raudraido)
- **Demo**: The demo follows one persona with a work account, a personal account and a shared Support mailbox, with real headers, an invitation, mentions, tags, templates and files

### Changes

- **Marketplace**: The marketplace talks to the extension directory's v2 API only. A self-hosted directory older than 2026-10-14 no longer works with it
- **Plugins**: A user credential now exists only for a registry plugin or an admin-approved upload whose manifest declares it. Approvals made before this version need a fresh approval request before the plugin can use credentials
- **UI**: The whole app uses the theme's sans font (#1278, thanks @chodid)
- **UI**: The app switcher uses simpler calendar, contacts and files icons, and the calendar, contacts, files and settings sidebar headers have the mail header's height
- **Performance**: Starting a search no longer re-renders every row

### Fixes

- **Mail**: Push notifications can be enabled for an account with access to a shared folder (#1050, thanks @magnetic6)
- **Mail**: The list shows the mail's own date and keeps it on .eml import (#891, thanks @johnnyq)
- **Mail**: PGP and S/MIME messages inside conversations are decrypted (#902, thanks @rajil)
- **Mail**: Attachments preview in the installed app instead of opening a blank window (#865, thanks @navidrast)
- **Mail**: Message previews drop plain-text emphasis markers (#1260, thanks @mmomjian)
- **Mail**: Today's and yesterday's mail are told apart by the time zone setting in the list and the sender line (#1259, #1262, thanks @mmomjian and @balabommablock-cpu)
- **Mail**: The category tab filter is kept when the mailbox refreshes, and the whole folder comes back after a restart when a category tab was open (#1264, #1265, thanks @alyyousuf7)
- **Mail**: Shared folders from other servers are kept when they reuse an account id, and a shared folder reachable through two logins is listed once in cross views (#1108, thanks @hildebrandttk)
- **Mail**: Renaming a tag follows it into the filter rules that name it, and keeps vacation forwarding and plugin vetoes while doing so (#854, thanks @dev-hive-kazniisa)
- **Mail**: Bulk archive across accounts is routed by the owning account, and Archive is only created where the account allows it (#1178, thanks @VasilisNtovolos)
- **Mail**: Conversation blobs are fetched from the message they belong to, and file previews stay open in development Strict Mode (#1287, #1288, thanks @VasilisNtovolos)
- **Mail**: A shared conversation is marked read on the owner account, and the mark-as-read delay is followed when expanding a conversation or opening a Pro folder row (#1272, thanks @Peterka35)
- **Mail**: The reader's Move, Tag and Rules flyouts open on the side with room (#1261, thanks @beja19)
- **Mail**: Vacation filter rules are skipped on shared accounts without Sieve (#1263, thanks @somus)
- **Mail**: Nextcloud filter markers inside rule text are ignored
- **Composer**: A reply to a message from another connected account is sent from that account to the right recipient (#703, #1270, thanks @jesperordrup and @vixh)
- **Composer**: Replies whose From is picked after the composer opens are signed (#842, thanks @mmomjian)
- **Composer**: A contact group whose member is not an address is no longer sent (#795, thanks @brambuijs)
- **Composer**: Your own address stays out of reply-all before your identities have loaded (#803, thanks @lucletoffe)
- **Composer**: Sent mail keeps blank lines instead of collapsing them (#1015, thanks @mbjboon-netizen)
- **Composer**: Inline images in replies and forwards are attached once (#1125, thanks @guisea)
- **Composer**: The quote containment styles stay in the editor and out of the sent mail, and a quoted original can no longer paint over the composer
- **Composer**: The composer opens when the mail client can't report directory support
- **Composer**: A click on a mention chip opens the contact card instead of the mailto handler in Firefox
- **Calendar**: Zero-length events end at their start instead of midnight (#837, thanks @Flying-Bas)
- **Calendar**: Invitation times show in your time zone (#1252, thanks @TomekCodeWave)
- **Calendar**: Answering an invite sent to a non-primary identity works (#1283, thanks @taranasus)
- **Calendar**: The visible range is refetched after creating a recurring event (#1268, thanks @sanitz)
- **Calendar**: Month view day columns align with the header (#1286, thanks @tobiasge)
- **Tasks**: An all-day task's due and start are sent as a LocalDateTime (#1256, thanks @sanitz)
- **Notifications**: Push notifications stay silent when the notification sound is off (#1289, thanks @chreds)
- **Admin**: The admin panel loads when the config is read-only, policy defaults are applied to user settings, and OAuth auto-setup is refused before touching Stalwart when the config is read-only (#1248, #1249, #1250, thanks @chodid)
- **Accounts**: Restored sign-ins are remembered only when the restoring account is remembered, and contact and calendar data that arrives after switching accounts is dropped instead of landing in the other account
- **Plugins**: api.email.get reads a listed message of a shared account and no longer reads mail of other connected logins (#1273, #1274, thanks @alyyousuf7)
- **Plugins**: A plugin slot's callbacks keep working when its props change while it loads (#1266, thanks @dedoitalia)
- **Plugins**: Plugin dropdown messages are checked before the host draws them
- **Lite**: Demo portraits load from the mount prefix so a bundle under a subpath stays self-contained, and the dev server stays inside its export directory
- **Translations**: German strings that still showed in English (#1285, thanks @dealerweb), contact field types and more French strings

## 1.15.0 (2026-10-15)

1.15.0 opens the plugin system up: plugins can add UI in most places of the app, hear and stop most actions, and use accounts and API keys through the server without seeing them, and users can install their own plugins once an admin has reviewed the code. Opening folders and messages is faster, with far fewer re-renders and requests. Calendars get default reminders, notifications can be muted per folder or account, and every sign-in is now remembered unless the admin shows the Remember me box.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- Anonymous
- Anonymous

**Monthly**

- [@naokton](https://github.com/naokton)
- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Features

- **Notifications**: Folders and whole accounts can be muted from the folder context menu. A muted folder or account sends no push notifications and shows a muted mark in the sidebar (#1169, thanks @xnilsit)
- **Calendar**: Each calendar has default reminders, set in calendar management. New events start on them, an event that switches back to the defaults picks up the current ones, and the event popover lists every reminder (#1209, thanks @rich0)
- **Calendar**: Each reminder can be a notification or an email (#1209, thanks @rich0)
- **Accounts**: Shared mail accounts can be hidden from the sidebar, from their context menu or under Settings > Layout (#1228, thanks @chodid)
- **Mail**: The prompt before deleting several messages can be turned off (#1225, thanks @mmomjian)
- **UI**: In Mountain View, several messages of a conversation can be open at once, the compose window stays open while reading other mail, and the selection is kept while reading a message (#1222, #1229, #1231, thanks @mmomjian)
- **UI**: Ctrl+K opens a command palette, and a notifications panel collects plugin notifications and app errors
- **Admin**: "Custom From Address" under Admin > Policy turns off the free-text sender address in the composer, so users can only send as their identities
- **Admin**: Without a configured SESSION_SECRET, one is generated on first start and kept in data/admin-state. Keep that folder on a persistent volume
- **Plugins**: Users can install their own plugins from Settings > Plugins when the admin allows uploads. The server reads the manifest and code itself, the admin reviews the actual code in the Plugins tab before approving, and the approval is checked again on every start. Settings lists in plain words what each plugin may do
- **Plugins**: Plugins can add UI to the message list, reader, composer, sidebar, top bar, calendar, contacts, tasks, files and settings, and pages of their own with a navigation entry. Every area has its own permission
- **Plugins**: Plugins are told about sign-in, navigation, mail, folder, calendar, contact, task, file, template, identity, filter, preference and theme changes, and can stop most of them
- **Plugins**: Plugins can read messages and folders, move and archive messages, open a filled-in composer or a reply, edit the message being written, save drafts, read and change events and tasks, and manage templates, signatures and the out-of-office reply
- **Plugins**: Users connect accounts for plugins in a dialog the plugin can't read, and plugins use those accounts and admin-set API keys through the server without seeing them
- **Plugins**: The UI kit gives plugins the app's own controls and dialogs, plus side panels, detail rows, colour dots, labelled check boxes and a change preview
- **Plugins**: Marketplace installs check the extension directory's signature

### Changes

- **Login**: The Remember me box is hidden by default and every sign-in is remembered. Set LOGIN_SHOW_REMEMBER_ME=true to show the box again
- **Performance**: Opening a message, switching folders and searching render much less. Message rows, the folder sidebar and the reading pane only redraw what changed, a visited folder reopens without reloading, and a message starts loading when the mouse is pressed on it
- **Performance**: Login loads the mailboxes and first page once instead of twice, the mail view's code loads while the login form is shown, and large HTML messages open with one request instead of two
- **Performance**: Search results show before their highlighted excerpts arrive, and the list stays on screen while a search runs

### Fixes

- **Send**: Attachments stay sendable after the server's upload time limit runs out (#1243, thanks @lemourin)
- **Send**: Uploads over 10 MB that pass through the server, such as office documents saved from the editor, are no longer cut off
- **Login**: The sign-in response stays small enough for proxies when OIDC tokens are large, so logins on a subdomain no longer fail with a 502 (#1237, thanks @kadogams)
- **Login**: Lite reloads into the login page instead of a missing route
- **Mail**: The storage quota counts against the soft limit when the server sets one (#1242, thanks @somus)
- **Mail**: The All mail and All unread views leave out a server's own "all" mailbox (#1241, thanks @somus)
- **Mail**: Contacts, filters, calendars and files are only offered for shared accounts that support them (#1239, thanks @somus)
- **Mail**: User folders named like system folders, such as "Spam reports", get the plain folder icon (#1235, thanks @dlrudie)
- **Mail**: ISO timestamps are no longer offered as verification codes (#1236, thanks @mmomjian)
- **Mail**: Shift-click selects the rows shown between the two ends instead of messages in other conversations from that time span (#1230, thanks @mmomjian)
- **Mail**: The message list no longer reorders or repaints when switching accounts, and the loading skeleton no longer flickers after a reload or account switch
- **Mail**: In Mountain View, a message opens together with its conversation, and threads open as a conversation on the phone (#1223, #1224, thanks @mmomjian)
- **Identities**: A new identity is created without blank signatures (#1240, thanks @somus)
- **Composer**: A cell range pasted from Excel becomes a table instead of an image (#1233, thanks @soringabrielalbu)
- **Composer**: Text typed under the signature stays when the signature is swapped or removed, and picking a From address without a signature removes the old one
- **Composer**: Dropped files no longer insert their path into the message body
- **Composer**: The top and bottom bar buttons are easier to hit on a phone
- **Calendar**: Invitations and replies carry the sender's Message-ID
- **Contacts**: The contact name stays readable when the detail pane is narrow
- **UI**: The iOS app gets its full screen height back after resuming (#1226, thanks @mmomjian)
- **UI**: An attachment's download and menu buttons show when the keyboard reaches them
- **Plugins**: A message is never sent when a plugin that checks it before sending fails or does not answer, and plugins can no longer block or stall sign-out
- **Plugins**: Privileged plugins need a signed bundle, plugin network access is limited to the origins in the manifest, plugin bundles are only served to signed-in users, and slot plugins only get messages, events or contacts with the matching read permission
- **Plugins**: Plugin and theme packages are checked the same way on every install path, marketplace bundles whose id differs from the directory entry are refused, and Theme API v2 themes install from the admin page and the marketplace
- **Plugins**: A deleted or disabled theme is no longer forced, an extension keeps its admin state on re-upload, and a plugin's stored data is cleared when the admin removes it
- **Plugins**: Plugins start once on every page, get their default settings, follow setting and language changes without a reload, and lay out right-to-left in Arabic, Hebrew and Persian
- **Plugins**: Actions a plugin stopped are no longer reported as done
- **Plugins**: Plugin buttons and panels fold away in narrow composers, toolbars and phone layouts instead of overlapping, and plugin frames keep the app's theme in dark mode
- **Translations**: The new plugin, calendar reminder and notification strings are translated, and "composer" and the certificate subject are no longer translated as a music composer and an email subject

## 1.14.2 (2026-10-12)

1.14.2 brings Mountain View closer to Gmail: the open message shows the whole conversation, replies are written in place under it, and a side panel holds calendar, tasks and contacts. Tasks can now be moved into calendars shared with you, and the "Date sent" list order works again.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- Anonymous
- Anonymous

**Monthly**

- [@naokton](https://github.com/naokton)
- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Features

- **UI**: In Mountain View, the open message shows the whole conversation around it, and replies are written in place under the conversation instead of in a separate window
- **UI**: Mountain View has Gmail's side panel with calendar, tasks and contacts, and its advanced search form
- **UI**: Mountain View's message menu has Find emails from, and the Move to menu in the bulk actions can be searched

### Changes

- **UI**: Mountain View looks more like Gmail: the content sits on a rounded card over a tinted canvas, the navigation has a Labels section, and the message rows, open message toolbar, compose window, account card, message menu and bulk actions follow Gmail's layout and order. The keyboard shortcuts sit behind a help button in the top bar

### Fixes

- **Mail**: The "Date sent" list order sorts by date sent again instead of falling back to date received (#1219, thanks @Area128)
- **Mail**: In Mountain View, the dark backdrop behind a message body spans its full width
- **Tasks**: Tasks in calendars shared with you show up, and tasks can be created in, moved into, edited and deleted in those calendars (#1204, thanks @mmomjian)
- **UI**: Mountain View's panes no longer slide when animations are turned off (#1215, thanks @mmomjian)

## 1.14.1 (2026-10-11)

1.14.1 fixes plain-text and unstyled messages showing on a gray background in dark mode after the 1.14.0 dark mode rewrite.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- Anonymous
- Anonymous

**Monthly**

- [@naokton](https://github.com/naokton)
- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Fixes

- **Mail**: In dark mode, plain-text and unstyled messages use the app's background again instead of a gray box

## 1.14.0 (2026-10-11)

1.14.0 adds Mountain View, an optional layout with a top bar and a wide search field, and gives the Files app and the calendar a new layout. Dark mode now recolours messages instead of inverting them, so brand colours stay as sent. Push can be turned on for several accounts at once, and the account list can be backed up encrypted and restored on another device. The composer got a long round of send fixes. With several accounts open, batch actions no longer hit another account's message that happens to share an id with the selected one.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- Anonymous
- Anonymous

**Monthly**

- [@naokton](https://github.com/naokton)
- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Features

- **UI**: Mountain View is an optional layout, chosen under Settings > Layout > Interface layout. On desktop it has a top bar with a wide search field, an apps grid and the account avatar in place of the left rail, a Compose pill, a docked compose window, an account popover with unread counts per account, and j/k, x and g shortcuts. Calendar, Contacts, Files and Settings use the same top bar. The default layout is unchanged (#1168, thanks @lucamzanon)
- **Files**: The Files app is laid out like Contacts and Calendar: a sidebar with a New menu, the folder tree, Starred, Recent and Shared with me, a header with breadcrumbs, search, sort and a list/grid switch, a details panel, right-click menus in the sidebar and arrow-key navigation. On touch, a tap opens and a long press selects. Folders in the tree can be renamed and deleted, recent files open in their folder, and the view, sort and hidden-files settings now apply
- **Files**: Image previews in Files and in attachments zoom with the wheel or a pinch, pan by dragging or with the arrow keys, switch between fit and full size on double-click, and close on a click beside the image
- **Files**: Uploads show as a toast with their progress and a Cancel button. The large file warning is gone
- **Calendar**: On wide screens, clicking or dragging over empty time opens a quick editor next to the slot, and clicking an event opens a card with edit, delete and more actions. Busy month cells show "+N more", the agenda lists each day as a row with the date beside its events, and the dates in the week header open that day. Calendar lists in the sidebar fold away and show their options on hover. Phones keep the full editor
- **Push**: The notification settings list every connected account and turn push on or off for several of them at once, with a single browser permission prompt (#1054, thanks @lucamzanon)
- **Accounts**: Users with several accounts can save their account list on the webmail server, encrypted in the browser with a password they choose, and restore it on another device. No mailbox passwords are stored. Admins turn it on with "Account List Backup" under Admin > Policy (#1201, thanks @lucamzanon)
- **Filters**: The folder context menu runs a saved rule on the messages already in that folder (#1166)
- **Composer**: Schedule send offers tomorrow at 8:00, tomorrow at 13:00 and next Monday at 8:00 as one-click times
- **Settings**: The language picker has a search field and flags, and every date format and region option shows a live sample
- **Plugins**: A plugin can run a message-list search with a JMAP Email filter (#1024)
- **Plugins**: Calendar event actions get the event's uid and attendees, and the form-save hook now fires and can change the meeting link that is saved with the event (#1202, thanks @siennathesane)

### Changes

- **Mail**: Dark mode recolours messages instead of inverting them. Light backgrounds are darkened in their own hue, brand colours and dark fills stay as sent, and text only changes when it lacks contrast. A message's own dark mode styles follow the app theme instead of the system's
- **Mail**: A folder opened before shows its messages at once and refreshes them in the background. A failed load leaves them on screen (#1195, thanks @lucamzanon)
- **Composer**: On a phone, the formatting toolbar folds away behind a Formatting button and its buttons are larger. The send options sit together in one menu
- **Files**: File sizes are rounded the way people read them, like 67 KB or 2.1 MB

### Fixes

- **Mail**: In views that merge several accounts, selecting a message no longer also selects a message with the same id in another account. Batch delete, move, archive, copy, mark read, tag and spam act only on the ticked messages, each through its own account. Before, a permanent delete could remove the other account's message (#1061, thanks @lucamzanon)
- **Mail**: A message with two spaces in a row in its subject no longer freezes the tab (#1193, thanks @dealerweb)
- **Mail**: Blocking remote content no longer drops a message's style sheets, so messages keep their layout before images are loaded
- **Mail**: The list shows no paperclip on a message that only has inline images
- **Mail**: The "via" badge is hidden when it repeats the sender's name, and a draft shows one Edit button
- **Send**: Signed and encrypted messages reach Bcc recipients (#1206)
- **Send**: After a plugin send, such as S/MIME, the composer closes, and a failed plugin send keeps the draft (#1207)
- **Send**: A failed send removes its unsent copy from Drafts and explains the failure in plain words. A send while offline says so and keeps the message
- **Send**: Typed addresses are split on commas, and a message with an invalid address is not sent. The address field marks which ones to fix
- **Send**: Undo send disappears once the delay is over and says so when an undo fails
- **Send**: Discard deletes the draft, also one reopened from Scheduled, and closing an autosaved draft no longer asks about unsaved changes
- **Send**: The missing subject warning comes once per message, and the scheduled time shows its date, rounded to the minute
- **Composer**: Tabbing into a reply or forward keeps the quoted message, and tabbing into a new message starts at the top of the body
- **Composer**: A reply opens with the caret in the body, and the composer is titled Reply, Reply All or Forward instead of New Message
- **Composer**: A reopened draft takes its text from the message body only. An attached .csv or .txt no longer turns up as the message text (#1213, thanks @shukiv)
- **Composer**: A long attachment list scrolls instead of pushing the Send button out of view (#1212, thanks @shukiv)
- **Composer**: The plain-text part of sent mail marks quotes and list items, and the signature has one separator
- **Composer**: Enter adds the highlighted suggestion instead of the typed text, and the suggestions close once the address is added and line up with the typed text. On a phone they span the whole row and show the name above the address
- **Composer**: Body text no longer shows through the pinned formatting toolbar (#1200, thanks @lucamzanon)
- **Composer**: On a phone, sending a new message returns to the message list, and the Continue draft banner no longer flashes after a send
- **Composer**: Bitwarden no longer offers logins in the recipient fields, the mail search box or the event participant field
- **Login**: A remembered sign-in survives a server timeout or an origin switch during restore instead of signing out (#1167)
- **Login**: Signing out of one account keeps the other accounts, and a reload with only accounts awaiting sign-in shows the login page instead of a connection error (#1201, thanks @lucamzanon)
- **Login**: A reload without "Remember me" no longer reports an expired session
- **Unified**: Switching to another account keeps the unified mailbox on (#1144, thanks @lucamzanon)
- **Push**: Push is renewed for every connected account, not only the active one, so accounts no longer stop notifying after seven days. The all-accounts panel shows each account's real state and why an account failed (#1054, thanks @lucamzanon)
- **Filters**: Forward is hidden in filter rules when the server allows no redirects (#1208)
- **Calendar**: Save is blocked while a plugin's form-save hook runs, so a double press no longer creates the event twice (#1202, thanks @siennathesane)
- **Calendar**: Participant suggestions are no longer cut off by the event form
- **Files**: Canceling an upload stops the file in flight and says the upload was canceled instead of counting every file as done
- **Files**: A drag selection keeps its items after letting go, and Files shows a loading state instead of "No files yet" before the first listing
- **Files**: Read-only documents open in ONLYOFFICE without the -103 warning (#1187)
- **Contacts**: The contact popover shows the sender's name when the saved contact has none, and Contacts shows placeholders instead of "No contacts yet" while loading
- **UI**: The close and back buttons in the composer and conversation view have names for screen readers, and the composer toolbar buttons are labelled
- **UI**: Reply All stays on one line in the conversation view, and the welcome banner gives touch tips on a phone
- **Translations**: The new composer, send, Files and filter strings are translated

## 1.13.0 (2026-10-07)

1.13.0 turns the vacation settings into an Out of Office page that can also forward mail, lets filter rules run only for a date range, and copies messages into another connected account. Files from the Files app can be attached in the composer, tags can be set on many messages at once and folders moved in bulk. Messages whose sender can't be verified now carry a warning. It also stops one account's settings and templates from carrying over to the next account signed in on the same browser.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- Anonymous
- Anonymous

**Monthly**

- [@naokton](https://github.com/naokton)
- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Security

- **Settings**: Signing out and then signing in with another account in the same browser no longer shows the previous account's settings, tags and templates, and no longer saves them to the new account's synced settings (#1185)

### Features

- **Mail**: A message whose sender fails the From domain's checks, or that passes neither SPF nor DKIM, shows a warning above the message and a badge next to the sender. "Always trust this sender" is not offered for it
- **Mail**: "Copy to account..." in the message menu files a copy in a folder of another connected account and leaves the original where it is. Copies keep their original date (#1150, thanks @lucamzanon)
- **Mail**: The selection toolbar and the right-click menu put a tag on, or take it off, every selected message at once (#1077)
- **Out of office**: The vacation settings are now an Out of Office page: the period on top, then the automatic reply and forwarding, each with its own switch. Forwarding works with or without the reply, never forwards spam and can keep a copy in the inbox. The reply can go to all senders, internal senders only or external senders only (#1152, thanks @dealerweb)
- **Filters**: A rule can be limited to a period, and the rule list shows whether it is scheduled, active or expired (#1152, thanks @dealerweb)
- **Filters**: The new "All messages" condition matches every message (#1154, thanks @dealerweb)
- **Composer**: "Attach from Files" attaches files from the Files app, including files shared with you, without downloading and uploading them again (#1179)
- **Composer**: Typing @ in the message body offers the To and Cc recipients and inserts the chosen one's first name. Bcc recipients are never offered. "Mention recipients with @" in the composer settings turns it off (#1134, thanks @dealerweb)
- **Folders**: The folder settings can select several folders, with Shift+click for a range, and move them together under another folder or to the top level (#1173)
- **Calendar**: The day and week views can be limited to working hours, and the week view can leave out non-working days. Events outside the visible hours are counted at the top and bottom of each day and open from there, and a button in the view shows all hours (#1164)
- **Login**: `LOGIN_SHOW_TOKEN_LOGIN=true` offers "Sign in with an access token", for JMAP servers that take API tokens instead of passwords, such as Fastmail
- **Login**: A server in `JMAP_SERVERS` whose `oauth` block has both a `clientId` and a `buttonLabel` gets its own sign-in button on the login page, even while OAuth is off globally. This allows a "Sign in with Google" button for a Gmail bridge next to servers that use passwords (#1135, thanks @lucamzanon)
- **UI**: The browser tab title names the active account, as in "Inbox - alice@example.com - Webmail", and Settings, Calendar, Contacts and Files set their own title. Turning off "Subject in Tab Title" under Admin > Policy keeps message subjects out of the title, and with it out of the browser history (#1186, thanks @oguzyilmaznet)
- **Unified**: While logins reconnect after a page load, the "All accounts" header shows how many are already counted, such as "4/10" (#1140, thanks @lucamzanon)
- **Push**: A message that reaches several of your accounts rings once. For 30 seconds after an alert, notifications from your other accounts arrive silently (#1141, thanks @lucamzanon)
- **Server**: `SOURCE_CODE_URL` points the source code link in Settings > About at the code of a modified build, as AGPL section 13 asks of anyone running one (#1161)

### Changes

- **Calendar**: The day and week views show 08:00 to 20:00 by default. "Limit visible hours" in the calendar settings changes the range or turns it off (#1164)
- **Tags**: Tag views and their counts leave out messages in Trash and Spam (#1156)
- **Mail**: In a shared mailbox, the Move menus list that mailbox's folders first and your own folders after them, under your account name (#1149)
- **Dependencies**: sharp 0.35.5 and source-map-js 1.2.2 (npm audit)
- **Docs**: CONTRIBUTING.md explains what belongs in core and what in a plugin, and which changes need an agreed issue before a pull request

### Fixes

- **Mail**: Attachments, inline images and .eml downloads of messages in shared folders are fetched from the account that owns them. On Cyrus they failed with "failed to find blob by id" (#1188, thanks @VasilisNtovolos)
- **Mail**: Archive creates an Archive folder when the account has none, instead of only reporting that it is missing (#1176, thanks @cybersmurf)
- **Mail**: Opening the webmail starts in the inbox instead of a folder from an earlier visit, such as Trash
- **Mail**: Opening another folder, tag, account or search starts the message list at the top instead of where the last one was scrolled to (#1138, thanks @dealerweb)
- **Mail**: Previews no longer start with a style sheet ("@media screen and ...") in the message list and in push notifications (#1136, thanks @lucamzanon)
- **Search**: Searching from the unified All mail view finds sent mail too
- **Send**: A draft saved without a subject reopens with an empty subject, so Send warns about it again instead of sending "(No Subject)" (#1189)
- **Send**: When the server does not confirm that a message was sent, the draft is kept and the composer asks you to check Sent before sending again (#1019, thanks @lucamzanon)
- **Send**: A message the server refuses shows the server's reason instead of "Invalid reference to non-existing object"
- **Send**: A forward sent from another account's address no longer fails with `blobNotFound`. Its attachments and inline images are copied to the sending account first (#1142, thanks @lucamzanon)
- **Push**: Push turns itself back on when the browser lost its subscription, retrying at most every 15 minutes (#1147, thanks @lucamzanon)
- **Push**: The notification settings check push again when you come back to the tab, so push turned off in the browser or another tab no longer shows as on (#1148, thanks @lucamzanon)
- **Push**: When the new message cannot be read, the notification no longer announces another unread message from the Inbox in its place, and a failed lookup shows a generic notification instead of none (#1041, thanks @lucamzanon)
- **Filters**: "Stop processing further rules" also stops after "Delete silently" and "Reject", so later rules no longer file the message. Rules whose name contains double spaces, a tab or a trailing space no longer gain a copy on every save, and the copies earlier saves left are removed (#1153, thanks @dealerweb)
- **Filters**: The forwarding limit counts the forwards one message can collect, instead of adding up every enabled rule, and warns when the rule order lets one message go over it (#1155, thanks @dealerweb)
- **Filters**: A condition with several values wraps inside its card in the expanded rule view (#1139, thanks @dealerweb)
- **Filters**: An open rule dialog or Sieve editor, and what was typed in it, survives a filter change from another tab or device (#1162, thanks @dealerweb)
- **Templates**: A tab or device that had not reloaded no longer deletes templates created elsewhere when it saves its settings
- **Calendar**: Duplicating an event keeps its meeting link (#1170)
- **Calendar**: The Calendar Agenda plugin shows events from shared and group calendars (#1175, thanks @cybersmurf)
- **Files**: Folders shared with you can be opened, and your own folders shared, in both folder layouts (#1181)
- **Files**: Office editing works behind a reverse proxy where the editor and the browser reach the webmail at different addresses. The WOPI client URL may be an internal address (#1130)
- **Login**: When Stalwart accepts a password and TOTP code but refuses to issue tokens, the login page points at the OAuth client settings instead of opening the browser's own sign-in dialog and reporting a wrong code
- **Branding**: With `APP_NAME` set, the authenticator app entry for two-factor sign-in, the About card and the Files preview use the configured name and logo (#1177, thanks @cybersmurf)
- **UI**: Text fields in dialogs keep the focus when the page behind updates, which happened every 30 seconds and on new mail (#1162, thanks @dealerweb)
- **UI**: Buttons, menu items, tabs and other controls show the pointer cursor again (#1184, thanks @gwku)
- **UI**: The account group labels in the From dropdown are readable in dark themes (#1157, thanks @dealerweb)
- **Translations**: Czech is fully translated (#1174, thanks @cybersmurf), and missing placeholders are restored in Persian, Hebrew, Hungarian, Mongolian and Slovak (#1165, thanks @owgreen-dev)

## 1.12.0 (2026-09-30)

1.12.0 lets you create filter rules straight from a message, offers the code from sign-in mail for one-click copying, and gives a phone linked with "Link Mobile App" a sign-in of its own, for every kind of account. Search now leaves Spam and Trash out by default, and emptying an ordinary folder moves its mail to the Trash. Browsers with many logins start up much faster. It also contains three security fixes, so please update.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous

**Monthly**

- [@yerTools](https://github.com/yerTools)
- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Security

- **Auth**: The password+TOTP login no longer sends the webmail's OAuth client secret to a mail server the user chose when custom JMAP endpoints are allowed. Only admin-configured servers get it
- **Auth**: The identity provider round trip for "Link Mobile App" can no longer sign the browser in as whichever account answered it, and a re-authentication the provider answered from an existing session instead of a fresh login is refused
- **Mail**: Opening a previewed SVG attachment in a new tab no longer runs the sender's script in the webmail origin

### Features

- **Mail**: A "Rules" entry in the message right-click menu creates filter rules from the message: always move mail from its sender, domain or mailing list, mark it read, tag it, or block the sender. A new rule can also run on the messages already in the folder, and it can be undone from the toast
- **Filters**: The rule editor suggests conditions from the message it was opened from (subject, recipients, List-Id, sender domain), and the new "is the address" and "has the domain" conditions match an address exactly
- **Mail**: Codes from sign-in and confirmation mail show as a copy chip in the message, and in the list for a day. "Show Verification Codes" in settings turns it off
- **Mail**: In the unified view, rows can be tinted with their account's color instead of showing the account dot, and tags this browser has no definition for, such as ones set by a server-side filter, get a color of their own instead of grey (#1052, thanks @lucamzanon)
- **Search**: The folder dropdown shows subfolders indented under their parents
- **Composer**: Pasted plain-text lines that start with "- ", "* ", "• ", "1. " or "1) " become real lists
- **Calendar**: The event popover finds the join link of Teams, Zoom, Meet, Webex, Jitsi, Whereby and GoTo meetings in the location or description, and the location opens in maps, with a copy button next to it (#1095, thanks @lucletoffe)
- **Server**: `LIBRETRANSLATE_API_KEY_FILE`, `BULWARK_JWT_AUTH_SECRET_FILE`, `BULWARK_STALWART_MASTER_USER_FILE` and `BULWARK_STALWART_MASTER_PASSWORD_FILE` read these secrets from files, and the admin config accepts `oauthClientSecretFile` and `sessionSecretFile` (#897, thanks @Cameo007)
- **Plugins**: `PLUGIN_SIGNING_KEY_FILE` points at an existing Ed25519 key for signing managed plugin bundles, for read-only secret mounts (#996, thanks @mulatta)
- **Releases**: Container images and release files come with a signed build provenance attestation, and the standalone tarballs get a `.sha256`. The README explains how to check them with `gh attestation verify`

### Changes

- **Search**: Search leaves out Spam and Trash unless "All folders" is picked in the folder dropdown. A search started in Spam or Trash searches that folder
- **Mail**: Emptying a folder other than Trash or Junk moves its mail to the Trash, unless deleted mail is set to be removed permanently
- **Mobile app**: "Link Mobile App" is offered for every account. Password and password+TOTP accounts confirm their password (and code) in the dialog. The phone gets a sign-in of its own, so signing out in the browser no longer signs it out, and a sign-in link to copy sits next to the QR code. Failed password attempts are limited per account
- **Calendar**: Events are drawn as solid blocks of their calendar's color; declined and cancelled events are outlined
- **UI**: Success and info toasts are plain cards; only errors and warnings are colored
- **Performance**: With many logins, the browser restores them four at a time and no longer reloads every login's folders, identities and push connections each time one of them connects (#1132, thanks @lucamzanon)
- **License**: An additional permission under section 7 of the AGPL allows distributing apps built from this code through app stores. It is provisional until every earlier contributor has agreed ([consent request](https://github.com/orgs/bulwarkmail/discussions/1113)) and applies in full to contributions made since 30 September 2026
- **Docs**: Guidelines for AI-assisted contributions in the README and CONTRIBUTING.md

### Fixes

- **Mail**: Clicking a folder's unread count lists only that folder's unread mail, not unread mail from every folder of every account
- **Mail**: In "unread first" lists, a message you open stays in place until you open another
- **Mail**: The message list no longer flashes a reload right after the page opens
- **Mail**: On tablets, the message list comes back when the reading pane empties, for example after the open message is deleted or moved
- **Mail**: Dividers between rows no longer disappear at 125% or 150% display scaling
- **Mail**: The unread dot is centred on the sender avatar
- **Mail**: Attachments declared with a type the browser cannot show, such as `application/x-as400attachment` from IBM i systems, `application/x-pdf` or a catch-all type, preview according to their file name (#1127, thanks @dealerweb)
- **Send**: Recipients the server refuses at send are reported. When it refuses all of them, the message stays open as not sent; otherwise a warning names the refused ones (#1123)
- **Composer**: The message body stays reachable in short reading panes, such as the bottom reading pane on a laptop (#1114)
- **Composer**: Pasted plain text keeps its blank lines
- **Push**: A notification link waits for a login that is still reconnecting instead of reporting the account as signed out, opens the folder of the right account, and no longer pulls you away from something you opened in the meantime (#1131, thanks @lucamzanon)
- **Push**: A browser subscribed with another VAPID key resubscribes on its own, and Firefox can turn push on again when it cannot read its old subscription (#1121, thanks @shukiv)
- **Calendar**: Dragged events no longer disappear: all-day events moved in the month view keep their start, and occurrences of recurring events with a UTC start, as in Google Calendar exports, no longer shift by the time-zone offset (#1119)
- **Calendar**: A failed calendar fetch no longer hides every calendar or leaves only the birthday calendar selected
- **Calendar**: The all-day area of the week view is sized from the visible week, stacks each day's tasks under its all-day events, and collapses to three rows with a toggle (#1122, thanks @sanitz)
- **Calendar**: The Save button shows while an event is saving, and a save refused for its length says so (#921, thanks @texchi2)
- **Calendar**: Invitations no longer carry blank participant names or an empty description (#748, thanks @lucletoffe)
- **Files**: Files shared with you open and save in the office editor (#1094)
- **Files**: Office editing works behind a reverse proxy at a sub-path (`NEXT_PUBLIC_BASE_PATH`) (#1101, thanks @dealerweb)
- **Accounts**: Adding a sixth account through server-side SSO no longer overwrites the first account's sign-in
- **Mobile app**: The app's "Sign in via webmail" keeps working past the first token expiry when the webmail uses a confidential OAuth client or an identity provider on another host
- **Admin**: Admin sign-in works over plain HTTP. The admin cookie's Secure flag follows the request, or `COOKIE_SECURE` when it is set (#1063, thanks @lucamzanon)
- **Admin**: The OAuth scope fields show the actual default scopes, which do not include `offline_access` (#1126)
- **Lite**: SSO sessions survive a page reload with identity providers such as Rauthy that refuse an early token refresh (#552)
- **UI**: The app retries loading its configuration after a timeout or a failed request instead of staying broken (#1112, thanks @theLucius7)
- **Docker**: The image builds from a remote Git context (#1118)

## 1.11.2 (2026-09-26)

1.11.2 fixes the Docker image and the standalone tarballs of 1.11.1, which did not start. It contains all the security fixes from 1.11.1, so please update.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- [@windsource](https://github.com/windsource)

**Monthly**

- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Fixes

- **Docker**: The server starts again. 1.11.1 excluded `data/` from the standalone build with a pattern that also dropped Next.js's own metadata modules, so the Docker image and the `bulwark-standalone-*` tarballs failed on startup. `npm start` and Bulwark Lite were not affected

## 1.11.1 (2026-09-26)

1.11.1 is a security and bug-fix release. It fixes four reported vulnerabilities, two of them critical, and the findings of a security audit. Please update.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- [@windsource](https://github.com/windsource)

**Monthly**

- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Security

- **Admin**: Only a Stalwart superuser gets into the admin dashboard. The admin probe accepted Stalwart's default tenant-admin role, so the administrator of a single tenant was signed into a dashboard that configures the whole instance (GHSA-v6hr-cmxm-pv73, thanks @douwezijlstra-frl)
- **Admin**: Admin status is only taken from an admin-configured server. A context cookie minted while custom JMAP endpoints were allowed let a user-chosen server keep answering the admin probe after the switch was turned off (GHSA-j867-89p4-v8hm, thanks @Vip3r-MC)
- **API**: Cross-origin writes are refused on the JMAP passthrough and every other cookie-authenticated `/api/` route, not only `/api/auth/*`. A page on a same-site sibling origin could run arbitrary JMAP as the signed-in user. The gate also decides on the decoded path, so `/api/%61uth/...` no longer skips it (GHSA-9mvj-98f5-9q6g, thanks @kah-ja)
- **Admin**: Admin sign-in attempts are also capped at 50 per 15 minutes across all clients, because a forged `X-Forwarded-For` got a fresh per-IP budget when no reverse proxy is in front (GHSA-7pj2-232x-6698, thanks @richardweinberger)
- **Admin**: Impersonation no longer puts the Stalwart master password into the session cookie. The webmail creates an app password on the target mailbox that expires after 8 hours and is revoked on sign-out, and a used impersonation link is refused after a restart or on another replica
- **Mail**: A sender can no longer fake a DMARC or DKIM pass in the security badges, with a crafted envelope address or an `Authentication-Results` header of their own
- **Mail**: Opening an SVG attachment's thumbnail on its own no longer runs the sender's script in the webmail origin
- **Mail**: Remote content stays blocked in the mobile conversation view, the `.eml` attachment preview, the quoted original of a reply or forward, the print view, and for URL spellings the filter missed (backslashes, CSS escapes, `image-set()`)
- **Mail**: Links in image maps (`<area>`) no longer keep `window.opener`
- **Mail**: A `mailto:` unsubscribe goes to the single address in the link, and the confirmation shows recipient, subject and body before sending
- **Mail**: A crafted `winmail.dat` no longer freezes the tab
- **Composer**: A sender name containing a quote can no longer add a recipient to a draft
- **Filters**: Rule names, header names and sizes are escaped, so rules from plugins or imported filter sets cannot add commands such as `redirect` to the Sieve script
- **Plugins**: Hooks and slots need a declared permission, like the host API does. `http.post` can no longer reach the JMAP passthrough, `/api/admin/*`, `/api/settings` or other credentialed routes, and plugin storage is kept per account and deleted on sign-out
- **Themes**: The theme CSS sanitizer no longer lets remote resources through (`url(//host)`, CSS escapes, `image-set()`, `@font-face` sources), and theme CSS can only target `:root` and `.dark`, also when a plugin transforms it
- **Files**: WOPI file downloads are always served as inert attachments, so a blob typed `text/html` cannot run script in the webmail origin
- **Server**: The SSRF guard also blocks loopback beyond `127.0.0.1`, CGNAT, benchmark, multicast and reserved ranges, and NAT64, 6to4 and Teredo addresses that wrap an internal IPv4 address. Telemetry targets are checked at connect time, and OAuth token and revocation requests never follow redirects
- **Auth**: Synced settings are keyed on the account a bearer token belongs to, so on a multi-domain server `john@b.example` can no longer read the settings of `john@a.example`
- **Auth**: Wrong passwords tried through the login pre-check are limited, so the route can no longer be used as a password oracle or trip Stalwart's ban against the webmail itself
- **Auth**: Signing out ends office editor sessions opened in that browser, and a full sign-out clears search history, open tabs, Files recents, staged plugin uploads and the other accounts' leftovers, also in other open tabs
- **Auth**: Signing out when another account's restore had failed no longer leaves that account resumable
- **Auth**: The failed TOTP login no longer passes on a user-chosen server's error body
- **Server**: Visitors who are not signed in no longer get detailed health data, the pending advisory text, the plugin list, the full admin policy or every server's domain list
- **Server**: The setup token is passed in the URL fragment, so it stays out of access logs, referers and history
- **Server**: Not-found pages outside the app tree cannot be framed, `ALLOWED_FRAME_ANCESTORS` never applies to the admin dashboard or setup, and sibling subdomains can no longer widen the sidebar-app `frame-src`
- **Server**: Favicons are only served as raster images
- **Docker**: Runtime state and secrets (`data/`, `local-data/`, `.env`) stay out of the standalone build and the image, and the mock JMAP server can no longer be switched on in a release build
- **Lite**: Sign-out revokes the refresh token, and a failed token login no longer keeps the password in `sessionStorage`
- **Lite**: Every static page gets a CSP that allows only its own inline scripts, the Stalwart bundle refuses to run inside a foreign frame, and the Stalwart install instructions use a tagged release with a published `.sha256` instead of `releases/latest`

### Features

- **Calendar**: Tasks with a due date show in the month view (#1107)

### Changes

- **Plugins**: Hooks that change outgoing mail need `email:send`, and display takeovers need `email:render-takeover`. Plugins that don't declare them lose those hooks
- **Themes**: Theme CSS keeps only `:root` and `.dark` rules plus `@font-face`, `@keyframes`, `@media` and `@supports`. Every `url()` except a `#fragment` is removed
- **Admin**: Impersonated sessions end after 8 hours, and sessions minted by earlier versions are signed out
- **Server**: `/api/health?detailed=true` needs a session

### Fixes

- **Mail**: The inbox keeps rendering when a message has an unparsable date (#1099)
- **Mail**: A folder no longer switches back to the unified inbox while it loads (#1102, thanks @guisea)
- **Mail**: Replies in the unified inbox come from the identity of the account that received the mail (#1104)
- **Mail**: Mail deleted during a list refresh no longer reappears (#966)
- **Mail**: The message list no longer jumps while attachment chips load
- **Mail**: Scrolling the unified inbox, cross-account views, tag views and "All folders" search no longer skips messages
- **Mail**: A failed message-list read keeps the list on screen instead of showing an empty folder
- **Mail**: Marking read, starring, tagging, emptying a folder and cancelling a scheduled send report it when the server refuses them
- **Mail**: Tagging and pinning write only the keywords that change, so they no longer mark mail unread that was read on another device
- **Mail**: New mail and folder changes keep arriving for users with seven or more shared accounts
- **Send**: A dropped connection can no longer send a message twice
- **Send**: Undo and edit of a message sent from a group identity act in the group's own account
- **Composer**: A reply draft stays in its thread when it is re-opened or undone
- **Composer**: An open draft stays on its own account across an account switch
- **Accounts**: Quick account switches no longer mix up identities, so replies go out with the right From address
- **Accounts**: Folders, filters and the account security page no longer show the previous account's data after a switch
- **Accounts**: Settings sync turns back on after signing out of one of several accounts
- **Push**: A notification opens its message in the account it came from
- **Calendar**: Events you declined show struck through (#1110)
- **Calendar**: Daily recurring events keep going past a DST gap
- **Calendar**: iCal subscriptions stay with the login that created them, so refreshing or removing one no longer touches a calendar of another login
- **Auth**: SSO sign-in behind nginx no longer fails with a 502 when the cookies would overflow its header buffer (#1096)
- **Auth**: Sign-in and addresses work on internationalized domains (#1100)
- **Lite**: A rate-limited token endpoint no longer signs you out
- **i18n**: The dark/light mode titles and the "Themes" settings tab are translated in every language (#1105, #1106, thanks @dulinux), and so is the themes settings panel
- **i18n**: Updated Portuguese (Brazil) translation (#1106, thanks @dulinux)

## 1.11.0 (2026-09-23)

1.11.0 introduces **Bulwark Lite**, a static build of the webmail that runs without a Node server, and fixes many places where Bulwark and Stalwart disagreed about mail, filters, calendars, contacts and files. It contains everything from the three 1.11.0 betas. The `latest` Docker tag moves to this release.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@windsource](https://github.com/windsource)

**Monthly**

- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Features

- **Lite**: Bulwark Lite, a static build that talks to the JMAP server straight from the browser. `npm run build:lite` builds it, and every release ships `bulwark-lite-<version>.zip` for any static web host
- **Lite**: `bulwark-lite-stalwart.zip`, a Stalwart Application bundle that picks up its mount prefix at runtime, with OpenID Connect login
- **Lite**: Container image `ghcr.io/bulwarkmail/webmail-lite` (#1081)
- **Themes**: "Flat fields" theme
- **Calendar**: Attendees can answer a single occurrence of a recurring event (#1086)
- **Mail**: Office attachments open read-only in the document editor, straight from the message, when a WOPI editor is configured (#1047)
- **Push**: Optional inbox-only push notifications (#983, thanks @guisea)
- **Mail**: Toasts for mail actions that gave no feedback, and an "email sent" toast after immediate sends
- **Filters**: "Keep a copy" option for forward actions
- **Filters**: Per-rule "Also move messages marked as spam" option
- **Admin**: Login page toggles in admin settings for the version, the 2FA code option, the heading and the subtitle (#1068)
- **Navigation**: Deep links resolve to the local instance

### Changes

- **Auth**: Signing out of an SSO account also signs out of the identity provider when it advertises an `end_session_endpoint` (#905). Set `OAUTH_END_SESSION=false` to keep the provider session, for example when other apps share it, and `OAUTH_POST_LOGOUT_REDIRECT_URI` to send users back to the webmail afterwards
- **Filters**: Move and copy rules leave mail that Stalwart marked as spam in Junk. Before, a rule such as "subject contains invoice" also collected phishing. "Keep" rules stay unguarded as the allow-list
- **Mail**: Search sends terms exactly as typed, without adding a prefix wildcard, in tag views too
- **Mail**: The message list loads attachment chips lazily, so large folders open faster (#1089)
- **Send**: Scheduled send is limited to 7 days, the most Stalwart accepts
- **UI**: Icon set migrated from Lucide to Tabler Icons
- **Docker**: Pre-releases no longer move the `latest` tags
- **Docs**: Most README details moved to the website docs, with new screenshots

### Fixes

- **Mail**: "All folders" search includes shared accounts (#1082)
- **Mail**: A search inside a tag view narrows the tag instead of replacing it (#1084, thanks @rotterp)
- **Mail**: Leaving an account drops a search folder scope that belongs to it (#1084, thanks @rotterp)
- **Mail**: A failed search shows an error instead of "No results found"
- **Mail**: In unified views, threads belong to the account that owns them (#1012, thanks @lucamzanon)
- **Mail**: A failed move between accounts no longer deletes the original
- **Mail**: "Mark all as read" marks every unread message instead of skipping pages past the first 500
- **Mail**: Mark as spam and not spam report moves the server refuses
- **Mail**: Unread-first order keeps bringing up unread mail past the first page
- **Mail**: The tag button in a row's hover actions opens the tag picker instead of clearing the message's tags (#1032, thanks @douwezijlstra-frl)
- **Mail**: Tag and tab counters no longer download every matching id
- **Mail**: Text in fixed-width tables wraps to the screen on iOS (#1020)
- **Mail**: Mail action toasts show again
- **Send**: A send the server refuses is reported as failed instead of sent. When only filing the sent copy fails, a warning says so, so the mail is not sent twice
- **Send**: A From override is also used as the envelope sender where the server accepts it. Where it doesn't, as on Stalwart, the composer says that the identity's address shows in the Return-Path (#1009)
- **Send**: Sending with an identity adds its Bcc addresses
- **Composer**: Attachments over the server's size limits are refused before upload
- **Composer**: A staged attachment is kept until its upload finishes
- **Filters**: Filters keep running while the auto-reply is on, and saving a filter no longer turns the auto-reply off
- **Filters**: "Mark read", "star" and "add label" reach mail that the same rule moves, and rules keep their target folder after it is renamed
- **Filters**: Forward actions respect the server's redirect limit (one on Stalwart) instead of being dropped without notice
- **Auto-reply**: A warning appears before saving an auto-reply that Stalwart would refuse as too long
- **Calendar**: Edits to a single occurrence stay on that occurrence and keep its details
- **Calendar**: Date ranges are queried in the right time zone, and long recurring series or more than 1000 events no longer leave the calendar incomplete
- **Calendar**: When the server refuses an event's invitations, you can save the event without sending them
- **Calendar**: Subscriptions that fail with "Not authenticated" name the cause, such as a mail server certificate the webmail server does not trust (#1073)
- **Calendar**: The subscription dialog no longer promises CalDAV URLs
- **Calendar**: The import dropdown opens above the day and week views (#1049)
- **Contacts**: Contacts with calendar, scheduling or free/busy links save, and cleared fields are cleared on the server
- **Contacts**: vCard import no longer sends fields Stalwart rejects and writes addresses in the RFC 9553 form
- **Contacts**: Deleting an address book that still holds contacts works
- **Files**: Every file is listed, even when the account has more than `maxObjectsInGet` (#1069)
- **Files**: Copying a folder copies its contents, and changes inside a shared drive go to the drive's account
- **Files**: An upload or new folder whose name is taken becomes "name (2)" instead of failing
- **Files**: Sharing works on Stalwart versions before 0.16.6
- **Files**: Names Stalwart refuses are caught before sending, uploads store an accepted variant, and Office files keep their MIME type on Stalwart 0.16.6 and later
- **Account**: You stay signed in after changing your password in settings
- **Account**: Users who are not admins see their name, and changing the password or turning TOTP off asks for the current code
- **Auth**: OAuth endpoints on the configured issuer's own host are accepted when they resolve to a private address, so split-DNS setups no longer need `OAUTH_ALLOW_PRIVATE_ENDPOINTS` (#1028)
- **Auth**: Linking the mobile app re-authenticates against the account's own identity provider when OAuth is configured per server
- **Push**: Push subscriptions are renewed before Stalwart's 7-day expiry, so a tab or app left open for over a week keeps getting notifications
- **Sharing**: Principals are listed in directories with more than 500 users
- **Lite**: The login page hides the server field once `config.json` sets `jmapServerUrl` (#1087)
- **Plugins**: The plugin sandbox follows the app's "Automatic" language (#976, thanks @bartfaizoli76)
- **UI**: The global error page loads the app's styles

## 1.11.0-beta.3 (2026-09-23) - Pre-release

General test release of everything planned for 1.11.0 so far. Not recommended for production; the `latest` Docker tag stays on 1.10.0.

### Added

- Attendees can answer a single occurrence of a recurring event (#1086).
- Optional inbox-only push notifications (#983, thanks [@guisea](https://github.com/guisea)).
- OpenID Connect login in the Bulwark Lite bundle for Stalwart.
- Bulwark Lite as a container image (#1081).

### Changed

- The message list loads attachment chips lazily, so large folders open faster (#1089).
- Mail search sends search terms exactly as typed, without adding a prefix wildcard. This also applies in tag views.
- Scheduled send is limited to 7 days, the most Stalwart accepts.

### Fixed

- "All folders" search includes shared accounts (#1082).
- A search inside a tag view narrows the tag instead of replacing it.
- Leaving an account drops a search folder scope that belongs to it (#1084, thanks [@rotterp](https://github.com/rotterp)).
- In unified views, threads belong to the account that owns them (#1012, thanks [@lucamzanon](https://github.com/lucamzanon)).
- A failed move between accounts no longer loses the message.
- "Mark all as read" marks every unread message and reports spam moves the server refuses.
- Send and search report failed JMAP calls instead of claiming success.
- Attachments over the server's size limits are refused before upload.
- Sending with an identity adds its Bcc addresses.
- Tag and tab counters no longer download every matching id.
- Mail filters keep running while the auto-reply is on, keep flags and folder targets when mail is moved, and no longer pull spam out of Junk.
- A warning appears before you save an auto-reply that Stalwart would refuse as too long.
- Edits to a single occurrence stay on that occurrence and keep its details.
- Calendar ranges are queried in the right time zone and past the server limits.
- If the server refuses an event's invitations, you are offered to save the event anyway.
- The calendar subscription dialog no longer promises CalDAV URLs.
- Contacts with calendar links or cleared fields save correctly.
- Files lists every file, even when the account has more than `maxObjectsInGet` (#1069).
- Files can copy whole folders and write to shared drives, shares files on Stalwart versions before 0.16.6, and handles file names and types Stalwart refuses.
- You stay signed in after changing your password in settings.
- Users who are not admins see their name and can change a TOTP password.
- Push subscriptions are renewed before Stalwart's 7-day expiry.
- Sharing lists principals in directories with more than 500 users.
- The plugin sandbox follows the app's "Automatic" language (#976, thanks [@bartfaizoli76](https://github.com/bartfaizoli76)).
- The global error page loads the app's styles.

## 1.11.0-beta.2 (2026-09-21) - Pre-release

Second test release for **Bulwark Lite**. Not recommended for production; the `latest` Docker tag stays on 1.10.0.

### Added

- Toasts for mail actions that had no feedback, plus an "email sent" toast after immediate sends.
- Deep links resolve to the local instance.

### Fixed

- A staged attachment is kept until its upload finishes.
- Toasts show again.

## 1.11.0-beta.1 (2026-09-19) - Pre-release

Test release for **Bulwark Lite**, the static build of the webmail. Not recommended for production; the `latest` Docker tag stays on 1.10.0.

### Added

- **Bulwark Lite static export**: `npm run build:lite` produces a server-less build that talks to the JMAP server directly from the browser. The release ships `bulwark-lite-<version>.zip` for any static web host.
- **Bulwark Lite for Stalwart Applications**: `bulwark-lite-stalwart.zip` is a Stalwart `Application` bundle that picks up its mount prefix at runtime.
- **"Flat fields" theme**.

### Changed

- Icon set migrated from Lucide to Tabler Icons.

### Fixed

- Hardened Bulwark Lite login, deep-link replay and settings gating.

## 1.10.0 (2026-09-17)

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@windsource](https://github.com/windsource)

**Monthly**

- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Security

This release fixes six vulnerabilities reported by Jan Kahmen (turingpoint). Please update.

- **Mail**: HTML mail could run script in the webmail origin. `cid:` references were rewritten to `blob:` URLs that kept the sender's `Content-Type`, and the reverse proxy skipped every security header — CSP included — on app paths whose last segment contains a dot, although the signed-in mail, calendar, contacts and files routes render there. Blob URLs are now retyped as inert, link clicks from the message frame are gated by scheme, and the proxy only skips headers for an explicit static-asset allowlist (GHSA-xvjh-v9c6-qcvc, thanks @kah-ja)
- **Auth**: `POST /api/auth/session` and `POST /api/auth/stalwart-context` minted identity cookies without checking the supplied credentials against the JMAP server, so anyone could obtain a cookie for an arbitrary username and read that user's server-side settings. Credentials are now verified upstream before a cookie is issued: Basic credentials are bound to the account they authenticate, Bearer tokens to the session's username and identity. Deployments whose webmail container cannot reach the JMAP server no longer receive identity cookies, so cross-device settings sync stops working there (GHSA-wxcm-j4jc-9fxq, thanks @kah-ja)
- **Plugins**: The `/plugin-sandbox` runtime trusted whichever window posted the first message, so a foreign site could `window.open()` it, post its own `init`, and run code under the route's `unsafe-eval` CSP in the app origin — with or without plugins enabled. The sandbox now only accepts its framing window, and the proxy refuses to serve the route outside an iframe or when plugins are disabled (GHSA-96cx-gx36-3g79, thanks @kah-ja)
- **Auth**: Encrypted payloads now carry a purpose, so a WOPI editor access token can no longer be presented as a `jmap_stalwart_ctx` session cookie (GHSA-cqqx-mjcf-mh55, thanks @kah-ja)
- **Auth**: Reject cross-site requests to `/api/auth/*`. A malicious page could `POST` the victim's browser into an attacker-controlled account (session fixation) (GHSA-qvr9-m8cq-7wvg, thanks @kah-ja)
- **Mail**: Strip CR/LF and other control characters from the header values of generated read receipts. A crafted, RFC 2047-encoded subject could inject additional headers into the receipt (GHSA-w38p-hpqv-g89c, thanks @kah-ja)
- **Auth / Branding**: Pin the resolved IP at connect time for stored custom JMAP endpoints and branding URLs too, closing the DNS-rebinding gap left after GHSA-24w9-8r42-8jwm

### Features

- **Search**: Global search across mail, contacts, calendar and files — query parser, ranking and cross-account providers, a search palette, and a search tab in the Pro shell with avatars, tinted icons and structured previews (#641); hits open through the owning login on every surface (#847)
- **Files**: Office document editing through WOPI — Collabora Online, OnlyOffice and EuroOffice (#425); the demo Files drive ships office document fixtures and a word-processor icon
- **Calendar**: Freely scrolling month, week and day views (#759), infinite scroll in the agenda view, and a setting to turn free scrolling off
- **Calendar**: Recurring occurrences use Stalwart's synthetic ids (#140)
- **Calendar**: Attendee free/busy via `Principal/getAvailability`
- **Calendar**: Invitations and updates surface from `CalendarEventNotification`, and invitations are organized as the default `ParticipantIdentity`
- **Mail**: Per-message HTML / plain-text toggle (#1022)
- **Mail**: Share mail folders with other users via `mail:share`; share notifications appear as toasts
- **Mail**: Search hits are highlighted with `SearchSnippet/get`
- **Mail**: Pushes are resolved with `Email/changes` and `Mailbox/changes` deltas instead of refetching the list
- **Mail**: Attachments show on list rows and open from there (#947, thanks @shukiv)
- **Mail**: Filter advanced search by message size
- **Mail**: Deleting a non-empty folder offers to delete its messages along with it
- **Mail**: "Clear search when switching folders" setting (#852, thanks @shukiv)
- **Mail**: Default sidebar apps for all users (#931)
- **Send**: Request delivery status notifications and REQUIRETLS when sending
- **Reply**: Choose exact-address or same-domain matching for replying from the address a message was received at (#1000)
- **Composer**: Sticky formatting toolbar, font-size picker and background colour (#987, thanks @ibayue)
- **Contacts**: Sort contacts by last name (#963)
- **Contacts**: Set an address book as default (#924)
- **Mobile**: Search-first header replacing the second toolbar row, with the query clearable from the header (#945, thanks @shukiv)
- **PWA**: The installed app icon shows the unread count via the Badging API (#934, thanks @dev-hive-kazniisa)
- **Auth**: `prompt=select_account` is sent to the identity provider when adding another account (#979, thanks @Almost-Senseless-Coder)
- **Admin**: Server-side switch for the Stalwart JMAP passthrough (#904)
- **Plugins**: `ui.openDialog` and a `plugin-dialog` slot for large, clickable custom UI (#975, thanks @bartfaizoli76)
- **Plugins**: `attachment-actions` and `composer-attachment-source` slots (#974, thanks @bartfaizoli76)
- **Plugins**: OAuth callback handler, extended contacts and address-book API (#925, thanks @ponchofiesta)
- **Accessibility**: Better labelling of the email list for screen readers (#1008, thanks @Almost-Senseless-Coder)
- **i18n**: Norwegian Bokmål (#829, thanks @larstobi)
- **i18n**: Traditional Chinese (Taiwan) (#932, thanks @kchuang1015)
- **CI**: The test suite runs on every push and pull request (#647)
- **Dev**: FileNode and blob round-trip in the mock JMAP server, and WOPI on the same-origin dev server

### Changes

- **Docs**: Installer section removed from the README and formatting cleaned up
- **Security policy**: New vulnerability report email address

### Fixes

- **Filters**: Render the "Keep" action as `fileinto "INBOX"` (#1027)
- **Mail**: List tagged mail from every account in the tag view, not just the selected folder's account (#1038)
- **Mail**: Dragging a message out of the list could hang the tab when generated `.eml` file names collided (#1039)
- **Mail**: Preserve label filtering during mailbox refreshes (#1017, thanks @ctaoist)
- **Mail**: Hide body-embedded `cid:` parts declared as `application/octet-stream` from the attachment list (#1005, thanks @dealerweb)
- **Mail**: Stop stretching images that carry their own max-width (#1034, thanks @shukiv), and let sender tables keep theirs (#790)
- **Mail**: Refetch the body when JMAP truncates the displayed part instead of rendering a blank message (#928, thanks @hildebrandttk)
- **Mail**: Auto-detect text direction in the read, print, plain-text, thread and `.eml` preview views (#663, thanks @shukiv)
- **Mail**: Open search hits from shared folders in the right account (#923)
- **Mail**: Collapse search hits for the same server object reached through several logins (#641)
- **Mail**: Guard quick search against stale responses (#872, thanks @vj1235432)
- **Mail**: Only show the unified mailbox section when it can be populated (#843), and stop it missing accounts that had not connected yet (#959, thanks @hildebrandttk)
- **Mail**: Surface `Email/set` failures on delete and move (#956)
- **Mail**: Report a missing archive mailbox instead of failing silently (#578), and archive shared-inbox mail into the owner's archive (#889)
- **Mail**: Mark as spam from the viewer after the message left the list (#695)
- **Mail**: Subscribe newly created mailboxes (#951)
- **Mail**: Sort folders in the role assignment dropdown (#984)
- **Mail**: Add the missing "Scheduled" folder role label (#495)
- **Mail**: Wire the `x` shortcut to thread expansion (#683)
- **Mail**: Keep the reading-mode toggle mounted so toolbar buttons stop jumping (#964)
- **Mail**: Stop the batch toolbar hiding the message you just selected (#948, thanks @shukiv), keep rows in place when it opens, and drop the duplicate selection checkbox
- **Mail**: Align the unread dot with the first line (#715, thanks @lucletoffe) and centre the sender avatar against the row (#953, thanks @shukiv)
- **Mail**: Use Simplified Chinese for the selected-messages label (#786)
- **Send**: Send from the address a message was delivered to (#991, thanks @rotterp)
- **Send**: Set the answered flag when a reply goes out with a send delay (#985)
- **Composer**: Upload attachments through the composing identity's account (#943)
- **Composer**: Pro compose tabs default their From to the open mailbox (#990, thanks @rotterp)
- **Calendar**: Jump to the day picked in the mini calendar (#1037, thanks @dealerweb)
- **Calendar**: Wait for the JMAP client before loading the account principal, and recognise a refused principal read by its JMAP error type (#1036, thanks @dealerweb)
- **Calendar**: Dedupe participants, resolve contact names across alias domains, and show the organizer's status (#986, thanks @ibayue)
- **Calendar**: Linkify URLs in the event description (#968, thanks @lucletoffe)
- **Calendar**: RSVP controls (#967, thanks @wrycu)
- **Calendar**: Normalize task progress states (#994, thanks @mulatta) and omit `progressUpdated` from the task completion payload (#958, thanks @sanitz)
- **Calendar**: Preserve task alarms that the edit dialog does not show (#504)
- **Calendar**: Report calendar clear failures instead of counting zero (#434)
- **Calendar**: Make the iCal subscription size limit configurable and show the real error (#692)
- **Calendar**: Paginate the event fetch on import so UID deduplication sees all existing events (#113)
- **Contacts**: Strip the local-account prefix from address-book ids on contact update (#1043)
- **Contacts**: Set `name.full` on all write paths so vCards carry the mandatory `FN` (#430)
- **Contacts**: Create new contacts in the selected address book (#940, thanks @ponchofiesta)
- **Accounts**: Detect HTTP/2 from the initial navigation timing so accounts are not capped at five (#1003, thanks @lucamzanon)
- **Auth**: Reject wrong passwords server-side so the browser never shows its Basic Auth dialog (#969)
- **Auth**: Stop retrying token refreshes that fail permanently (#972)
- **Auth**: Normalize the OAuth discovery base so a session `JMAP_SERVER_URL` refreshes (#971, thanks @thejdubb02)
- **Auth**: Use the selected server's issuer for SSO discovery (#952)
- **Auth**: Retry the JMAP session fetch when a redirect drops the auth header (#892)
- **Auth**: Drop `max_age=0` from OIDC re-authentication requests (#938)
- **Auth**: Require a session for the translate API (#903)
- **Mobile**: Keep the actions panel below the status bar and pad attachment preview overlays for the iOS PWA safe area (#936)
- **Mobile**: Render plain-text-only mail as text in the thread view (#489)
- **Mobile**: Stop the More menu flashing open when a message is opened
- **Mobile**: Dismiss the search panel once a search runs, open the folder drawer from the right in RTL (#944, thanks @shukiv), and keep the account switcher header on screen
- **PWA**: Smaller margin for the app icons (#883, thanks @ponchofiesta)
- **PWA**: Focus the client before navigating on notification click (#914, thanks @bitfactory-dk)
- **Push**: Resolve push previews for shared and group mailboxes (#839)
- **Plugins**: Allow sandbox chunk loading with CORS (#922, thanks @mulatta)
- **Plugins**: Fail fast when the plugin storage database is blocked (#840)
- **Plugins**: Refill missing managed bundles from the server (#636)
- **Plugins**: Translations for plugins installed from the marketplace (#939, thanks @paulhenry46)
- **Settings**: Index newer settings and the flat calendar toggles in the settings search
- **Settings**: Invalidate the persisted update status after an upgrade
- **UI**: Readable native `<select>` option lists in dark themes (#999)
- **i18n**: German update (#1031, thanks @GyroGearl00se), "Forward as attachment" in more languages (#1016, thanks @dulinux), toolbar keys for nb and zh-TW (thanks @ibayue), and managed sidebar-app keys for zh-TW
- **i18n**: Preserve locale cookie precedence and normalize Chinese proxy locale detection (thanks @kchuang1015); keep `basePath` when normalizing a Chinese `Accept-Language`

## 1.9.2 (2026-08-26)

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- [@elsbrock](https://github.com/elsbrock)
- [@getpankajyadav](https://github.com/getpankajyadav)

**Monthly**

- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Security

- **Calendar / Auth**: Pin the resolved IP address at socket-connect time when fetching caller-supplied URLs (iCalendar subscriptions, JMAP login and TOTP token-exchange servers). The public-host check used to run before `fetch()` opened its socket, so an attacker who controlled DNS for a hostname could rebind it to loopback, RFC-1918 or cloud-metadata addresses between the check and the connect and read up to 10 MB of the internal response through the unauthenticated `/api/fetch-ical` endpoint. Redirect targets are now validated the same way (GHSA-24w9-8r42-8jwm, thanks @Tike00)

### Features

- **Push**: Re-sync existing push registrations in the background on app start, so registrations created before the delivery filter existed — or whose Junk mailbox id went stale — get repaired without re-enabling notifications

### Fixes

- **Push**: Stop sending notifications for spam — the push subscription now carries a JMAP `emailPush` delivery filter that excludes `$junk` and the Junk mailbox (needs a server advertising the `emailPush` capability, e.g. Stalwart ≥ 0.16.16; older servers keep the previous behaviour)

## 1.9.1 (2026-08-26)

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- [@elsbrock](https://github.com/elsbrock)
- [@getpankajyadav](https://github.com/getpankajyadav)

**Monthly**

- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Fixes

- **Navigation**: Forward every request header through the proxy — Next 16.3's RSC header check rejected the stripped router headers and sent navigations into a 307 redirect loop (#919)
- **Calendar**: Stop emitting `RSCALE=GREGORIAN;SKIP=OMIT` on plain Gregorian recurrence rules — DAVx5 rejected them as invalid and Android sync broke (#805, thanks @hildebrandttk)

## 1.9.0 (2026-08-25)

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- [@elsbrock](https://github.com/elsbrock)
- [@getpankajyadav](https://github.com/getpankajyadav)

**Monthly**

- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Features

- **Mail**: Fullscreen email view in the standard interface
- **Mail**: Drag a mail onto a new browser tab to open it fullscreen
- **Mail**: Configurable message-list ordering (#718)
- **Mail**: Search suggestions with recent searches and contact autocomplete (#845)
- **Mail**: Render plain-text emails in the app font by default, with a monospace option (#830)
- **Mail**: Pull-to-refresh indicator while dragging the list down (#826)
- **Mail**: Redesigned unread favicon badge — a compact keyline badge
- **Mobile**: Swipe message rows left or right for quick actions — archive, delete, toggle read, toggle star, or spam, configurable per direction, RTL-aware
- **Pro**: Reworked split-screen shell with per-pane tab strips, drag & drop between panes, and pane-scoped overlays
- **Pro**: Folder tabs via drag & drop
- **Pro**: The address bar follows the focused tab, and deep links are delivered live to already-mounted surfaces
- **Composer**: Real byte progress for attachment uploads, stock and plugin-offloaded; cancel now aborts the transfer itself
- **Calendar**: Moving an event's start moves the end with it, keeping the event's length
- **Contacts**: Trusted Senders address book enabled by default on contacts-capable accounts
- **Settings**: Custom time zone setting that overrides browser detection (#755)
- **Login**: Server dropdown on the OAuth-only login screen (#799)
- **Push**: New-mail notifications grouped per account with a "+N more messages" line instead of one notification per message
- **Push**: Per-device revoke for push subscriptions (#841)
- **Admin**: Configurable Stalwart admin access to the dashboard (#870)
- **Admin**: Push relay picked from an admin-defined list instead of a free URL field
- **Branding**: OpenGraph/Twitter link previews with a generated card image
- **Performance**: Halved time-to-mail-list — lazy locale catalogs, code-split viewer and composer, shorter auth waterfall, boot snapshot
- **i18n**: Mongolian translation
- **Plugins**: `jmap.uploadBlob`
- **Plugins**: `onBeforeComposeOpenToReply` and sibling hooks let a plugin edit an email before it populates the composer for reply or forward
- **Plugins**: `getPublicKeyFromWKD`
- **Plugins**: Privileged plugins can fetch a byte range of a blob
- **Plugins**: `progressFileId` on `api.http.post` so an offloaded upload reports byte progress to the composer chip
- **Plugins**: `isActive` on `AccountResponse`
- **Plugins**: Label settings and label reordering exposed to extensions
- **Plugins**: JMAP keyword helpers and gateway keywords exposed to extensions
- **Plugins**: Mailbox refresh hook
- **Dev**: `AddressBook/set` in the dev mock JMAP server

### Changes

- **Plugins**: The PRF `getOrCreate` flow is split into separate get and create steps for better authenticator compatibility (#851)
- **Dependencies**: Next 16.3.3, pdfjs-dist 6.2.108, DOMPurify 3.4.14 (npm audit)

### Fixes

- **Send**: Route scheduled sends to the account that owns the submission — mail scheduled from a shared address can now be listed, cancelled, and rescheduled instead of going out silently (#874)
- **Send**: Split recipient lists whose angle brackets never close without dropping recipients
- **Send**: `generateMessageId` crashed on insecure origins (`crypto.randomUUID` undefined), failing the send after the draft save
- **Composer**: Keep attachments when re-opening a draft, also in the Pro draft tab, and destroy old draft versions only after a successful create or send (#849)
- **Composer**: Keep the signature in saved drafts and embed it into re-opened drafts (#848)
- **Composer**: Double-click unlocks the embedded signature for editing
- **Composer**: Keep already written text when applying a template (#540)
- **Composer**: Preselect the shared folder's identity for new messages
- **Composer**: Namespace all accounts consistently in the Pro composer identity list
- **Composer**: Opening a `mailto:` link runs the unsaved-draft dialog instead of replacing the draft outright
- **Composer**: Keep the fresh-compose tab title clear of the selected email subject
- **Composer**: Clear the viewer when sending destroys the displayed draft
- **Reply**: Honour an external Reply-To even on a self-sent message
- **Mail**: Flip `$junk`/`$notjunk` keywords on spam and not-spam (#850)
- **Mail**: Remove keywords with `null` rather than `false` in `Email/set`, per RFC 8620
- **Mail**: Escape the JSON Pointer in keyword patches so nested tags like `work/clients` patch the right keyword
- **Mail**: Route keyword writes — tags, pins, flags — to the selected shared account so they persist
- **Mail**: Route shared-folder management to the owner account, scoped to one server
- **Mail**: Open the right conversations in a shared mailbox (#814)
- **Mail**: Route multi-account email lookups and invitation parsing by source account (#847), and parse invitations in directly viewed shared folders against the folder owner (#867)
- **Mail**: Folders containing a system folder name no longer disappear from the sidebar (#771)
- **Mail**: Folder drag & drop can move folders into other parents (#855)
- **Mail**: Keep the folder tree when a refresh burst hits `maxConcurrentRequests` (#780)
- **Mail**: Stop All-Mail and cross-account views emptying on delete, star, or mark-read (#791)
- **Mail**: Keep just-read or unstarred mail in the open Unread/Starred view
- **Mail**: Search folder filter defaults to all folders and persists (#788)
- **Mail**: Fixed-width read/unread toolbar button so buttons don't jump when a message opens (#864)
- **Mail**: Transparent hover-action background on tagged rows
- **Mail**: Enforce the external media preference on plugin-rendered bodies (#797)
- **Mail**: Apply the `data:` URI allowlist to media tags and `srcset` candidates too
- **Mail**: Make label reordering atomic
- **Mail**: Pass PDF bytes to pdf.js instead of fetching the `blob:` URL that CSP `connect-src` blocks (#871)
- **Mail**: Include email templates in cross-device settings sync (#825)
- **Mail**: Toast store crashed on insecure origins, breaking every post-action acknowledgement
- **Mobile**: Reach the tag and move submenus in the more-actions menu (#779)
- **Mobile**: iOS Safari no longer zooms the viewport on every input focus (#838)
- **Calendar**: Click and double-click create events at the clicked slot instead of near the current time
- **Calendar**: Save and Cancel are available when an event is created, and the toolbar no longer overflows in edit mode
- **Calendar**: Edit a single recurring occurrence via a one-shot override patch
- **Calendar**: Hide tasks-only calendars from the event calendar
- **Calendar**: Exclude subscription and read-only calendars from event creation (#762)
- **Calendar**: Rights-first event editability, including alias organizers
- **Calendar**: Pin `supported-calendar-component-set` on created calendars (#760)
- **Calendar**: Gate first-touch calendar and contacts requests to stop duplicate default calendars (#907)
- **Calendar/Contacts**: Namespace all accounts consistently on switch, so multi-account address-book aggregation and calendar selection survive an account switch
- **Contacts**: Import vCard dates as RFC 9553 PartialDate and map common X- extensions (#224)
- **Files**: Decode percent-encoded FileNode names from WebDAV-created nodes (#869)
- **Files**: Reset the account-scoped Files drive on every account switch
- **Accounts**: Refresh the account display name from the Stalwart principal on login, restore, and switch (#900)
- **Auth**: Reuse the cached access token on session restore (#552)
- **Auth**: Refresh TOTP-minted tokens with the default client id when no OAuth client is configured (#873)
- **Auth**: Store the session cookie for relative JMAP server URLs
- **Security**: Close IPv6 transition-address and redirect bypasses in the endpoint guard
- **Security**: Add embedded custom app origins to CSP `frame-src` (#787)
- **Security**: Per-account isolation for encryption at rest
- **JMAP**: Cap live SSE streams per tab and keep exactly one stream per client, so many logins can't starve JMAP requests (#702)
- **JMAP**: Check the specific capability a request declares (`principals:owner`), not a broader one
- **JMAP**: Resolve relative session URLs without corrupting URI templates
- **Settings**: Merge per-account maps on server load, fixing the compose identity switch
- **Settings**: Leaving the Pro interface returns to the surface in use and keeps the settings scroll position
- **UI**: Position portalled popovers before first paint to stop the layout flash on open
- **Push**: Recreate the push subscription on re-register (#841)
- **i18n**: Key parity across all 24 locales, Catalan and Mongolian registered in the client provider, and scoped translation hooks instead of relative namespace paths
- **Docs**: Lengthen the example `SESSION_SECRET` so it meets the minimum length

## 1.8.1 (2026-08-07)

A GitHub Actions incident left the 1.8.0 release build queued indefinitely, so no Docker image was ever published for that tag. 1.8.1 re-runs the release with the same code, plus one plugin slot that merged in the meantime.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@getpankajyadav](https://github.com/getpankajyadav)
- [@Beckid](https://github.com/Beckid)
- [@schnz](https://github.com/schnz)
- [@BryanBerger98](https://github.com/BryanBerger98)

**Monthly**

- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)

### Features

- **Mail**: Nest tags in a tree by picking a parent when you create one
- **Mail**: Per-tag visibility — always, only when unread, or always hidden
- **Mail**: Assign and clear several tags at once, with a reworked tag display
- **Mail**: Recover tags from the server by scanning mail for JMAP keywords no local tag explains (#658)
- **Mail**: "Forward as attachment" in the viewer and the message-list context menu
- **Mail**: Refresh button in the mail-list toolbar
- **Composer**: Confirm sending without a subject instead of blocking the send, with "Don't ask again" (#684)
- **Contacts**: Contact cards for organizations (#701)
- **Security**: Manage S/MIME and PGP public keys and configure Stalwart encryption at rest from account security settings
- **Notifications**: Background notification onboarding, sequenced after the PWA install prompt
- **Navigation**: Deep links for mail, calendar, contacts, files, and settings, with screen-reader improvements
- **Settings**: Always show the Unified Mailbox switch in Layout settings
- **i18n**: Catalan translation
- **i18n**: Localized editor toolbar across every locale
- **Plugins**: Contact API — `contact.get`, `contact.create`, `contact.update`, `contact.search`
- **Plugins**: `contact-cryptokeys` UI slot, behind the `ui:contact-cryptokeys` permission, so a plugin can render a contact's crypto keys in place of the built-in list
- **Plugins**: `user.getAccounts` and `user.getIdentities`
- **Plugins**: `user.logout` method and logout hook
- **Plugins**: Crypto API — public-key management and encryption-at-rest control on the privileged tier
- **Plugins**: `onBeforeBlobUpload` can offload an attachment to external storage
- **Plugins**: Binary `Blob`/`File` bodies for `api.http.post`
- **Plugins**: `upfiles.get` moved behind `email:blob-read`, off the privileged tier
- **Dev**: Mock JMAP defaults now include nested tags

### Changes

- **Mail**: The "Reset to defaults" button is gone from tag settings — one stray click wiped a carefully built tag list, with no confirmation and no undo

### Fixes

- **Send**: Send through the identity's own account client so DKIM matches the From domain (#461)
- **Send**: Split `Name <addr>` recipients into the JMAP `name` and `email` fields (#672)
- **Send**: Time out stalled JMAP requests so a send can't hang forever (#702)
- **Mail**: Keep inline images when replying to `application/octet-stream` cid parts (#543)
- **Mail**: Reply on your own thread message no longer re-addresses the original recipients (#703)
- **Mail**: Empty folder no longer stops after 500 emails (#711)
- **Mail**: Move messages across accounts from the "Move to" context menu, preserving read state and deferring source removal to Stalwart
- **Mail**: Stop resurrecting deleted rows in the mailbox refresh merge
- **Mail**: Keep the `message/rfc822` attachment visible after inline unwrapping
- **Mail**: Strip sender and recipient names from forward-as-attachment filenames
- **Mail**: Open `mailto:` links in the built-in composer
- **Mail**: Spell out the full tag path in drag-and-drop toasts, so `Personal/Receipts` and `Work/Receipts` no longer read as the same tag
- **Mail**: Act on current email state in the context menu's mark-as-read instead of a stale copy
- **Mail**: Match the selected-row tint between dark and light mode
- **Mail**: Restore lost animations after the Tailwind config move
- **Drafts**: Restore the sender identity when reopening a draft
- **Calendar**: Stop re-adding the organizer to the attendee list on every save (#731)
- **Calendar**: Stop re-probing shared accounts that have no calendar access
- **Calendar**: Route the parse dump through the debug logger
- **Contacts**: Stop minting duplicate "Trusted Senders" address books (#730)
- **Contacts**: Hide Contacts and Calendars when the account lacks the JMAP capability
- **Contacts**: Require an explicit shared-account fallback for contacts and calendars
- **Files**: Show the modification date instead of the creation date (#700)
- **PWA**: Honor the configured theme color in the desktop title bar and keep it in step with the active theme (#671)
- **Accounts**: Reconcile the stale persisted account chip after an impersonation handoff
- **Auth**: Only request a credential cookie when the server has a `SESSION_SECRET`
- **JMAP**: Split requests to stay inside the server's advertised limits — `maxCallsInRequest`, `maxObjectsInGet`/`InSet`, `maxSizeRequest`, and concurrency
- **JMAP**: Treat an aborted SSE connect as a close, not a failure
- **JMAP**: Surface the underlying network error cause in passthrough failures
- **Settings**: Avoid leaving `TZ="undefined"` when restoring an unset timezone
- **Plugins**: Stop a privileged plugin from reading another privileged plugin's PRF secret
- **Plugins**: Correct the method names for message errors and `crypto.getPublicKeys`
- **i18n**: Restore key parity across locales and the English `send_timeout` string
- **Docs**: Document the remaining env vars in the env templates, and correct the facts and headings in README and FEATURES

## 1.8.0 (2026-08-06)

Superseded by 1.8.1. The release build never produced a Docker image — use 1.8.1 instead. The full notes live under 1.8.1 above.

## 1.7.8 (2026-07-22)

### Features

- **Unified Mailbox**: Account-bounded Unified Mailbox with opt-in cross-account aggregation (#509)
- **Unified Mailbox**: Search in the unified views
- **Unified Mailbox**: Live unified/All-Mail counters for shared and group accounts
- **Mail**: Message-list category tabs
- **Mail**: Drag-and-drop reorder for all folders
- **Mail**: Collapse quoted reply text behind a "..." toggle (#480)
- **Mail**: Bulk Not-Spam action in the junk selection toolbar
- **Mail**: Unread count badge on the favicon
- **Mail**: Message spacing setting (auto/always/edge-to-edge)
- **Mail**: Open external links in a new tab (safely)
- **Mail**: Strip external `url()`/`@import` from `<style>` blocks in the sanitizer (#457)
- **Composer**: Text color picker in the composer toolbar
- **Composer**: Contact groups as single expandable recipient chips
- **Composer**: Drag-to-reorder To/Cc/Bcc recipient chips (#593)
- **Composer**: Auto-detect paragraph text direction by default
- **Templates**: HTML template support
- **Vacation**: HTML body support in the vacation responder
- **Send**: 'Send now' action on the send-delay toast
- **Accounts**: Remove a specific account from the switcher
- **Settings**: "Refresh cached data" recovery action
- **i18n**: Full Arabic (ar) translation with RTL support
- **Login**: `LOGIN_SHOW_TOTP` and `LOGIN_SHOW_VERSION` config flags (#520)
- **Docker**: `NEXT_PUBLIC_LOCALE_PREFIX` build argument
- **Plugins**: `ui.rerenderFetchedEmails` method (#668)
- **Plugins**: `onEmailsFetched` and `onSearchResults` hooks and `getSomeEmails` JMAP method
- **Plugins**: `onRecipientChipsChange` hook
- **Plugins**: `webauthn.getOrCreate` API method
- **Plugins**: Download files generated by a plugin (with `ui:download-file` consent permission)
- **Plugins**: Submit mail without moving to a mailbox and import-to-mailbox APIs

### Fixes

- **Mail**: Render the email body on DOM parse instead of iframe load (#635)
- **Mail**: Keep sidebar tag counts in step with read/unread changes
- **Mail**: Enable thread expansion in the focused list
- **Mail**: Show the quote bar in email replies
- **Mail**: Honor part-type fallback when quoting replies (#649)
- **Mail**: Detect typing inside the quoted-HTML shadow island (#654)
- **Mail**: Keep `target`/`rel` on links in plain-text message bodies and open signature links in a new tab
- **Accounts**: Eliminate the full-screen flash when switching accounts (including cached accounts)
- **Accounts**: Recognize canonicalized login usernames in the account-switch guard
- **Auth**: Guard account switch against slot→token desync and basic-auth identity mismatches
- **Auth**: End refresh loops on sign-out and back off failed retries
- **OAuth**: Harden OIDC discovery (timeout, retry, serve-stale)
- **JMAP**: Preserve POST across redirects in the Stalwart JMAP passthrough (#627)
- **JMAP**: File the post-send message with a full `mailboxIds` replacement
- **JMAP**: Generate the Message-ID client-side using the sender's domain
- **Identity**: Sync the default sender identity per account (#507)
- **Attachments**: Download/view attachments on cross-account All-Mail messages
- **Shared folders**: Route batch actions to the owner account
- **Templates**: Insert a mail template at the caret in replies instead of prepending (#539)
- **Templates**: Keep the signature when inserting a template (#621)
- **Templates**: Hide template buttons when templates are disabled
- **Calendar**: Honor "Show time in month view" on mobile instead of forcing dots (#666)
- **Calendar**: Classify self-organized imported events as editable
- **Contacts**: Assign a UID to contact cards on creation (#644)
- **Spam**: Stop HELO `spf=none` from downgrading a MAIL FROM `spf=pass` (#650)
- **Drafts**: Label the close-dialog draft button with the generic Save
- **RTL**: Flip JS-positioned popovers and anchor floating menus with logical start/end
- **RTL**: Isolate Latin address text from RTL bidi reordering and force LTR identity options
- **i18n**: Register Arabic messages in the client IntlProvider
- **i18n**: Fix the Hebrew Drafts folder label
- **i18n**: Add missing translation keys across 22 locales
- **Deps**: Bump `dompurify` to 3.4.12 and `next-intl` to 4.13.3

## 1.7.7 (2026-07-09)

### Features

- **Plugins**: `ui.rerenderEmail` API and restyled read-receipt banner
- **Plugins**: New hooks — `onBeforeBlobUpload`, `onBeforeDraftAutoSave`, `onBeforeEditDraft` (#586)
- **Plugins**: `ui.prompt` dialog and first-class settings-section tabs
- **Calendar**: Jalali (Persian/Shamsi) calendar support with Saturday as week start (#490)
- **i18n**: Hebrew locale with full RTL support
- **i18n**: Slovak translation
- **i18n**: User-selectable regional date format
- **Contacts**: Enable trusted-senders address book sync by default when contacts are available
- **Mail**: Pin emails to the top of the folder list
- **Mail**: Setting to disable the tag-color row tint in the message list
- **Mail**: Click the sender avatar to select a message/thread (Thunderbird-style)
- **Accounts**: Pin the default account on top and drag-to-reorder the account switcher
- **Composer**: Recipient autocomplete from Sent, with on-demand server search
- **Composer**: Preselect the identity of the active mailbox for new messages
- **Email**: Send a quick reply with Ctrl/Cmd+Enter
- **Headers**: Parse Stalwart spam headers
- **Login**: Configurable logo size and hideable heading/subtitle
- **PWA**: Apple Touch icons for the iOS home screen

### Fixes

- **Mail**: Hide Files when the account lacks the filenode capability (#563)
- **Mail**: Keep advanced search filters applied when switching folders (#553)
- **Mail**: Keep the email list scrollable when the bottom reading pane is enabled with no conversation selected
- **Mail**: Route keyword writes to the email's own account in unified view
- **Mail**: Render emails that set `height:100%` on a wrapper element
- **Mail**: Hide images that fail to load
- **Mail**: Storage quota not shown with Stalwart (#577)
- **Spam**: Hide the spam action in Sent, Drafts and Scheduled
- **Spam**: Fix stale folder counters and open message after spam actions
- **Composer**: Wait for in-flight attachment uploads before sending
- **Composer**: Only commit a recipient on Space when the input is a valid email (#571)
- **Composer**: Attachment reminder now ignores quoted text on reply/forward (#570)
- **Calendar**: Store the event organizer as owner-only to prevent duplicate ORGANIZER/ATTENDEE
- **Calendar**: Strike through cancelled events and mute their reminders (#572)
- **Calendar**: Use `calendarAddress`/`organizerCalendarAddress` for scheduling, drop retired `sendTo`/`replyTo` (#500)
- **Auth**: Keep the session when the auth server is briefly unreachable
- **Shortcuts**: Make keyboard shortcuts layout-agnostic and map by physical position
- **Shortcuts**: Don't toggle mailbox subfolders on Arrow keys while typing
- **Contacts**: Clear the photo on the server by sending `media: null` when removed
- **Plugins**: Preserve the settings slot and privileged tier
- **Pro**: Prompt to save or discard a draft when closing a compose tab via the tab-bar X
- **Pro**: Show the Edit button on draft emails opened in a new tab
- **List**: Shift-click on the checkbox extends the selection (range)
- **CSP**: Allow external/data fonts so email webfonts render
- **Notifications**: Brand push notifications with the configured PWA icon
- **Notifications**: Notification sound preview — base-path prefix and longer default beep
- **Unsubscribe**: Send `mailto:` unsubscribe ourselves instead of via the OS handler
- **Branding**: Apply per-domain favicon override in root metadata (#585)
- **Settings**: Load the trusted-senders address book on the settings page so the count isn't 0
- **Setup**: Clone source when `setup.sh` runs detached from a checkout (#518)
- **Server**: Use a callable `.get` to detect `Headers` in `pickRequestHost`

## 1.7.6 (2026-06-28)

### Breaking Changes

- **S/MIME**: The built-in S/MIME implementation has been removed from core and re-delivered through the new generic crypto plugin hooks (privileged same-origin plugin tier). S/MIME signing, encryption, decryption, certificate management, and the related settings UI now live in a plugin rather than the main app. Deployments that relied on built-in S/MIME must install the S/MIME crypto plugin to retain those features.

### Features

- **Plugins**: Privileged same-origin plugin tier with a crypto API surface
- **Plugins**: Plugin hooks for email details, headers, and source
- **Mail**: Option to hide the total message count on folders (#498)

### Fixes

- **Mail**: Hide the server scheduled folder when the virtual one is shown (#495)
- **Mail**: Stop the unified mailbox from mutating client-returned email objects
- **Composer**: HTML-escape sender and subject in the reply/forward quote header (#482)
- **Calendar**: Send calendar invites by setting `organizerCalendarAddress`
- **Identity**: Sync the default identity (`preferredPrimaryId`) to server settings (#507)
- **Auth**: Support MFA login via the structured auth endpoint
- **Admin**: Show all built-in themes in the admin theme controls (#496)
- **i18n**: Add missing translation keys across 19 locales

## 1.7.5 (2026-06-24)

### Features

- **Mail**: Cross-account "All accounts" views with full group/shared-account support
- **Mail**: Per-account "All Mail" folder selection
- **Mail**: "Download all" button to bundle attachments into a zip (#466)
- **Mail**: Return to the list after deleting or marking the open message unread — configurable (default on)
- **Mail**: Collapse-all-threads action in thread-list selection
- **Calendar**: Option to disable the calendar
- **Composer**: Send-now button on scheduled/delayed messages
- **Composer**: Email a contact or group via the in-app composer
- **Composer**: Split a pasted address list into recipient chips
- **Contacts**: "New address book" creation UI (#415)
- **OAuth**: `OAUTH_AUTHORIZE_URL` to override the authorize endpoint
- **i18n**: Farsi (fa) locale — complete (2654 strings)
- **i18n**: Romanian (ro) locale

### Fixes

- **Composer**: Keep HTML signature styling in the editor and on send
- **Composer**: Guard Send against double-submit
- **Composer**: Strip display names from the `EmailSubmission` envelope addresses
- **Calendar**: Disable iMIP scheduling on calendar import (#411)
- **Mail**: Localize special-folder names by JMAP role (#404)
- **Mail**: Block remaining email tracking vectors (#457)
- **Mail**: Route counter and unread updates to the email's own account in aggregate views
- **Mail**: Fix blank space in plain-text emails
- **Mail**: Fix toolbar re-render when opening emails
- **Mail**: Truncate long subjects so they don't overlap the timestamp
- **Mail**: Strip reply/forward prefixes followed by a full-width colon
- **Mail**: Add breathing room between the unread dot and the avatar
- **Mail**: Isolate per-account state snapshots from leakage and mutation
- **Mail**: Cap filename tokens at the full 200-char limit
- **Spam**: Fetch mailboxes with `accountId` in `markAsSpam`
- **Filters**: Load mailboxes when opened directly (#485)
- **Settings**: Surface server errors on password change and TOTP toggle
- **Send now**: Gate the toolbar label and translate `send_now` across locales
- **Directory**: Fix fetching display names
- **Push**: Reap only relay-confirmed-dead leftover subscriptions
- **i18n**: Add the missing fa locale to the client `IntlProvider` messages map
- **i18n**: Add missing translation keys across 19 locales

## 1.7.4 (2026-06-15)

### Features

- **Mail**: New "All Mail" view across folders and accounts
- **Mail**: Edit contact directly from the email viewer contact sidebar
- **Calendar**: Recurrence editor, set-default calendar, and timezone-aware calendar queries
- **Calendar**: Agenda plugin sidecar
- **Composer**: Email display name support
- **Composer**: Drag-and-drop recipient chips between To/CC/BCC fields, with the address shown in the drag preview
- **Composer**: Avatars in recipient autocomplete suggestions, including directory users
- **Files**: JMAP file/folder sharing in the Files app (#408)
- **Auth**: QR-code SSO login and device pairing between webmail and the mobile app
- **Auth**: Require re-authentication for device pairing and SSO
- **Accounts**: Manage shared/group account settings from the Accounts page
- **Setup**: Opt-in telemetry in the web setup wizard
- **Mail**: Persist the email detail sidebar state

### Fixes

- **Mail**: Preserve line breaks in the generated `text/plain` alternative (#421)
- **Mail**: Fix inconsistent threading of email messages in the inbox and folders
- **Mail**: Stop draft emails from being marked as unread
- **Mail**: Prevent wide email tables from rendering with rotated headers (#409)
- **Mail**: Preserve the folder list when a mailbox refetch hits the concurrent-request limit
- **Mail**: Correct dark-mode background-image inversion and height clipping in the email viewer
- **Calendar**: Dedupe scheduling emails and use Stalwart-compatible calendar filters
- **Calendar**: Redesign the custom recurrence editor to match the modal UI
- **Files**: Don't send the connected-account key as the JMAP `accountId` when sharing files (#408)
- **Routing**: Strip the build-time `basePath` from `router.push` redirects after login (#390)
- **Nav**: Open recent contact emails at `/` instead of 404ing on `/mail`
- **Nav**: Hide the Add App button when `sidebarAppsEnabled` is false
- **Settings**: Move the "Plain Text Only" setting from Reading to Composing (#422)
- **Privacy**: Make telemetry opt-in
- **UI**: Fix the context menu being invisible on first right-click after page load
- **Admin**: Remove the JMAP status from the admin dashboard
- **i18n**: Add missing translation keys across 17 locales

## 1.7.3 (2026-06-04)

### Features

- **Mail**: Inline attachment preview — reliable MIME detection with inline PDF on desktop and mobile
- **Mail**: Preview composer attachments inline (click to open)
- **Mail**: Preview `.eml` (`message/rfc822`) attachments like an email
- **Mail**: Read receipts (MDN, RFC 8098)
- **Mail**: Editable, layout-preserving quote island when replying
- **Mail**: Surface the most severe SPF result and hide the "via" badge on spoofed mail
- **Calendar**: Per-viewer colors for shared calendars (#345)
- **Filters**: Extended filter rules — attachment field and multi-value conditions
- **Settings**: New built-in themes — Aurora Glass and Elastic
- **Settings**: Theme cards render as a mini mailbox mockup from theme colors, with light/dark variant chips
- **Plugins**: Localizable sandboxed plugins (manifest locales + `api.i18n.t`)
- **Plugins**: `/api/translate` proxy and email body exposed to plugins
- **Admin**: Toggle for search-engine indexing (robots)
- **Admin**: `passwordHashFile` in `admin.json`
- **Admin**: `sessionSecretFile` and `oauthClientSecretFile` for file-based secrets in JSON config
- **PWA**: Configurable install screenshots (per-domain)
- **i18n**: Hungarian locale support

### Fixes

- **Files**: Store Files as real `FileNode` hierarchy, migrate legacy flat-named files on load, and list folders via `FileNode/get` so they are visible (#379)
- **Files**: Treat a blob-less `FileNode` as the only folder signal and migrate legacy dir-markers
- **Mail**: Empty Trash for shared and group folders (#387)
- **Mail**: Move mail from a shared group inbox to a personal inbox (#375)
- **Mail**: Preserve the HTML signature when sending a quick reply
- **Mail**: Stop body clipping under the fold when the email sets `html`/`body` `height: 100%`
- **Mail**: Drop single-letter `R:`/`I:` subject prefix tokens and deduplicate localized reply/forward prefixes
- **Mail**: No more 404 console spam for missing sender favicons
- **Auth**: Discover OIDC metadata server-side to avoid CORS failures (#382)
- **Send**: Route the Sent copy to the shared-mailbox account on per-identity send
- **Routing**: Honour `basePath` in the plugin sandbox, `http.post` proxy, and branding
- **i18n**: Localize the PWA install prompt, reply/forward quote header (incl. sender address), `<html lang>`, and per-locale `<head>` description; add missing `settings.folders.role_memos` key
- **Themes**: Plugin slot iframes inherit host font and color tokens
- **Theme**: Gate preview "open in new tab" on inline-safe MIME types
- **Appearance**: Move Themes settings into the Appearance category with a distinct tab icon; clicking the active theme is a no-op
- **UI**: Fix invisible dark-mode borders (border token collided with secondary)
- **UI**: Remove the 16px empty strip beside the collapsed sidebar
- **UI**: Align top bars to a uniform `h-14` height and the account selector header to the search/reply toolbars
- **UI**: Close pane gaps by centering the resize handle on the seam
- **Settings**: Fix section gears permanently hijacking the active tab

## 1.7.2 (2026-05-28)

### Features

- **Mail**: Scheduled send and send delay (#322)
- **Mail**: Drag emails out to the file explorer as `.eml`
- **Mail**: Import emails from `.zip` archives
- **Mail**: "Move to Trash and mark as read" delete action (#323)
- **Mail**: Include group inboxes in the unified mailbox view (#328)
- **Mail**: Locale-aware date format in the email list with a preset picker (#331)
- **Mail**: Allow drag-and-drop into shared mailboxes
- **Composer**: Ctrl/Cmd+Enter sends the open draft
- **Settings**: New Downloads tab with template editor for `.eml` and attachment filenames
- **Settings**: Filename transform settings and an ASCII-only "date (from-to) subject" template
- **Settings**: Post-export action (keep / archive / trash)
- **Settings**: Template for multi-email `.zip` filenames
- **Admin**: Per-domain branding editor with overrides on `/api/config`, manifest, and PWA icon (#332)
- **Admin**: Policy-controlled push relay URL with optional user lock
- **i18n**: `NEXT_PUBLIC_DEFAULT_LOCALE` for fallback UI locale (#243)

### Fixes

- **Mail**: Editable HTML signature in new mail; clean state on every compose entry (#329)
- **Mail**: Report real upload progress with XHR progress events (#333)
- **Mail**: Restore `blob:` in `object-src` and `frame-src` CSP for PDF/HTML previews
- **Mail**: Match user-avatar treatment on quick reply
- **Email viewer**: Stop shattering table cells with `word-break: break-word`
- **Composer**: Scope Ctrl/Cmd+Enter send to the focused composer
- **Composer**: Stop closing the form when editing any field
- **Pro**: Keep the empty viewer pane visible in the split layout
- **Pro**: Prevent an empty main pane when reordering tabs across panes
- **Mobile**: Collapse focus mail layout to multi-line
- **Mobile**: Keep a gutter on bare-HTML and plain-text emails
- **Calendar**: Align continued multi-week events with the week's left edge
- **Calendar**: Show the end date in the event popover for multi-day events (#318)
- **Calendar**: Convert `recurrenceRules` to singular in batch create
- **Calendar**: Handle malformed event dates (#316)
- **Files**: Stop URL-encoding drag-out filenames and preserve Unicode letters
- **Routing**: Prefix remaining `<img>`, favicon, and WebDAV URLs with `basePath` (#319)
- **Routing**: Prefix hand-written URLs with `basePath` for subpath deployments
- **Auth**: `OAUTH_ALLOW_PRIVATE_ENDPOINTS` for split-DNS setups

### i18n

- Add missing translation keys across 16 locales

## 1.7.1 (2026-05-22)

### Features

- **Admin**: Expose PWA branding fields in the admin Branding tab
- **Pro**: Hide empty-state placeholder and collapse the viewer pane in Pro mode so the mail list fills the space

### Fixes

- **Mail**: Preserve inline images when replying (#163)
- **Filters**: Use the canonical `INBOX` mailbox in Sieve filter paths (#313)
- **Mail**: Resolve destination account id to the local namespace on cross-account mailbox drop

## 1.7.0 (2026-05-21)

> **New: Pro mode (experimental).** Opt-in tabbed multi-pane interface for power users. Open multiple mail, calendar, contacts, and file views side-by-side, drag tabs to reorder or split panes at the edges, and work across all logged-in accounts in one shell - cross-account email moves, a unified inbox with search, account-split calendar/contacts/files sidebars, and a per-account "From" dropdown in the composer. Enable from Settings → Appearance; the `proInterface` preference is per-device and not synced.

### Breaking Changes

- **Plugins**: Plugins now run inside a null-origin iframe sandbox and talk to the host over a postMessage RPC bridge. The in-process plugin runtime is gone; the bundled in-tree plugins have been migrated. Third-party plugins built against the old in-process API need to be ported to the sandboxed runtime.
- **Plugins**: Server-managed bundles must be Ed25519-signed by the host and approved by an admin before they load. The host public key is served from `/api/plugin-signing-pubkey` and each bundle response carries the signature in the `X-Bundle-Signature` header. User-uploaded bundles still load unsigned, but managed marketplace and dev-folder bundles do not.
- **Plugins**: `bundleHash` is now a full SHA-256 over the bundle. Legacy short hashes are migrated on first load; any out-of-band tooling that pinned the old hash format needs to be updated.

### Features

- **Pro**: Tabbed shell with drag-to-reorder, drag-to-edge to split, side-by-side panes, and pane-aware responsive layout with a scoped sidebar overlay
- **Pro**: Auto-redirect to the Pro shell when Pro mode is on; `proInterface` is kept per-device instead of syncing
- **Pro**: Multi-account mail sidebar with client routing and a per-account mailbox cache
- **Pro**: Unified mailbox always visible, with full-text search
- **Pro**: Cross-account email moves
- **Pro**: Multi-account calendar sidebar split into owned vs shared per account
- **Pro**: Multi-account contacts and a cross-account file picker
- **Pro**: Composer From dropdown grouped by account
- **Plugins**: Per-plugin admin approval workflow with Ed25519 bundle signing verified on load
- **Plugins**: Marketplace update flow for installed plugins and themes
- **Setup**: Allow the setup wizard over plain HTTP with a dismissable warning gate
- **Setup**: Warn when the JMAP URL points at a local-only host
- **Account**: List and reorder logged-in accounts from settings (#282)
- **Mail**: Mobile handoff page with JMAP authentication verification for cross-device OAuth
- **Mail**: Pluggable reply/forward quote header (#295)
- **Calendar**: Support multiple flexible event reminders (#170)
- **Admin**: Expose PWA, app identity, and extension directory keys in the JSON config (#312)
- **Admin**: Surface OAuth scope settings and wire up orphaned admin policy gates

### Security

- **Plugins**: Pin parent origin in the iframe bridge to block cross-frame postMessage
- **Plugins**: Ignore plugin-supplied `target` in `ui.openExternalUrl` to block host-frame hijack
- **Plugins**: Validate plugin/theme id in marketplace install to block path traversal
- **Plugins**: Prevent plugin config from leaking to non-admin users
- **Admin**: Gate admin routes against cross-origin CSRF
- **Auth**: Bind Stalwart auth context to the credential, not the cookie-claimed username
- **Auth**: Validate OAuth discovery endpoints against SSRF
- **Mail**: Tighten HTML sanitization at plain-text email, signature, and i18n render sites
- **Mail**: Block script-bearing MIME types from inline attachment preview
- **Mail**: Escape print-window fields and re-sanitize body to block XSS
- **S/MIME**: Stop persisting passphrases in `sessionStorage`
- **API**: Correct regex for valid API POST path validation

### Fixes

- **Mail**: Serialize draft autosave with send to stop replies stalling in Drafts (#303)
- **Mail**: Omit empty cc/bcc from `Email/set` so the server does not emit a bare `Cc:` header (#301)
- **Mobile**: Allow adding contacts from the mail recipient popover (#306)
- **Mobile**: Prevent dual-scroll and use full width for mail content
- **Mobile**: OAuth handoff flow
- **Calendar**: Scope iCal subscriptions per JMAP account; fix refresh and clear
- **Calendar**: iCal subscription refresh, rollback, and URL normalization
- **Calendar**: Show avatars in the calendar/address book sharing menu
- **Contacts**: Normalize malformed contact photo data URIs (#307)
- **Identity**: Clear identity signature fields when emptied
- **Identity**: Show size cap on identity signature fields
- **Identity**: Allow table-based layouts in the HTML signature sanitizer
- **Plugins**: Load `globals.css` and Geist font in the plugin sandbox iframe
- **Plugins**: Sync plugin slot iframe height with reported content height
- **Plugins**: Use plugin slot offer snapshots for `useSyncExternalStore`
- **Plugins**: Trust the directory version on marketplace install and update
- **Filters**: Prevent duplication of Bulwark rules with literal braces in values
- **Setup**: Defer setup wizard HTTP detection to avoid hydration mismatch
- **Routing**: Anchor unmatched URLs into `main` so 404 renders
- **Routing**: Respect server-resolved locale on first visit (#309)
- **Routing**: Split app into `(main)`/`(sandbox)` route groups so the plugin iframe hydrates properly
- **Files**: Stop parent directory navigation from jumping to root
- **Build**: Stop pulling `node:dns` into the client bundle via OAuth discovery
- **UI**: Toggle recipient popover when clicking the name again
- **UI**: Remove white halo around photo avatars

### i18n

- Add missing translation keys across 16 locales

## 1.6.7 (2026-05-17)

### Features

- **Contacts**: vCard 4.0 parsing and generation support
- **Admin**: Master-user impersonation route with `app-top-banner` plugin slot rendered on every authenticated page
- **Admin**: Allow admin password overwrite during setup recovery
- **Setup**: HTTPS requirement warning in the setup wizard
- **Mobile**: Show details toggle and expandable panel for sender info

### Performance

- **Calendar**: Speed up calendar invitation banner load

### Security

- **Mail**: Sandbox thread email HTML in `srcDoc` iframe with a CSP `<meta>` tag
- **Admin**: Redact sensitive config secrets from the admin API response
- **Admin**: Make impersonation cookies session-only

### Fixes

- **Auth**: Read `OAUTH_SCOPES` at runtime instead of build time
- **Auth**: Use a relative `Location` header in redirects
- **Auth**: Adopt orphan session cookie on first SPA load
- **Mail**: Per-account push subscriptions so multi-account notifications work (#298)
- **Mail**: Close attachment preview when clicking outside the content area
- **Mail**: Pin quick reply to the bottom for short emails
- **Mail**: Show "no body content" instead of an infinite skeleton for bodyless emails
- **Mail**: Show contact popup when clicking the sender name in the email header
- **Mail**: Prevent long addresses from overflowing email details columns (#297)
- **Mobile**: Align quick reply with the mobile bottom toolbar
- **Mobile**: Respect safe-area insets on mobile bottom bars
- **Mobile**: Pad `safe-area-inset-top`
- **UI**: Apply dark background to the email content wrapper in dark mode
- **UI**: Improve dark mode background colors in the email viewer
- **UI**: Add viewport export with `initialScale: 1`
- **UI**: Strip the Stalwart master-user `%` suffix from the displayed account
- **Plugins**: Warn and block install when the app version is below the plugin's `minAppVersion`
- **Plugins**: Register `app-top-banner` in plugin-store `SLOT_NAMES`
- **Plugins**: Carry `configSchema` + `settingsSchema` through marketplace install
- **Build**: Add `outputFileTracingExcludes` to reduce Turbopack memory tracing

### i18n

- Add missing translation keys across 16 locales

## 1.6.6 (2026-05-15)

### Features

- **Mail**: Sync onboarding completion state across devices so the welcome flow only runs once per account (#285)
- **Mail**: Distinct icons for Shared, Important, Memos, Scheduled, and Snoozed folders (#288)
- **Compose**: Raise HTML identity signature length cap to 50,000 characters
- **Compose**: Allow `<img>` tags in HTML identity signatures for inline logos and banners

### Fixes

- **Files**: Hide Files settings entry and sidebar nav when the `filesEnabled` policy is off (#291)
- **Admin**: Honor the `cookieSameSite` admin config override instead of always defaulting (#284)
- **UI**: Standardize punctuation in tooltips and inline comments across locales

### i18n

- Add Danish localization
- Clean up Danish locale wiring and sort the language picker alphabetically (#286)

## 1.6.5 (2026-05-13)

### Features

- **Protocol**: Register as the system handler for `mailto:` and `webcal:` links from a new protocol handler settings page
- **Protocol**: Account picker for protocol links when multiple accounts are connected
- **Protocol**: Import-or-subscribe choice for detected webcal calendars
- **Protocol**: Reuse the open PWA/session for `mailto:` links instead of always opening a new tab
- **UI**: Route account avatars through the shared `Avatar` component for consistent fallbacks (#278)

### Fixes

- **Calendar**: Support HTTP basic auth in iCal subscription URLs (#275)
- **Admin**: Honor admin-uploaded favicon in root metadata (#274)
- **Admin**: Honor `NEXT_PUBLIC_BASE_PATH` in admin sidebar nav links (#271)
- **UI**: Broaden body font stack so Thai (and other non-Latin scripts) render correctly in subjects, sender names, and other chrome (#265)

## 1.6.4 (2026-05-11)

### Web Setup Wizard

First-launch web setup wizard. New installs no longer need to hand-edit `.env.local` - point a browser at the container and the wizard probes the JMAP server(s), configures OAuth/OIDC, generates the session secret, accepts branding uploads, and provisions the initial admin password. Admin storage is now split into `ADMIN_CONFIG_DIR` (operator-authored, mountable read-only after setup) and `ADMIN_STATE_DIR` (runtime audit log and login timestamps); the legacy `ADMIN_DATA_DIR` keeps working for existing installs.

### Features

- **Setup**: Web setup wizard with multi-step flow: Server, Auth, Security, Logging, Branding, Review, Admin
- **Setup**: Admin config/state directory split with optional `ADMIN_CONFIG_READONLY` for immutable deployments (#226)
- **Setup**: File uploads on the wizard branding step
- **Setup**: Redesigned review step with grouped summary and an advanced toggle for the full config
- **Setup**: Require explicit confirmation when JMAP probe finds no session
- **Mail**: Drag attachments out of the viewer to the local file system (#267)
- **Mail**: Reading Pane at Bottom mail layout (#262)
- **Mail**: Configurable signature position - above or below quoted text (#266)
- **Mail**: Signature position is now searchable from the email behavior settings
- **Mail**: Show avatar in Focused list for compact density and above
- **Mail**: Align Focused list preview with other layout previews
- **Compose**: From-header override in the composer with catch-all auto-reply, replies to an alias on a domain you own pre-fill the alias as the sender even when it isn't a configured identity (#246)

### Performance

- **Mail**: Prefetch initial email data on login
- **Auth**: Parallelize login round-trips and drop redundant JMAP re-verify

### Fixes

- **Auth**: Skip upstream JMAP reverify for trusted URLs (#237)
- **Auth**: Show account identity in the switcher header instead of the sending alias
- **Compose**: Fall back to the primary identity signature on reply
- **Setup**: Drop redundant first-login banner about removing `ADMIN_PASSWORD` (#222)
- **UI**: Consistent notice cards for server probe results

### i18n

- Add missing translation keys across 15 locales

## 1.6.3 (2026-05-08)

### Features

- **Mail**: Lift 5-account cap on HTTP/2
- **Mail**: Import `.eml` files via folder right-click menu

### Fixes

- **Mail**: Trim leading whitespace from email list preview
- **Mail**: Fall back when only the truncation indicator remains in email preview
- **Mail**: Hide files/contacts nav items when JMAP server lacks support
- **Viewer**: Preserve emoji colors in dark mode
- **Viewer**: Prevent white-on-white in dark mode for nested `bgcolor` containers
- **Viewer**: Render plain-text-only emails as text, not HTML
- **Viewer**: Render HTML-only emails and redesign external content prompt
- **Viewer**: Pad Word/Outlook HTML email rendering
- **Compose**: Redesign quick reply to match sender/banner layout
- **Compose**: Disable StarterKit's bundled link/underline to avoid duplicate extensions
- **Sharing**: Request `shareWith` explicitly so calendar/address book shares survive a re-login (#257)
- **UI**: Strip leading punctuation when computing avatar initials
- **Mobile**: Hide email hover actions

### i18n

- Add missing translation keys across 15 locales

## 1.6.2 (2026-05-06)

### Features

- **Plugins**: Hot-reload and dev-folder loading for live plugin development
- **Plugins**: On-demand `src/` bundling via esbuild
- **Plugins**: New `http:fetch` permission and `httpOrigins` manifest field
- **Plugins**: `onBeforeEmailSend` hook with `fromEmail` exposed on `OutgoingEmail`
- **Plugins**: Project `EmailReadView` for the email-banner slot and expose auth results
- **Plugins**: Ingest icon, banner, and screenshots from the source repo
- **Plugins**: Restrict plugin and theme install/uninstall to the admin dashboard
- **Mail**: Multi-server JMAP support
- **Settings**: Fulltext search across the settings sidebar
- **Settings**: Sub-result rows with highlight in settings search
- **Settings**: Surface plugin settings as search sub-results
- **Settings**: Remove experimental tags from themes, plugins, and sender favicons
- **Viewer**: Redesigned external-mail banner above attachments
- **Calendar**: Calendar invitation banner expands on row click
- **Calendar**: Calendar invitation banner is now collapsible

### Fixes

- **Admin**: Collapse admin panel into a single tabbed page
- **Plugins**: Inline plugin configure panel to avoid dev-mode hang
- **Plugins**: Resolve `PLUGIN_DEV_DIR` plugins in admin config route
- **Plugins**: Add missing body type assertion in `createPluginAPI` fetch options
- **Plugins**: Propagate `settingsSchema`
- **Settings**: Highlight plugin and theme cards in search results
- **Settings**: Open plugin card on first click of a setting sub-result
- **Settings**: Drop ghost sub-results from account and language search
- **Settings**: Improve search highlight styling
- **Viewer**: Show notification banners above attachments
- **Viewer**: Rework S/MIME banner to match calendar invitation
- **Viewer**: Close PDF preview on Escape before email viewer
- **Viewer**: Render PDF previews via `<object>` with `blob:` in object-src CSP (#253)
- **Calendar**: Align invitation icon with sender avatar column
- **Calendar**: Fix invitation picker clipping (#250)
- **Auth**: Read `activeAccountId` from authStore in account selectors
- **UI**: Adjust toast item border radius and progress bar styles
- **UI**: Remove fly-in animation from context menu submenus
- **i18n**: Add missing Czech flag icon

### i18n

- Add missing translation keys across 15 locales

## 1.6.1 (2026-05-04)

### Features

- **Updates**: Update-available detection with non-dismissible notice and dev-reload refresh
- **Plugins**: New plugin hooks for compose, attachments, search, lifecycle, and routing
- **Sharing**: Share indicators for calendars and contacts, updated JMAP capabilities (#244)
- **Mail**: Auto-add recipients to trusted senders when replying
- **Identity**: Sanitize identity display name to prevent invalid `From` headers

### Fixes

- **Mobile**: Synchronize mobile submenu view with browser history for better navigation
- **Viewer**: Update email viewer styles to improve overflow handling
- **Auth**: Ensure `cookieSlot` consistency during account updates in auth store
- **Auth**: Thread per-account cookie slot through OAuth flows
- **Calendar**: Square the colored left marker on calendar events
- **About**: Show git commit in About instead of "unknown"

### i18n

- Update mailbox context menu translations across 12 locales

## 1.6.0 (2026-05-01)

### Features

- **Deployment**: Subpath deployment support via `NEXT_PUBLIC_BASE_PATH` environment variable
- **Mail**: Image attachment thumbnails and preview chips
- **Mobile**: Reworked mobile mail viewer toolbar
- **Mobile**: Mobile-friendly settings panel
- **Mobile**: Mobile-friendly admin panel
- **Mail**: Redesigned expanded details panel
- **Mailbox**: Show full path in mailbox context menu header with intelligent path shortening

### Fixes

- **Viewer**: Respect per-email dark mode toggle when "always show in light mode" is on
- **Navigation**: Scroll apps list in navigation rail to prevent overflow
- **Context menu**: Clamp submenu inside viewport
- **Context menu**: Prevent context menu from clipping below viewport
- **Context menu**: Prevent jump and animation on open
- **Mail**: Stop silently destroying emails when trash mailbox isn't found (#195)
- **Mail**: Preserve list scroll position when tagging an email
- **Mail**: Render below-header overflow popup outside clipped row
- **Mail**: Collapse below-header attachments to single row with overflow pill
- **Push**: Fix push preview JMAP query
- **Tour**: Navigate tour to mailbox when starting from another page
- **i18n**: Add `useTranslations` for "selected emails" and "cancel" on email list batch operations

### i18n

- Translate SPF/DKIM/DMARC tooltips
- Add missing keys across 14 locales

## 1.5.4 (2026-05-01)

### Features

- **PWA**: Web push notifications for new inbox mail (#233), with click-through to open the message
- **Composer**: Insert and edit tables in rich-text emails (#236)
- **Mail**: Configurable sub-addressing delimiter character (#239)
- **i18n**: Turkish localization
- **i18n**: Missing keys filled in across 15 locales

### Fixes

- **Mail**: Set In-Reply-To and References headers on replies (#234)
- **Mail**: Persist htmlBody in drafts to preserve rich formatting (#236)
- **Auth**: Pin JMAP auth verification to the configured server URL (#237)
- **Auth**: Evict unrecoverable basic-auth accounts on reload
- **Notifications**: Scope new-mail notifications to genuine inbox deliveries
- **Notifications**: Extend PushVerification timeout and clean up leftover subscriptions
- **Viewer**: Smooth out body load to prevent flicker on first render
- **Viewer**: Prevent iframe flash when loading images or trusting the sender
- **Viewer**: Pad bare HTML emails like plain-text mails for consistent layout
- **Viewer**: Light-mode override now only affects body content
- **Viewer**: Detect `<style>` tag when applying padding
- **Viewer**: Drop iframe border-radius
- **Calendar**: Localize event start date in detail popover and event modal
- **Dev**: Include http protocol in connect-src for development mode CSP

## 1.5.3 (2026-04-28)

> **New:** Help shape Bulwark Webmail. Each instance now sends a lightweight daily heartbeat (version, platform, bucketed account counts, feature toggles - never message data or PII) so we can see which platforms and features actually get used and prioritize fixes where they matter most. You're in control: opt out any time from **Admin → Telemetry** or by setting `BULWARK_TELEMETRY=off`. Full schema in the [privacy notice](https://bulwarkmail.org/docs/legal/privacy/telemetry).

### Features

- **Telemetry**: Anonymous instance telemetry, on by default. Reports schema version, platform, bucketed account counts, and feature toggles only - disable from the admin UI, with `BULWARK_TELEMETRY=off`, or by clearing the endpoint
- **Telemetry**: Track unique logins (HMAC'd per instance, 90-day retention) so the heartbeat can report bucketed account totals without storing usernames
- **Plugins**: Theme API v2 with token compiler and skin slot
- **Plugins**: Extension preview page and detailed extension info API
- **Calendar**: Right-click context menu on empty calendar space
- **Docker**: Persistent named volume for telemetry data so the instance id and admin's consent choice survive container upgrades

### Fixes

- **Security**: Block telemetry endpoint from pointing at internal/loopback hosts (validation + DNS-rebind re-check at fetch time)
- **Security**: Harden plugin config, TOTP token exchange, and branding file serving
- **Mail**: Batch shortcuts now act on the multi-selection when one is present (#228)

## 1.5.2 (2026-04-27)

### Features

- **Plugins**: New `composer-sidebar` slot and `ui:composer-sidebar` permission - plugins can now render a panel on either side of the New Message dialog. See `repos/subway-surfers` for an example
- **Plugins**: Manifests can declare `frameOrigins` - a strictly-validated list of `https://host` origins the plugin needs to embed. The proxy reads the union from enabled plugins and merges it into the host CSP `frame-src`, so the host CSP no longer needs to know about specific embed providers
- **Calendar/Contacts**: JMAP sharing for calendars and address books
- **i18n**: Czech language support

### Fixes

- **Security**: Validate URLs before outbound fetch
- **Calendar**: Prevent drag creation on touch events in the time grid
- **Contacts**: Emit RFC 9553 name kinds and decode QUOTED-PRINTABLE in vCard import (#224, #187)
- **Mail**: Hide preview line in compact density to match settings preview (#223)
- **Proxy**: Inline matcher for Next.js proxy and drop unnecessary Node.js runtime config
- **i18n**: Portuguese fixes for "ficheiro" and "contactos" variants

## 1.5.1 (2026-04-25)

### Features

- **Stalwart**: OAuth auto-setup with dialog and validation for origin and issuer URLs
- **Mail**: Right-click context menu on the folders sidebar
- **Mail**: Replace folder `prompt()` calls with a proper modal dialog
- **Calendar**: Add 'Today' button to the desktop calendar toolbar
- **Junk**: Setting to show avatars in the Junk folder (off by default)

### Fixes

- **Admin**: Restore admin panel after Stalwart v0.16 REST API removal
- **Viewer**: Restore broken viewer toolbar actions and improve the mobile menu (#220)
- **Folders**: Stop flicker on background folder refresh
- **Email**: Preserve search/filter on batch move and archive
- **Email**: Preserve search/filter when moving emails via drag-drop
- **i18n**: Improve Korean flag

## 1.5.0 (2026-04-22)

### Breaking Changes

- **Self-service portal now needs Stalwart 0.16+**: Stalwart dropped its self-service HTTP API in 0.16.0 and replaced it with JMAP. Bulwark Webmail only talks to the new JMAP endpoint, so the self-service portal (account settings, app passwords, API keys) requires Stalwart 0.16 or newer. `STALWART_API_URL` is deprecated, these actions go through the normal JMAP session.

### Features

- **Stalwart**: Migrate Stalwart management API to JMAP `x:` methods for Stalwart 0.16
- **Admin**: Add API Keys management and IP allowlist for App Passwords
- **Contacts**: Revamp contact detail view with filters, photo, print, and duplicate actions
- **Contacts**: Add contact activity component showing recent emails and upcoming events
- **Contacts**: Add right-click context menu
- **Contacts**: Group contacts by first letter with sticky section headers, toggleable in settings
- **Calendar**: Support resizing events from the top edge
- **Calendar**: Add timezone-aware formatting for event start times and update `utcEnd` on duration change
- **Calendar**: Optimize layout of overlapping events
- **Calendar**: Add collapsible details to calendar invitation banner
- **Email**: Implement batch archiving and bulk moving of emails
- **Email**: Show full folder path in move/drop toast
- **Settings**: Reorganize settings into 6 groups with clearer tabs
- **Navigation**: Add account-addition button to the navigation rail
- **Mobile**: Streamline email viewer header layout
- **Mobile**: Pass `isMobile` through calendar views and time-grid interactions

### Fixes

- **Mailbox**: Retry mailbox fetch on first login to handle lazy provisioning (#217)
- **Mailbox**: Use fresh state in archive handling to avoid stale mailbox data
- **Mailbox**: Improve error message on mailbox creation failure
- **Auth**: Skip `checkAuth` on route change when already authenticated
- **Auth**: Clean up unused imports and improve TOTP QR code rendering
- **UI**: Align hover styles and selection-toggle target with focused item
- **UI**: Read `matchMedia` synchronously on client to prevent layout flicker

### Refactor

- **Settings**: Remove Stalwart API URL configuration (now derived via JMAP)

### Chore

- **i18n**: Add missing translation keys
- **Deps**: Bump dependencies to latest compatible versions

## 1.4.14 (2026-04-16)

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@mkorthaus-private](https://github.com/mkorthaus-private)
- [@boris22100](https://github.com/boris22100)

**Monthly**

- [@pr0ton11](https://github.com/pr0ton11)

### Features

- **Email**: Add unified mailbox across accounts and sidebar icons toggle
- **Email**: Enhance email deletion and spam handling with improved parameterization
- **Sieve**: Enhance external rule handling in parser and store (#201)
- **Plugins**: Add i18n API, render hooks, and new intercept hooks to plugin system
- **PWA**: Dynamic PWA manifest with configurable name, description, and icons
- **PWA**: Show app name and logo in install prompt
- **i18n**: Add Ukrainian language with flags and missing translation keys
- **i18n**: Configurable locale prefix via `NEXT_PUBLIC_LOCALE_PREFIX`
- **API**: Add `apiFetch` helper for mount-prefix-aware API calls

### Fixes

- **Calendar**: Send iMIP invitation emails when creating or updating calendar events (#192)
- **Calendar**: RFC 5545/6047 compliance for outgoing iMIP calendar emails
- **Calendar**: Add `calendarAddress` and `replyTo` to participants for Stalwart compatibility (#189, #192)
- **Calendar**: Improve CalDAV task detection for external clients like Thunderbird (#84)
- **Email**: Hide ICS attachments from attachment list when invitation banner is shown
- **Email**: Send before storing in Sent via `onSuccessUpdateEmail` (#188)
- **Email**: Standardize tag naming and fix unknown keyword display (#184, #185)
- **i18n**: Skip intl middleware for paths already containing a locale prefix
- **Docs**: Document PWA and branding env vars in `.env.example`
- **Docs**: Use `company` consistently in `.env.example` branding comments

## 1.4.13 (2026-04-12)

Thank you for your donations:

**One-time**

- [@boris22100](https://github.com/boris22100)
- [@mkorthaus-private](https://github.com/mkorthaus-private)

**Monthly**

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

### Features

- **Contacts**: Store trusted senders in a dedicated JMAP address book (#176)
- **Email**: Warn on send when attachment keyword found but no file attached (#172)
- **Email**: Enable keyword reordering (#174) and multi-tag support per email (#173)
- **PWA**: Add "don't remind me again" option to install prompt
- **Auth**: Add `SESSION_SECRET_FILE` and `OAUTH_CLIENT_SECRET_FILE` environment variable support
- **Plugins**: Add `onAvatarResolve` plugin hook
- **Docker**: Publish main and dev branches as separate GHCR packages

### Fixes

- **Email**: Style links in plain text emails
- **Email**: Seed list history entry when app initializes on an email view
- **Email**: Remount composer on draft edit and preserve identity (#60)
- **Contacts**: Display contact names stored in `name.full` (#179)
- **Contacts**: Fix category dropdown blocking Save button in contact form (#177)
- **Contacts**: Resolve TS error from optional `name.components` in vCard parser
- **Search**: Search all folders when filtering emails by tag (#175)
- **Auth**: Include mount prefix in SSO redirect URI when app is served under a subpath
- **PWA**: Correct PWA icons with proper sizing, transparency, and dark/light mode support

## 1.4.12 (2026-04-09)

Thank you for your donations:

**One-time**

- [@mkorthaus-private](https://github.com/mkorthaus-private)

**Monthly**

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

### Features

- **PWA**: Add PWA support with service worker and install prompt
- **Calendar**: Add birthday calendar feature with settings and localization
- **Calendar**: Clamp February 29 birthdays in non-leap years
- **Identity**: Add automatic identity synchronization (#167)
- **Plugins**: Disable plugins by default and require admin approval
- **Plugins**: Replace auth header exposure with a secure HTTP proxy API for plugins
- **Auth**: Add configurable OAuth scopes and cookie security via environment variables
- **Email**: Sync mail view to browser history for back/forward navigation
- **Contacts**: Add ability to rename address books (#152)
- **UI**: Add version badge in settings
- **i18n**: Add Latvian (lv) locale support
- **i18n**: Add Polish language support
- **i18n**: Add Korean language support
- **i18n**: Add Simplified Chinese (zh_CN) locale support

### Fixes

- **Email**: Show recipient instead of sender in Sent and Drafts folder lists
- **Email**: Embed dropped images as data URLs and prevent duplicate attachments (#163)
- **Email**: Fix logic for marking email as read in EmailViewer
- **Email**: Fix archive action passing MouseEvent as argument
- **Mailbox**: Preserve search filters on push-triggered mailbox refresh (#164)
- **Mailbox**: Align shared account folders with primary folders (#151)
- **Mailbox**: Fetch mailboxes on mount in FolderSettings when store is empty
- **Mailbox**: Improve mailbox deletion error handling
- **Calendar**: Improve calendar event retrieval by batching requests to avoid server limits (#141)
- **Calendar**: Compute per-occurrence UTC start/end in recurrence expansion (#116)
- **Calendar**: Guard against undefined trigger in calendar event alert popover (#143)
- **Files**: Stream WebDAV PUT uploads to avoid buffering in memory (#162)
- **Files**: Prune recent files against server nodes on refresh (#146)
- **Files**: Fix file deletion logic to update recent files and handle errors (#146)
- **Files**: Extend file drop zone to fill remaining viewport height
- **Files**: Fallback to application/octet-stream for long MIME types
- **Security**: Replace unguarded crypto.randomUUID() with safe generateUUID() utility
- **Security**: Validate plugin HTTP post URL against origin with regression tests
- **Security**: Allow blob images in CSP for inline drag-and-drop (#163)
- **Auth**: Resolve settings sync identity mismatch for OAuth/SSO sessions (#127)
- **Contacts**: Fix address book ID namespacing for shared contacts in create and update operations (#133)
- **UI**: Fix focused mode expanding beyond screen bounds (#156)
- **API**: Handle 403 on principal fetch without console error
- **API**: Enhance error handling in Stalwart API responses

## 1.4.11 (2026-03-31)

### Features

- **Logging**: Add logging categories for better log management

### Fixes

- **Security**: Harden security with CSP enforcement, SSRF redirect validation, reenabled S/MIME chain verify, IP spoofing prevention, and PDF iframe sandbox
- **Security**: Harden proxy authentication and SSRF defenses
- **Security**: Block plugins with dangerous JS patterns and enforce strict session secret length validation
- **S/MIME**: Add self-signed certificate detection and update status messages for S/MIME signatures
- **Email**: Auto-focus input fields in email composer for improved user experience (#126)
- **Mailbox**: Prevent orphaning of nested mailboxes by restricting deduplication to root-level folders
- **JMAP**: Strip server-immutable fields from updates before sending to JMAP (#128)
- **Files**: Update file feature disabled messages and add stability warnings
- **i18n**: Add missing translation keys to all non-English locales

## 1.4.10 (2026-03-31)

### Features

- **Plugins**: Add plugin configuration UI with schema-driven admin config page, calendar event action slot, and Jitsi Meet plugin
- **Calendar**: Implement client-side recurrence expansion for calendar events
- **Calendar**: Add iCal subscription editing and batch event import
- **Calendar**: Add hover preview settings and functionality
- **Calendar**: Add virtual location input for calendar events (#121)
- **Email**: Add reply-to addresses support in email composer
- **Email**: Add mail layout settings and update email list components
- **Email**: Add auto-select reply identity feature with settings and localization
- **Email**: Enhance compose functionality with button integration and translations
- **Filters**: Preserve activation state when updating or creating Sieve scripts to avoid deactivating server-managed vacation scripts
- **Filters**: Skip server-managed vacation script in Sieve script handling
- **Settings**: Add support for custom JMAP server endpoints in login and settings
- **Settings**: Add folder expansion state management and settings navigation
- **UI**: Add options to hide account switcher and show account avatars on navigation rail
- **i18n**: Add JMAP server endpoint labels and hints in multiple languages
- **i18n**: Add missing translation keys to all non-English locales

### Fixes

- **Security**: Patch critical auth bypass and credential leak vulnerabilities
- **Security**: Support 3DES S/MIME decryption by importing legacy RSAES-PKCS1-v1_5 keys and add diagnostic logging (#35)
- **Security**: Account isolation, auto-import signer certs, and no-key error handling (#35)
- **Calendar**: Fix JSCalendar 2.0 recurrenceRule single-object compatibility (#116)
- **Calendar**: Enhance calendar event handling to distinguish between events and tasks
- **Calendar**: Link existing events to target calendar during iCal import instead of skipping (#113)
- **Calendar**: Deduplicate UIDs during iCal import to prevent mass failures (#113)
- **Calendar**: Fix events disappearing after iCal import/subscription refresh
- **Calendar**: Enhance calendar event handling with full-day detection and layout adjustments
- **Calendar**: Use UTC timestamps for timed event rendering
- **Calendar**: Work around Stalwart not returning Task objects via CalendarEvent/query
- **Email**: Enhance email loading and deduplication logic in email store (#119)
- **Email**: Ensure draft editing function is called correctly in EmailViewer component (#60)
- **Email**: Match hover action background to selected row state
- **Email**: Align tag counts with mailbox folder counts in sidebar
- **Auth**: Handle 2FA/TOTP session expiry with basic auth (#117)
- **Mailbox**: Improve mailbox tree logic and enhance mailbox handling with logging (#118)
- **UI**: Improve dark mode handling for media elements and background images
- **UI**: Adjust account list spacing and remove push connection indicator
- **UI**: Fix nested button in theme card

## 1.4.9 (2026-03-27)

### Features

- **Admin**: Add Stalwart admin authentication, sidebar access, and a reorganized dashboard with dedicated policy sections
- **Plugins**: Add plugin/theme admin dashboard, harness tooling, forced enable or disable controls, managed policy enforcement, and a resizable detail sidebar
- **Filters**: Add vacation responder management with Sieve generation and parsing, UI integration, and improved sync preservation
- **Email**: Add plain text only composer mode, optional conversation threading disable, configurable hover action placement, and OAuth app password support
- **UI**: Add drag-and-drop customization for sidebar apps
- **Files**: Use dynamic server-configured maximum upload sizes
- **i18n**: Add Russian locale support and complete missing translation strings for recent task features

### Fixes

- **Calendar**: Improve date parsing and event normalization, prevent calendar page re-render loops, ensure unique ICal subscription IDs, and create all-day events with correct JSCalendar midnight handling
- **Email**: Respect the configured mark-as-read delay in EmailViewer and fetch full email content when needed while editing drafts (#60, #95)
- **Auth**: Improve network error handling, add JMAP rate limiting handling, and enhance settings retrieval and persistence diagnostics (#100, #104)
- **UI**: Improve mobile layout behavior on contacts and calendar pages (#103)
- **Themes**: Repair theme ZIP bundle handling and enforce admin theme locks correctly
- **Code Quality**: Resolve outstanding ESLint warnings across the codebase

## 1.4.8 (2026-03-23)

### Features

- **Email**: Add support for marking emails as answered or forwarded and display status icons in email list and thread views
- **Email**: Enhance identity selection by supporting sub-addressing (plus addressing) in email composer
- **Settings**: Add notification settings with sound picker, preview playback, and configurable alert sounds
- **Settings**: Add default mail program settings with localization support across all locales
- **Auth**: Implement path prefix handling for OAuth callbacks and login redirects, enabling reverse proxy deployments
- **Validation**: Add all multi-part TLDs for domain validation in favicon API (#81)

### Fixes

- **Calendar**: Fix bugs in duration parsing, RFC compliance, and event handling across calendar components
- **Calendar**: Detect tasks created by external CalDAV clients such as Thunderbird
- **Settings**: Enhance account settings with username and authentication method display (#90)

## 1.4.7 (2026-03-21)

### Features

- **Calendar**: Add task management features with task creation, editing, and status tracking
- **Calendar**: Add option to show week numbers in mini-calendar
- **Email**: Add resizable image component and rich text editor with image upload support
- **Files**: Support uploading folders via drag-and-drop and toolbar button
- **Filters**: Add expanded visual view for filter rules
- **Auth**: Add non-interactive SSO login flow for embedded/iframe deployments (#69)
- **DevOps**: Add separate Docker build workflow for releases and dev branch images

### Fixes

- **Calendar**: Handle updates and deletions for synthetic JMAP IDs in calendar events with fallback to destroy and recreate
- **Security**: Extend CryptoEngine to support legacy algorithms and integrate with LinerEngine for decryption
- **Auth**: Refactor logout to use synchronous flow with full page redirect
- **Email**: Update iframe sandbox attributes to allow popups to escape sandbox
- **i18n**: Add missing translation keys across all locales
- **Docker**: Update .env.example to clarify Docker volume mounting for settings data directory

## 1.4.6 (2026-03-21)

### Features

- **Demo**: Add full demo mode with fixture data for emails, calendars, contacts, files, filters, identities, mailboxes, and vacation responses
- **Demo**: Implement JMAP client interface abstraction to support demo and live backends
- **Contacts**: Add no-category filter, drag-and-drop to category, and category combo box in contact form
- **Email**: Add hover actions for emails with configurable quick-action buttons
- **Settings**: Implement keyword migration functionality for upgrading legacy email tags
- **Security**: Enhance S/MIME certificate extraction and add legacy PBE (password-based encryption) support
- **Tour**: Add interactive guided tour overlay for new user onboarding

### Fixes

- **Settings**: Add missing `showTimeInMonthView` and `showOnMobile` type definitions to settings store
- **UI**: Adjust padding and size of sidebar buttons for improved layout

## 1.4.5 (2026-03-20)

### Features

- **Calendar**: Add prev/next navigation buttons and date label to desktop calendar toolbar
- **Calendar**: Add pending event preview functionality to calendar views and event modal
- **Calendar**: Add setting to show event start time in month view
- **Contacts**: Implement pagination for fetching contacts with maxObjectsInGet capability
- **Email**: Add attachment position setting in email settings
- **Layout**: Add mobile visibility toggle for sidebar apps
- **Error**: Add NotFound component to handle 404 errors and redirect unauthenticated users

### Fixes

- **Auth**: Enhance account switching logic and clear stores on account change
- **Auth**: Improve account restoration logic and handle stale accounts
- **Auth**: Improve draft handling in email composer and enhance session cookie verification
- **Calendar**: Expand recurring events in CalendarEvent/query so individual occurrences are returned (#65)
- **Calendar**: Validate event start field when fetching calendar events
- **Calendar**: Auto-scroll agenda view to today's events and include today's date in groups
- **Calendar**: Correct JSX syntax in CalendarToolbar component
- **Dependencies**: Update flatted to 3.4.2
- **DevOps**: Use native ARM runners instead of QEMU for Docker builds
- **DevOps**: Enhance health check with detailed memory diagnostics and stable liveness probe

## 1.4.4 (2026-03-19)

### Features

- **Calendar**: Implement CalDAV discovery API with automatic calendar home resolution for multi-account setups
- **Calendar**: Enhance calendar management settings with mailbox role reassignment controls
- **Email**: Add signature rendering utilities with HTML-to-text conversion and sanitization

### Fixes

- **Auth**: Fix account session handling to update existing accounts instead of duplicating entries
- **Auth**: Fix logout redirects and unauthenticated home page rendering
- **Calendar**: Fix duplicate calendar edits and prevent double-save submissions in event modal
- **Calendar**: Remove stale calendar ID references in favor of CalDAV-discovered IDs
- **Contacts**: Improve RFC 9553 compliance for contact birthdays and address formatting
- **Email**: Fix email signature rendering for identity signatures
- **Folders**: Improve mailbox role management by clearing roles from all mailboxes before reassigning

## 1.4.3 (2026-03-19)

### Features

- **Auth**: Implement multi-account support with up to 5 simultaneous accounts and instant switching
- **Auth**: Add account switcher component with connection status, default account selection, and per-account logout
- **Auth**: Support multi-account OAuth and basic auth with per-account session persistence
- **Contacts**: Enhance contacts sidebar with collapsible sections, bulk operations, and address book grouping
- **Contacts**: Add contact import functionality and keyword filtering
- **Settings**: Add per-account encrypted settings storage with server-side sync support

### Fixes

- **UI**: Adjust popover alignment in sub-address helper component
- **Settings**: Improve error logging in settings sync functionality

## 1.4.2 (2026-03-19)

### Features

- **Calendar**: Add task list view for calendar tasks with task details and management
- **Calendar**: Add shared calendar grouping with visual separation in sidebar
- **Calendar**: Support double-click to create events and improve modal date handling
- **Contacts**: Add address book directories with drag-and-drop and editor picker
- **Email**: Add email attachment support in sendEmail functionality
- **Email**: Implement draft editing functionality across email components
- **Email**: Implement unwrapping of embedded message/rfc822 attachments with enhanced HTML body validation
- **Email**: Add email export/import localization keys for multiple languages
- **Contacts**: Update gender handling to use speakToAs structure

### Fixes

- **Email**: Resolve default sender to canonical identity on local-part login
- **Email**: Refactor overflow handling in EmailViewer to use hidden priorities and layout effects
- **Email**: Remove debugMode usage from EmailViewer component
- **Calendar**: Enhance IMIP invitation and cancellation handling for calendar events
- **Calendar**: Add time-based sorting for events in buildWeekSegments function
- **Dependencies**: Update dompurify to 3.3.3 and elliptic to 6.6.1, add undici override

## 1.4.1 (2026-03-18)

### Features

- **Security**: Add S/MIME certificate management with identity bindings, signer auto-import, unlock controls, and compose/viewer sign, encrypt, decrypt, and verification flows
- **Email**: Add TNEF (`winmail.dat`) parsing to extract message bodies and attachments from Outlook rich-text emails
- **Email**: Add archive organization modes for archiving directly or into year/month subfolders
- **Email**: Add an "Always Show Emails in Light Mode" preference to avoid dark-mode conversion issues
- **Email**: Apply the 12-hour or 24-hour time format preference consistently across calendar and email surfaces
- **Identity**: Add identity refresh behavior in the identity manager so server-side changes stay in sync after edits
- **UI**: Add configurable sidebar apps with custom icons plus inline or new-tab launch modes
- **Branding**: Add runtime branding options for custom favicon, sidebar logos, and login logos
- **Deployment**: Add configurable server listen address support via `HOSTNAME`, including IPv6 and dual-stack guidance

### Fixes

- **Calendar**: Improve all-day event handling
- **Calendar**: Validate and default persisted calendar view mode values
- **UI**: Use configured app names more consistently in metadata and login branding surfaces
- **Docker**: Correct `HOSTNAME` formatting in the Docker Compose example
- **Metadata**: Correct package author and container vendor metadata

## 1.3.0 (2026-03-16)

### Features

- **Calendar**: RSVP support for calendar invitations with trust assessment
- **Calendar**: iCal/webcal subscription support
- **Calendar**: Create, update, and delete calendar events
- **Calendar**: Enhanced EventModal with alert and recurrence labels, view/edit mode toggle
- **Email**: Iframe-based email rendering with smart dark mode support
- **Email**: Security tooltips, contact actions, and scroll improvements in email viewer
- **Email**: Improved message details and contact sidebar in email viewer
- **Email**: Move-to mailbox functionality in email viewer
- **Email**: Mobile bottom action bar with reply and email navigation
- **Email**: Auto-fetch full email content when an email is auto-selected
- **Email**: Unread filter functionality in mailbox sidebar
- **Email**: Empty folder functionality for junk and trash mailboxes with confirmation dialog
- **Files**: JMAP FileNode file storage backend and file settings
- **Files**: File preview support
- **Contacts**: Enhanced contacts management with sidebar and selection features
- **Contacts**: Import/export functionality in contacts settings
- **Contacts**: Improved contact group management with UID normalization
- **Settings**: Tab icons and grouping with improved file settings preview
- **Settings**: Extra-compact density option and font size scaling
- **Settings**: Logout button in settings
- **UI**: Sidebar resizing across calendar, contacts, and settings pages
- **UI**: Keyboard shortcuts button and show/hide toolbar labels option
- **UI**: Recursive depth calculation for mailbox tree structure
- **UI**: Mobile long-press context menu
- **i18n**: Expanded supported locales
- **API**: Enhanced configuration fetching with retry logic
- **License**: Updated to AGPL-3.0-only with NOTICE file for fork lineage

### Fixes

- **Calendar**: Correct all-day multi-day event rendering
- **Email**: Adjust text wrapping for email subject in EmailViewer and ThreadConversationView
- **Email**: Adjust email content area layout for better responsiveness
- **Email**: Sync identity stores and append signatures to outgoing emails (#15)
- **Contacts**: Handle non-string anniversary dates in contact detail
- **UI**: Fix nested button hydration error in sidebar mailbox tree
- **UI**: Update sidebar border styling for consistency across pages
- **UI**: Update avatar background color logic based on image source
- **UI**: Make density setting functional across entire UI

## 1.2.4 (2026-03-14)

### Features

- **Tags**: Show total and unread email counts next to each tag in the sidebar
- **Tags**: Instant tag count refresh after adding or removing a tag
- **Search**: Wildcard query functionality for enhanced search capabilities
- **Search**: Support OR conditions across multiple fields in email search
- **Search**: Improved search results display with pluralization and localization
- **Email**: Dropdown menus for actions in email viewer
- **Email**: Improved email list messages for clarity and localization
- **Email**: Enhanced unsubscribe banner with destructive color styling
- **Auth**: Centralized Stalwart credentials management
- **Login**: Configurable logo with light/dark mode support
- **Avatar**: Dev mode configuration for profile picture retrieval
- **DevOps**: Added `.env.dev.example` for development configuration

### Fixes

- **Email**: Prevent browser auth dialog when viewing emails with inline images
- **Login**: Optimize theme store usage with shallow comparison
- **Git**: Add local private data directory to `.gitignore`

## 1.2.3 (2026-03-13)

### Features

- **Calendar**: Hover functionality for calendar events with preview popover
- **Contacts**: Enhanced contact management and vCard support
- **Email**: Tagging system with color labels and drag-and-drop tag support
- **Email**: Multi-select with checkbox functionality and batch operations
- **Email**: Recipient popover for contact interaction
- **Email**: Inline search filters and folder icon picker
- **Email**: Sender favicon avatars with negative caching for performance
- **Email**: Print functionality for email content
- **Folders**: Folder management settings with CRUD, standard role assignment, and icon picker
- **Folders**: Subfolder creation and hierarchical navigation
- **Settings**: Settings synchronization with server (encrypted API endpoints)
- **Settings**: Toolbar position customization and mobile layout tabs
- **Settings**: Login page customization options
- **Account Security**: Stalwart account security management panel
- **OAuth2/OIDC**: OAuth-only login mode
- **UI**: Resizable columns, navigation rail overhaul, and drag-and-drop email organization
- **UI**: Toast notifications with enter/exit animations and progress bar
- **UI**: Responsive mobile layout with bottom tab bar and tablet support
- **i18n**: Added Dutch and Portuguese translations (now 8 languages)
- **Docker**: Publish only to GHCR, remove Docker Hub
- **DevOps**: Interactive setup script with dry-run option and JMAP server URL validation
- **Branding**: New Bulwark Webmail identity with logo assets and light/dark mode support

### Fixes

- **Sieve**: Use `onSuccessActivateScript` for sieve activation (#21)
- **Composer**: Fix trailing comma handling in recipient input
- **Email**: Fix print functionality for email content
- **Connection**: Connection loss handling with session recovery
- **Redirect**: Login redirect functionality with sessionStorage error handling

## 1.1.2 (2026-03-02)

### Fixes

- **Context menu**: Fix "Move to folder" submenu closing when scrolling the folder list or moving the mouse to the submenu (#19)
- **Move to folder**: Fix emails not actually moving on the server - JMAP response errors were silently ignored and shared account IDs were not resolved correctly
- **Dependencies**: Update tailwindcss, lucide-react, @tanstack/react-virtual, @typescript-eslint/\*, globals, @types/node

## 1.1.1 (2026-02-28)

### Fixes

- **Email viewer**: Show/hide details toggle now stays in place when expanded instead of jumping to the bottom of the details section (#18)
- **Email viewer**: Details toggle text is now properly translated (was hardcoded in English)
- **Instrumentation**: Resolve Edge Runtime warnings by splitting Node.js-only code into a separate module
- **Security**: Patch minimatch ReDoS vulnerability (CVE-2026-27903) - upgrade 9.0.6→9.0.9 and 3.1.3→3.1.5

## 1.1.0 (2026-02-28)

- Server-side version update check on startup (logs when a newer release is available)

## 1.0.2 (2026-02-27)

- Fix 4 CVEs in production Docker image (removed npm, upgraded Alpine packages)

## 1.0.1 (2026-02-26)

- Remove stale references, clean up README

## 1.0.0 (2026-02-25)

- Initial public release
