**Describe the bug**
When using JMAP Calendars, if an internal user creates an event on a Shared Group / Mailbox calendar that they are a member of, and invites themselves (or vice versa), Stalwart silently suppresses the internal iTIP scheduling message. 

Because Stalwart treats the shared group's address as an alias of the authenticated user's account, the internal scheduling engine hits the `// Do not send invite to self` guard clause and drops the iTIP `REQUEST`. This prevents standard calendar invitation workflows (accept/decline) between users and the shared groups they manage.

**To Reproduce**
Steps to reproduce the behavior:
1. Create a User A (e.g. `user@example.com`).
2. Create a Shared Group / Mailbox G (e.g. `shared-group@example.com`).
3. Grant User A access to Group G so that User A can manage G's calendars.
4. User A authenticates via JMAP (using `user@example.com` credentials).
5. User A creates a `CalendarEvent/set` targeting Group G's `accountId`, passing `sendSchedulingMessages: true`.
6. Set the Organizer to Group G (`shared-group@example.com`) and add User A (`user@example.com`) as an Attendee.
7. Observe that the event is created in Group G's calendar, but no iTIP message is delivered to User A's inbox or calendar.

*Note: The exact same failure occurs if User A is the Organizer and Group G is the Attendee.*

**Expected behavior**
Stalwart should generate an internal iTIP `REQUEST` message and route it to the attendee so they can formally Accept/Decline the event, updating the participation status on the organizer's calendar.

**Technical Root Cause**
In `crates/groupware/src/scheduling/organizer.rs`, the scheduling engine evaluates if the attendee is the organizer to avoid sending invites to "self":
```rust
if account_info
    .addresses()
    .iter()
    .any(|a| a.eq_ignore_ascii_case(&attendee_email))
{
    continue; // Do not send invite to self
}
```
Because the JMAP request is authenticated as User A, `account_info` belongs to User A. Since User A manages Group G, Stalwart's directory includes `shared-group@example.com` in User A's `account_info.addresses()`. 
Consequently, `attendee_is_organizer` evaluates to `true` (since both the sender and recipient are in the same `account_info` alias list) and the invite is intentionally dropped.

While this logic correctly prevents sending redundant invites to a user's primary aliases, dropping invites to/from Shared Mailboxes prevents teams from scheduling meetings on shared calendars using standard iTIP workflows.

**Environment details:**
- OS: Debian GNU/Linux 13
- Stalwart Mail Server Version: (Latest / default from JMAP implementation)
- Client: Bulwark Webmail (JMAP client)
