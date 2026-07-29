# ALLY_CRM - Goal

## Outcome in one sentence

Let the owner plan her actual working day inside ALLY_CRM by dragging CRM tasks onto a real calendar day view, and have those blocks appear in her real Google Calendar.

## Why

Right now the CRM tells her what needs doing but not when she is going to do it. Her real schedule lives in Google Calendar, which also carries her subscribed iCloud calendar. So she currently plans in two places and neither one is complete. The goal is a single screen where the day is visible with all its existing commitments, and unscheduled CRM work can be dropped into the gaps.

## User stories

1. As the owner, I can connect my Google Calendar once from inside the CRM, using the same Google account I already sign in with.
2. As the owner, I can open a day view for any date and see all my existing events for that day, including events from calendars I subscribe to such as my iCloud calendar, because those are already subscribed inside Google Calendar.
3. As the owner, I can see my outstanding CRM tasks in a list beside the day view.
4. As the owner, I can drag a task from that list onto a time slot in the day, and it becomes a timed block.
5. As the owner, when I later open Google Calendar on my phone or laptop, that block is there.

## In scope

* Google OAuth authorisation for the Calendar API, built on top of the existing Firebase Google sign-in.
* Listing the owner calendars and letting her choose which ones are shown, and which single calendar new blocks are written to.
* A day view component with an hour grid, rendering busy blocks from the Calendar API.
* A source list of unscheduled or due CRM tasks.
* Native HTML5 drag-and-drop from the task list onto an hour slot.
* Creating a real Google Calendar event on drop, with a sensible default duration, and storing the returned event id on the CRM item.
* Moving or resizing a block afterwards updating the same Google event rather than creating a duplicate.
* Removing a block deleting or cancelling the corresponding Google event.
* Clear connected and disconnected states, including a graceful reconnect prompt when the access token expires.

## Out of scope

* Two-way sync, meaning changes made in Google Calendar flowing back and mutating CRM data. Reading events for display is in scope; treating Google as a writer into the CRM is not. This is the one decision still open and it should be confirmed before Phase 4.
* Embedding Google own calendar interface. Google does not allow an interactive embed to be manipulated cross-origin, so the day view must be custom-built.
* Any backend or server component. This stays a browser-only app.
* Multi-user or team calendars.
* Writing to subscribed read-only calendars. Subscribed calendars such as iCloud are display-only; new blocks go to a writable Google calendar.
* Recurring event editing. Show recurrences, do not try to edit recurrence rules.

## Acceptance criteria

* Connecting shows the Google consent screen listing only calendar access, and afterwards the CRM shows a connected state with the account email.
* The day view for today lists every event that Google Calendar shows for today, including subscribed calendar entries, at the correct times in the correct local timezone.
* Dragging a task onto the 14:00 slot creates an event starting at 14:00 local time, titled from the task, and it is visible in Google Calendar within one refresh.
* Dragging that same block to 16:00 updates the existing event; a check in Google Calendar shows one event, not two.
* Deleting the block removes it from Google Calendar.
* Reloading the page keeps the schedule intact, because the events live in Google, not only in local state.
* When the token has expired, the day view shows a reconnect prompt rather than an unhandled error or a silent empty day.
* Signing out of the CRM clears the calendar token from memory.

## Non-negotiable security requirements

* Request the narrowest scope that works. Prefer `https://www.googleapis.com/auth/calendar.events` over full `calendar`. Add `calendar.readonly` only if calendar listing needs it.
* The access token is held in memory only. Never write it to `localStorage`, `sessionStorage`, `window.storage`, Firestore, the URL, or the JSON backup export.
* Never log the token, and never include it in error messages or console output.
* Treat the roughly one hour token lifetime as normal. Handle expiry with a reconnect prompt; do not attempt to stash a refresh token in the browser.
* No client secret in this repo, ever. A browser-only flow does not need one.
* Confirm Firestore rules restrict `users/<uid>` documents to the owning `uid` before storing any event ids there.
* Sanitise stored HTML on load, not only on paste, so an imported JSON backup cannot inject script.
* Add Subresource Integrity attributes to the CDN script tags.
* Provide a visible disconnect action, and document how to revoke access at the Google account permissions page.

## Constraints inherited from the codebase

Everything must land in the single `index.html` file with no build step, must keep working when the app is pasted into a Claude artifact, and must not break the existing `window.storage` fallback. See `01-CONTEXT.md` for the details.

## Open decisions for the owner

1. One-way sync, CRM writing to Google only, versus two-way. Assume one-way unless told otherwise.
2. Whether a task that has been placed on the calendar should stop appearing as a nag in the dashboard, specifically the `Post: <title>` task in `pushContentTasks` which currently ignores `dueOff`.

