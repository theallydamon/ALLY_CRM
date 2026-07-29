# ALLY_CRM - Context

Reference document for an AI coding agent working on this repository. Read this first.

## What this repo is

ALLY_CRM is a single-page content and client CRM for a solo creator. The entire application lives in one file: `index.html` at the repository root, roughly 3,835 lines. There is no build step, no `package.json`, no `node_modules`, and no `src/` directory. An older README claimed the app lived at `src/App.jsx`; that was wrong and has been corrected.

How it runs:

* React and ReactDOM are loaded from a CDN via script tags.
* JSX is compiled in the browser at runtime by Babel Standalone.
* Styling uses utility classes defined in the same file.
* Deployment is handled by `.github/workflows/deploy.yml`, which publishes the repository root to GitHub Pages as-is. Nothing is compiled in CI.
* `index-CHATGPT.html` is a separate legacy copy. Do not edit it.

Implication: every change is a surgical edit to `index.html`. Do not run a formatter over the file, do not reindent it, and do not split it into modules unless explicitly asked. Whitespace churn destroys reviewable diffs in a file this size.

## Runtime and hosting

Production is GitHub Pages, served from the repo root over HTTPS. For local development, serve the file over `http://localhost:<port>` rather than opening it as `file://`, because OAuth popup and redirect flows will not work from a `file://` origin.

The app is also intended to keep working when pasted into a Claude artifact. That is why storage is abstracted behind `window.storage` instead of calling `localStorage` directly.

## Authentication - current state

Firebase is live and in use. Google sign-in gates the entire CRM; there is no anonymous mode.

* The Firebase SDK is loaded from CDN.
* `signInGoogle`, around line 1066, calls `signInWithPopup` with `new GoogleAuthProvider()`.
* No OAuth scopes are requested beyond the default profile and email.
* The returned credential is discarded. The code does not call `GoogleAuthProvider.credentialFromResult(result)` and does not retain an access token.

This matters a lot for calendar work: Firebase Auth on its own does not hand you a Google Calendar access token. To call the Calendar API you must either add the scope to the existing provider and capture the credential from the popup result, or run a separate Google Identity Services token client flow.

## Persistence

There are two layers. First, `window.storage`, a thin abstraction with a `localStorage` fallback. Always go through it. Second, Firestore, which stores per-user documents under `users/<uid>`; the read is around line 1097 and the write around line 1140. Firestore is the source of truth while signed in.

There is also a JSON backup export and import feature. The file input is around line 1562; the `FileReader` handler and `JSON.parse` are around lines 1361 to 1364.

## Content data model

Content items carry three date-related fields that are easy to confuse:

* `due` - the working deadline for the item.
* `dueOff` - a boolean. When true the deadline is switched off. In the UI this renders as a strike-through on the date chip.
* `scheduledFor` - the intended publish or post date. This is a plan for when the piece goes live, not a task deadline.

`DueChip` renders the date chip and toggles `dueOff` when tapped. It also now shows a small marker when `scheduledFor` is set, so the owner can see at a glance that a piece is scheduled. The same marker appears on the item title row.

## Task generation and the dashboard

`pushContentTasks`, around line 621, walks content items and emits derived tasks such as To Film, To Edit, Ideas, and `Post: <title>`.

The dashboard bucket filters sit around lines 1833 to 1835. They used to read `((i.due && !i.dueOff) || i.scheduledFor)`, which let `scheduledFor` bypass the `dueOff` check, so switching a deadline off did not remove the task from the dashboard. They now read `!i.dueOff && (i.due || i.scheduledFor)`.

Open question that has never been resolved: the `Post: <title>` task inside `pushContentTasks` deliberately ignores `dueOff`. That was left unchanged on purpose. If scheduling something on the calendar should silence that reminder, it needs an explicit decision from the owner before anyone changes it.

## Existing calendar UI

`ContentCalendar`, around line 2294, already renders a month grid of content items. It is read-oriented: no day view, no drag-and-drop, no external calendar data. New calendar work should sit alongside it and reuse its date helpers rather than duplicating them.

## Existing drag-and-drop pattern

The app already uses the native HTML5 drag-and-drop API, meaning `draggable`, `onDragStart`, `onDragOver` and `onDrop`, in its board and list views. Reuse that pattern for dragging tasks into a calendar day. Do not add a drag-and-drop library; there is no bundler to install one with.

## Rich text and sanitisation

Item descriptions can contain HTML. The path is: `handlePaste` around line 2250 intercepts paste events, then calls `scriptSanitizeHtml` around line 2167, which walks the fragment via `scriptSanitizeNode` around line 2135 and rebuilds it against an allow-list of tags and attributes. The sanitised HTML is rendered with `innerHTML` around line 2198.

So pasted content is genuinely sanitised. The residual gap is the JSON backup import path: imported `desc` values are stored and later re-injected through that same `innerHTML` call without passing back through the sanitiser. A hand-crafted backup file is therefore a self-XSS vector. Closing this means sanitising on load, not only on paste.

## Other security posture notes

CDN script tags currently carry no Subresource Integrity attributes. Firestore security rules have not been reviewed and must be confirmed to restrict `users/<uid>` to the owning `uid`. No secrets belong in this repo: the Firebase web config is public by design and OAuth client IDs are public too, but client secrets are not, and are not needed for a browser-only flow.

## Conventions to follow

Make small targeted edits with clear commit messages. Keep the single-file architecture intact. Keep the `window.storage` fallback working so the artifact use case survives. Prefer plain functions and hooks in the existing style over introducing new abstractions. Test by loading the page and exercising the real UI, because there is no test harness.
