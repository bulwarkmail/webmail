# Calendar Delegation & RSVPs: Manual Testing Guide

This guide provides step-by-step instructions for manually verifying the calendar scenarios directly in the Bulwark Webmail interface. Follow these steps to confirm the automated test results match your real-world experience.

---

## 🗂️ Scenario 1: Standard RSVP (Accept)
**Goal:** Verify that a standard attendee can accept an invite and the organizer's calendar updates without an email.

- [ ] **Step 1:** Log in to Bulwark as `michael@vthul-it.nl`.
- [ ] **Step 2:** Open the Calendar module and create a new event.
- [ ] **Step 3:** Set the title to "Manual Sync Test 1", select a time tomorrow, and invite `beheerder@vthul-it.nl`. Click **Save**.
- [ ] **Step 4:** Log out, and log back in as `beheerder@vthul-it.nl`.
- [ ] **Step 5:** Open the Mail module. You should see an invitation email from Michael. 
- [ ] **Step 6:** Click the **Accept** button within the email (or click it from the calendar view).
- [ ] **Step 7:** Log out, and log back in as `michael@vthul-it.nl`.
- [ ] **Step 8:** Open the Calendar module and click on "Manual Sync Test 1".
- [ ] **Step 9:** **Verify:** Look at the participant list. Beheerder should show as **Accepted**.
- [ ] **Step 10:** **Verify:** Check Michael's Inbox. There should be **NO** "bijgewerkte uitnodiging" (Updated Invitation) email from Beheerder.

---

## 🛑 Scenario 2: Standard RSVP (Decline)
**Goal:** Verify that a standard attendee can decline an invite and the organizer's calendar updates.

- [ ] **Step 1:** Log in to Bulwark as `michael@vthul-it.nl`.
- [ ] **Step 2:** Create an event titled "Manual Sync Test 2" and invite `beheerder@vthul-it.nl`. Click **Save**.
- [ ] **Step 3:** Log in as `beheerder@vthul-it.nl`.
- [ ] **Step 4:** Open the invitation email and click **Decline**.
- [ ] **Step 5:** Log in as `michael@vthul-it.nl`.
- [ ] **Step 6:** Open the Calendar and check "Manual Sync Test 2". 
- [ ] **Step 7:** **Verify:** Beheerder should show as **Declined**.
- [ ] **Step 8:** **Verify:** Check Michael's Inbox. There should be **NO** email notification about the decline.

---

## 🕒 Scenario 3: Organizer Updates Event
**Goal:** Verify that when the organizer changes an event's time, the attendee's calendar is updated silently.

- [ ] **Step 1:** Log in as `michael@vthul-it.nl`.
- [ ] **Step 2:** Open the Calendar, find "Manual Sync Test 1", and drag it to a different time slot (or edit the time).
- [ ] **Step 3:** Log in as `beheerder@vthul-it.nl`.
- [ ] **Step 4:** Open the Calendar module.
- [ ] **Step 5:** **Verify:** The event "Manual Sync Test 1" should appear at the **new** time.
- [ ] **Step 6:** **Verify:** Check Beheerder's Inbox. There should be **NO** new "bijgewerkte uitnodiging" email about the time change.

---

## 🤝 Scenario 4: Create on Behalf Of (Delegate)
**Goal:** Verify that a delegate can create an event in another user's calendar.

- [ ] **Step 1:** Log in as `michael@vthul-it.nl`.
- [ ] **Step 2:** Open the Calendar module. On the left sidebar, ensure **Stalwart Calendar (beheerder@vthul-it.nl)** is visible.
- [ ] **Step 3:** Create a new event. 
- [ ] **Step 4:** **Crucial:** In the event creation form, change the target calendar dropdown from Michael's calendar to **Beheerder's calendar**.
- [ ] **Step 5:** Title the event "Delegate Test 4" and invite `test@vthul-it.nl`. Click **Save**.
- [ ] **Step 6:** Log in as `beheerder@vthul-it.nl`.
- [ ] **Step 7:** Open the Calendar module.
- [ ] **Step 8:** **Verify:** "Delegate Test 4" should be visible in Beheerder's calendar. Beheerder should be listed as the Organizer.
- [ ] **Step 9:** Log in as `test@vthul-it.nl` (if you have access).
- [ ] **Step 10:** **Verify:** Test should have received an invite email, and the sender should appear as `beheerder@vthul-it.nl`, not Michael.

