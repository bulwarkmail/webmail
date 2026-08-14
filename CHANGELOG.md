# Changelog

## Recent Commits by Michael

### 2026-08-14
* **fix(calendar): improve shared calendar delegation and RSVP UX** (3006ad87)
  - Implemented comprehensive automated tests for calendar delegation scenarios.
  - Added support for generating events in delegated calendars properly by addressing JMAP `accountId` resolution.
  - Addressed edge cases in calendar event creation when the event is created on behalf of another user.

### 2026-08-13
* **Fix replyTo object iteration crash** (7b689a49)
  - Fixed a client-side crash in the webmail related to iterating over the `replyTo` object during calendar event processing.
