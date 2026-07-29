# ALLY_CRM - Redesign brief (supersedes parts of 02-GOAL and 03-WORKFLOW)

Captured 29 July 2026 from the owner. Read `01-CONTEXT.md` first for how the codebase works.
This document changes the *shape* of the calendar feature described in `02-GOAL.md`. The security
requirements in `02-GOAL.md` are unchanged and still binding.

## The headline change

The calendar is no longer a separate tab bolted next to `ContentCalendar`. It becomes the centre of
a new HOME dashboard, and the whole app's navigation and theme change around it.

## HOME dashboard layout

Top: a single-day time grid. Underneath: the existing pillar cards (priority rings and their task
lists). The point of putting them on one screen is the workflow - see the urgency ring, see the
tasks on the card, drag a task up into a slot, done.

### The day grid

* **Current day only.** Not a week. A week was considered and rejected as too cramped.
* **06:00 to 22:00**, divided into **30-minute cells**. 32 cells total.
* **Three phase bands**, as very faint background tints - washed out, not blocky:
  * Morning, 06:00-12:00, faint green
  * Day, 12:00-19:30, faint yellow
  * Night, 19:30-22:00, faint red
* Cells read as a grid of squares you fill in, not a continuous canvas.

### Drag behaviour

1. Drag a task from a pillar card onto a cell. That logs the task into that 30-minute slot and
   creates a real Google Calendar event.
2. Once placed, the block can be extended by dragging to take the adjacent cell before or after it,
   growing the event in 30-minute steps.
3. Existing Google Calendar events occupy their cells too. A 09:00-11:00 gym event marks four cells
   as taken.

## Navigation restructure

* **Remove the sidebar.** Replace with a bottom icon strip.
* **HOME sits centre** of the strip, with a custom-drawn icon rather than an emoji.
* Other tabs sit either side, also with custom icons: **MAMA** (day job), **Music**, **Content**,
  **Life Admin**.
* "Personal" becomes HOME. Life Admin is promoted from a section to its own top-level tab.
* Cards on HOME are the second way to navigate - click a card to jump to that tab's page.
* **Delete the Anchor tab entirely.**
* **Delete the Series tab entirely.**

## Theme

* Primary: translucent black.
* Accent: red.
* Tabs no longer carry individual accent colours; they all follow the same theme.
* **Exception:** priority rings keep green / orange / red, because that encodes urgency.

## Sizing

Every page should be laid out so no manual browser zooming is needed to use it. Currently the main
dashboard runs slightly too large while other pages are fine.

## Confirmed technical answers

### Reading and writing the ally@mama.co.za calendar

**Yes, this works through theallydamon@gmail.com alone. No second Google Cloud project, no second
OAuth setup.**

Verified in Google Calendar settings on 29 July 2026: the `ally@mama.co.za` calendar is shared with
`theallydamon@gmail.com` at **"Make changes and manage sharing"** - which is `accessRole: owner` in
Calendar API terms. It appears under *My calendars*, not *Other calendars*.

Practical consequence: one OAuth token issued to `theallydamon@gmail.com` can read events from the
mama calendar AND write to it. The `02-GOAL.md` line about subscribed calendars being display-only
does not apply here.

Other calendars visible on that account: `Ally Damon` (primary), `Birthdays`,
`adamon@amplified.community` (under Other calendars), `Holidays in South Africa`.

### One extra OAuth scope is needed

`https://www.googleapis.com/auth/calendar.events` alone **cannot list the account's calendars**.
Per the Calendar API reference for `calendarList.list`, that endpoint requires one of
`calendar.readonly`, `calendar`, `calendar.calendarlist`, or `calendar.calendarlist.readonly`.

Add **`https://www.googleapis.com/auth/calendar.calendarlist.readonly`** - the narrowest option that
works. It is read-only and grants nothing beyond seeing which calendars exist.

Alternative if we want to avoid a second scope: hardcode the calendar IDs (`primary` and
`ally@mama.co.za`) and skip discovery. Cheaper on permissions, but no calendar-picker UI and it
breaks silently if a calendar is renamed or added.

### The production origin is www.theallydamon.com, NOT theallydamon.github.io

Verified 29 July 2026 by loading the live app. `https://theallydamon.github.io/ALLY_CRM/` **redirects**
to `https://www.theallydamon.com/ALLY_CRM/` — GitHub Pages has a custom domain attached, so github.io
is only the redirect source. The origin the browser actually reports, and the one every Google
security check is evaluated against, is `https://www.theallydamon.com`.

This matters because the three Google allowlists are currently inconsistent:

| List | Contains the real origin? |
| --- | --- |
| Firebase Auth authorised domains | Yes — `theallydamon.com` is present |
| API key website restrictions | Yes — `theallydamon.com/*`, `www.theallydamon.com/*` |
| **OAuth client authorised JS origins** | **No** — has `theallydamon.github.io`, not `theallydamon.com` |

