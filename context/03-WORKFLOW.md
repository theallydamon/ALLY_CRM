# ALLY_CRM - Proposed Workflow

Build order for the Google Calendar day-planner feature. Read `01-CONTEXT.md` and `02-GOAL.md` first. Each phase ends in something that can be loaded in a browser and tried, so nothing is built on top of an unverified layer.

## Before you start

Two housekeeping items. First, pull request 1 on this repo contains the deadline and scheduled-icon bug fix; merge it before branching so you are not working against stale dashboard logic. Second, confirm with the owner the two open decisions listed at the end of `02-GOAL.md`.

## Phase 0 - Google Cloud setup (owner does this by hand)

This phase cannot and should not be done by an agent. It involves account-level configuration and consent screens. Hand the owner these steps:

1. Open the Google Cloud console and select an existing project or create one for ALLY_CRM.
2. Enable the Google Calendar API for that project.
3. Configure the OAuth consent screen as External, add the owner Google account as a test user, and add the single scope `https://www.googleapis.com/auth/calendar.events`.
4. Create an OAuth 2.0 Client ID of type Web application.
5. Add authorised JavaScript origins: the GitHub Pages origin for the live app, plus `http://localhost:8080` or whichever local port is used in development.
6. Copy the Client ID. It is not a secret and is safe to place in `index.html`. Do not create or copy a client secret; a browser-only flow does not use one.

Deliverable from this phase: the Client ID string, and confirmation that the Calendar API is enabled.

## Phase 1 - obtain a Calendar access token

Firebase Auth currently returns no Calendar token, so this must be added. Two viable routes:

Route A, extend the existing Firebase popup. In `signInGoogle` around line 1066, call `provider.addScope('https://www.googleapis.com/auth/calendar.events')`, then read the credential from the popup result via `GoogleAuthProvider.credentialFromResult(result)` and keep `credential.accessToken`. Simplest change, but it means every sign-in asks for calendar permission, and the token cannot be refreshed without another popup.

Route B, separate Google Identity Services token client. Load `https://accounts.google.com/gsi/client`, then call `google.accounts.oauth2.initTokenClient` with the Client ID, the scope, and a callback, and trigger `requestAccessToken()` from an explicit Connect Calendar button. Sign-in stays untouched, consent is asked only when the owner opts in, and reconnecting is a single call.

Recommendation: Route B. It keeps calendar access opt-in and keeps the login path unchanged.

Implementation notes:

* Hold the token in a module-scope variable or a React ref. In memory only. Never persisted anywhere.
* Store the expiry timestamp alongside it and treat the token as dead a minute early.
* Clear the token on Firebase sign-out.
* Expose a small helper, for example `calFetch(path, options)`, that attaches the bearer header, and on a 401 or 403 clears the token and raises a needs-reconnect state rather than throwing raw.

Verification for this phase: a Connect Calendar button that shows the Google consent screen, and a connected indicator afterwards. No calendar data yet.

## Phase 2 - list calendars and choose sources

Call `GET https://www.googleapis.com/calendar/v3/users/me/calendarList`. This returns every calendar the account can see, including subscribed ones such as the iCloud feed, because the subscription already exists inside Google Calendar. Nothing extra is needed to pick up iCloud.

Build a small settings panel that lets the owner tick which calendars appear in the day view, and pick exactly one writable target calendar for new blocks. Respect the `accessRole` field: anything that is not `owner` or `writer` must not be offered as a write target. Persist these preferences, which are not sensitive, through `window.storage` and Firestore as usual.

Verification: the panel lists the real calendars including the iCloud one, and the iCloud calendar is not selectable as a write target.

## Phase 3 - day view, read only

Build a `DayView` component next to `ContentCalendar` around line 2294 and reuse its date helpers.