---

## 🏢 Scenario 5: Michael creates event in Beheerder's calendar
**Goal:** Verify event creation in a shared group calendar.

- [ ] **Step 1:** Log in as `michael@vthul-it.nl`.
- [ ] **Step 2:** Open the Calendar module. On the left sidebar, ensure **Stalwart Calendar (beheerder@vthul-it.nl)** is selected.
- [ ] **Step 3:** Create a new event.
- [ ] **Step 4:** Change the target calendar dropdown to the **Beheerder calendar**.
- [ ] **Step 5:** Title the event "S5: Michael on behalf of Beheerder" and invite `test@vthul-it.nl`. Click **Save**.
- [ ] **Step 6:** Log in as `beheerder@vthul-it.nl`.
- [ ] **Step 7:** **Verify:** "S5: Michael on behalf of Beheerder" is visible in Beheerder's calendar. Beheerder is the Organizer.

---

## 🧑‍🤝‍🧑 Scenario 6: Michael creates in TestGroup
**Goal:** Verify event creation in a shared group calendar.

- [ ] **Step 1:** Log in as `michael@vthul-it.nl`.
- [ ] **Step 2:** Open the Calendar module. On the left sidebar, ensure **Stalwart Calendar (testgroup@vthul-it.nl)** is selected.
- [ ] **Step 3:** Create a new event.
- [ ] **Step 4:** Change the target calendar dropdown to the **TestGroup calendar**.
- [ ] **Step 5:** Title the event "S6: Team Event". Click **Save**.
- [ ] **Step 6:** Log in to any other account that has access to TestGroup.
- [ ] **Step 7:** **Verify:** "S6: Team Event" is visible in the TestGroup calendar for all authorized members.

---

## 🧑‍🤝‍🧑 Scenario 7: Beheerder creates event in Test's calendar
**Goal:** Verify event creation in a shared group calendar.

- [ ] **Step 1:** Log in as `beheerder@vthul-it.nl`.
- [ ] **Step 2:** Open the Calendar module. On the left sidebar, ensure **Stalwart Calendar (test@vthul-it.nl)** is selected.
- [ ] **Step 3:** Create a new event.
- [ ] **Step 4:** Change the target calendar dropdown to the **Test calendar**.
- [ ] **Step 5:** Title the event "S7: Beheerder on behalf of Test" and invite `michael@vthul-it.nl`. Click **Save**.
- [ ] **Step 6:** Log in as `michael@vthul-it.nl`.
- [ ] **Step 7:** **Verify:** You should receive an invite email from `test@vthul-it.nl`.

---

## 🚫 Scenario 8: Unauthorized Access Check
**Goal:** Verify that a user cannot access calendars they haven't been granted permission to view.

- [ ] **Step 1:** Log in as `beheerder@vthul-it.nl`.
- [ ] **Step 2:** Open the Calendar module.
- [ ] **Step 3:** Look at the left sidebar under calendars.
- [ ] **Step 4:** **Verify:** You should see Test's calendar (`test@vthul-it.nl`), but you should **NOT** see Michael's calendar (`michael@vthul-it.nl`) or the TestGroup calendar (`testgroup@vthul-it.nl`).
- [ ] **Step 5:** Attempt to create an event and open the target calendar dropdown.
- [ ] **Step 6:** **Verify:** Only Beheerder's and Test's calendars should be available options. Michael and TestGroup should be absent.