**This is a blocker for the calendar work.** The Google Identity Services token client validates the
live page origin against the OAuth client's authorised JavaScript origins. As configured, requesting
a calendar token from the real app will fail with `origin_mismatch`.

**RESOLVED 29 July 2026.** `https://www.theallydamon.com` and `https://theallydamon.com` were added
to the OAuth 2.0 web client's Authorised JavaScript origins (URIs 5 and 6) and verified to persist
after a page reload. `theallydamon.github.io` was left in place — harmless, and it keeps working if
the custom domain is ever removed. The full list is now:

```
http://localhost
http://localhost:5000
https://ally-crm-cbdd1.firebaseapp.com
https://theallydamon.github.io
https://www.theallydamon.com      <- the origin that actually matters
https://theallydamon.com
```

Note `www` and non-`www` are distinct origins to Google, which is why both are listed.

### Why localhost sign-in fails

The Firebase browser API key ("Browser key (auto created by Firebase)") has **website restrictions**
limited to `theallydamon.com/*` and `www.theallydamon.com/*`. Those restrictions are good practice
and should stay. But they are a third allowlist, separate from Firebase authorised domains and from
the OAuth client origins, and localhost is not on it.

The result is `auth/requests-from-referer-http://localhost:5000/-are-blocked`. Confirmed to affect
the pre-redesign code identically, so it is not a regression.

To test locally, add `http://localhost:5000/*` to that key's website restrictions. If local testing
is not wanted, leave the key alone and verify on the live origin instead.

The same key also has **API restrictions**: Cloud Firestore API, Identity Toolkit API, Token Service
API. Google Calendar API is deliberately not among them and does not need to be, because calendar
requests will authenticate with an OAuth access token rather than the API key. Do not pass `key=` on
Calendar requests, or this becomes a problem.

### Sign-in used to fail silently

`signInGoogle` caught every error and discarded it, on the assumption that the only realistic failure
was the user closing the popup. Every other failure — blocked popup, unauthorised domain, restricted
API key — therefore looked like a dead button. Worse, `signInWithPopup` can hang without ever
settling, which no catch block can see.

Fixed: real causes are now mapped to readable messages and shown on the gate screen, a stall timer
covers the hang case, and a redirect-based fallback is offered when the popup route is unavailable.
The failing origin is printed alongside, since every one of these faults is origin-specific.

### Local development port

`03-WORKFLOW.md` and the README say to serve on port 8000. The OAuth client only authorises
`http://localhost` and `http://localhost:5000`. Google treats each port as a distinct origin, so
**development must use port 5000** (`python3 -m http.server 5000`) or the origin must be added in the
console. Fix the README.

### Subresource Integrity cannot be done as written

`02-GOAL.md` requires SRI on the CDN script tags. As things stand that is not achievable:

* `cdn.tailwindcss.com` generates CSS at runtime and has no stable hash. It cannot be SRI'd.
* `react@18` and `@babel/standalone@7` are floating version ranges. SRI requires pinning exact
  versions first.

Either pin exact versions and accept Tailwind unhashed, or drop the requirement knowingly. Do not
treat it as a tick-box.

## Build order

Each step ends in something loadable in a browser.

1. **Nav shell + theme.** Bottom icon strip, HOME centre, custom icons, translucent black / red
   theme, Anchor and Series removed, Life Admin promoted, sizing pass. No calendar work. This is
   pure front-end and independently verifiable.
2. **Calendar authorisation.** Google Identity Services token client, Connect button, in-memory
   token, reconnect on expiry. Per `03-WORKFLOW.md` Phase 1, Route B.
3. **Day grid, read only.** 06:00-22:00, 30-minute cells, three phase bands, real events from the
   gmail primary calendar and the mama calendar rendered into their cells.
4. **Drag to create.** Task from card into cell writes a real Google event.
5. **Extend, move, delete.** Grow a block by cell, move it, remove it - always PATCH/DELETE the same
   event, never duplicate.
6. **Hardening.** Everything in `03-WORKFLOW.md` Phase 6, with the SRI caveat above.

## Open questions for the owner

1. **Deleting the Anchor tab - what happens to the data?** Firestore currently holds journal entries
   at `users/<uid>/ally/anchor/entries`, including dated reflections. Removing the tab hides them.
   Should the stored entries be left in place untouched (recoverable later), exported to a file
   first, or deleted outright? Default assumption: leave the data alone, only remove the UI.
2. **Which calendar do new blocks get written to** - the gmail primary, or the mama calendar? Both
   are writable. Default assumption: gmail primary, with the mama calendar shown as busy.
3. **Should Birthdays / Holidays / adamon@amplified.community also mark cells as busy,** or only the
   two main calendars? Default assumption: only the two main ones.