* Layout: a vertical hour grid, with a configurable visible window such as 06:00 to 22:00, and a now-line.
* Data: for each selected calendar call the events endpoint at `calendar/v3/calendars/{calendarId}/events` with `timeMin`, `timeMax`, single events expanded, and ordering by start time. Encode the calendar id.
* Fetch the calendars in parallel, merge, sort by start time, and lay out overlapping events side by side.
* Handle all-day events as a separate strip at the top rather than trying to place them on the grid.
* Timezone: build `timeMin` and `timeMax` from local midnight boundaries and render using the local offset. Do not assume UTC.
* Add previous day, next day and today controls, and a way to jump here from the existing month calendar.

Verification: today in the CRM matches today in Google Calendar, event for event, including subscribed entries, at the right times.

## Phase 4 - drag a task into the day

* Render an unscheduled work list beside the grid, sourced from the same task data the dashboard uses, so the `dueOff` behaviour stays consistent.
* Make each row `draggable` and set a task id on the drag payload, matching the existing native drag-and-drop pattern already used in the board views. No library.
* Make each hour slot, ideally subdivided into fifteen minute drop targets, handle `onDragOver` and `onDrop`.
* On drop, compute the start from the slot, apply a default duration of thirty or sixty minutes, then POST to the events endpoint of the chosen write calendar with a summary derived from the task title, a description linking back to the CRM item, and start and end objects carrying `dateTime` plus `timeZone`.
* Optimistically render the block, then reconcile with the API response. On failure, remove the optimistic block and surface a readable error.
* Store the returned event id and calendar id on the CRM item so the link survives a reload.

Verification: drop a task on the 14:00 slot, then confirm the event exists at 14:00 in Google Calendar.

## Phase 5 - move, resize, remove

* Dragging an existing block to a new slot issues a PATCH to the same event id. It must never create a second event.
* Dragging the bottom edge changes the end time via the same PATCH.
* Removing a block issues a DELETE, and clears the stored event id from the CRM item.
* If a PATCH or DELETE returns 404 or 410, the event was removed in Google. Clear the stored id quietly and refresh the day.
* Only allow editing blocks the CRM created, or at minimum blocks on the writable target calendar. Never attempt to mutate a subscribed read-only event.

Verification: move a block, then confirm Google Calendar shows one event at the new time, not two.

## Phase 6 - hardening

* Confirm the token is absent from `localStorage`, `sessionStorage`, Firestore, the URL, and the JSON backup export. Check the export code path explicitly.
* Confirm no code path logs the token or includes it in an error message.
* Add a visible Disconnect action that drops the token and clears calendar state, and document revoking access from the Google account permissions page.
* Route stored `desc` HTML through `scriptSanitizeHtml` on load, not only on paste, closing the JSON import injection gap described in `01-CONTEXT.md`.
* Add Subresource Integrity attributes to the CDN script tags.
* Review Firestore rules so `users/<uid>` is readable and writable only by that `uid`.
* Re-check rate limiting: debounce day changes so rapid navigation does not fire dozens of requests, and cache fetched days briefly.

## Testing approach

There is no test harness, so testing is manual and browser-based. Keep a checklist: connect, disconnect, expired token, day with no events, day with overlapping events, day with an all-day event, drop, move, resize, delete, reload, sign out and back in. Test on both the desktop layout and a narrow mobile viewport, since the day grid is the part most likely to break on small screens.

## Known gotchas

* `file://` origins cannot complete OAuth. Serve locally over HTTP.
* The access token lasts about an hour. Plan for expiry as the normal case, not an error.
* Subscribed calendars are read-only. Writing to them will fail with a permission error.
* Recurring events must be requested with single events expanded, or you get the recurrence rule rather than the individual instances.
* Deleting an instance of a recurring series behaves differently from deleting a one-off. Avoid the situation by only editing CRM-created events.
* The consent screen stays in testing mode until verified, which is fine for a single owner account but will block other users.

## Commit discipline

One phase per branch and pull request, with a short description of what was verified by hand. Keep diffs in `index.html` tight; do not reformat surrounding code. Never commit the Client ID alongside anything resembling a secret, and never commit a token, even a dead one.
