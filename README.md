# ALLY CRM

Personal life-management dashboard: content pipeline, song roadmap, life unlocks, apartment furnishing, brand deals, and the Mama work HQ.

Single-page React app with no build step. Markup, styles and the entire app live in `index.html`, and JSX is compiled in the browser by Babel standalone. There is no `package.json`, no `node_modules` and no `src/` directory.

## Structure

`index.html` is the whole app (~3,800 lines) — every React component sits inside a single `<script type="text/babel">` block, and this is the file you edit. `index-CHATGPT.html` is a separate standalone variant kept in the repo and is not the live entry point. `manifest.json`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png` and `icon-512.png` are PWA / homescreen assets. `robots.txt` plus a `noindex` meta tag keep the deployed site out of search results. `.github/workflows/deploy.yml` handles deployment.

Everything else loads from CDNs at runtime: React 18 and ReactDOM 18 (unpkg), Babel standalone, Tailwind CSS (cdn.tailwindcss.com), and the Firebase compat SDKs for app, auth and firestore (gstatic).

Personal Home opens directly on Life Admin, with task text and completion circles sized by priority. Waiting and N/A tasks remain visible below the active priorities. Creative priorities and the calendar follow the Life Admin list. Content, Brand Deals and Music Content each have a main navigation tab, backed by their original `content`, `brandContent` and `musicContent` records. The work profile keeps its existing MAMA Home and navigation.

Task descriptions accept formatted clipboard content or Markdown, including tables, headings, bold text and lists. Descriptions remain strings in the existing fields, with Markdown used for task text and the existing sanitized HTML format used for content scripts. Browser dependencies are pinned locally under `vendor/`. `tests/task-text.html` runs the paste/formatting security checks when served over HTTP; `node --test tests/task-files.test.cjs` checks attachment authorization and upload failure handling.

Saved tasks have a **Connect Drive to attach files** button. This requests `drive.file`, `openid` and `email` only on an explicit click, verifies the account matches the CRM sign-in, and keeps the attachment access token in memory, separate from Calendar and Sheets authorization. After connecting, **Attach file** accepts one or more files, up to 25 MB each. Files are private in the uploader's **Ally CRM Attachments** Drive folder; the CRM stores only file metadata and links. Other workspace members need their own Drive access to open those files. Removing an attachment unlinks it from the task and leaves the Drive file intact. Navigation cancels unfinished uploads; a partially completed file may remain in the Drive folder.

## Run locally

Nothing to install and nothing to build — just serve the folder over HTTP:

```bash
python3 -m http.server 5000
# then open http://localhost:5000
```

**Use port 5000, not 8000.** Google treats every port as a separate origin, and the OAuth client only authorises `http://localhost` and `http://localhost:5000`. Serving on 8000 will fail the moment anything touches Google sign-in or the Calendar API, with an `origin_mismatch` error rather than anything helpful.

Use a local server rather than opening `index.html` over `file://`, because Firebase Auth needs an http(s) origin. To sign in from localhost, `localhost` must be listed under Firebase Auth authorised domains and as an authorised JavaScript origin on the Google OAuth client.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which uploads the repo root as-is and publishes it to GitHub Pages. There is no build command and no publish directory — the repo root is the site.

## Data and auth

Google sign-in through Firebase Auth gates access to the app. Every authorised user shares the live Firestore document at `workspaces/ally-crm`; `onSnapshot` updates open sessions immediately and transaction-based three-way merging prevents stale browsers from overwriting unrelated changes or resurrecting deleted tasks. `localStorage` remains an offline cache and emergency backup, not the primary backend.

Firestore access is defined in `firestore.rules`. The original owner is recognised by the legacy `users/<uid>` document and `ally@mama.co.za` is an explicit collaborator. Deploy rule changes with `firebase deploy --only firestore:rules` before deploying app code that depends on a new access policy.

The Google Sheet integration mirrors regular Content skits into production-stage tabs and Content > Brand Deals creative deliverables into Branded Skits in the same registry. Firebase remains the CRM database. Sync runs in an authenticated personal CRM session with Google Sheets connected. Branded Skits columns A:I mirror CRM fields; J:W hold optional campaign context, feedback and results, preserved by permanent Skit ID across reordering. Removed branded scripts remain as historical rows marked Removed from CRM. Commercial deal records are not imported as duplicate creative deliverables.

## Working on it

Branch off `main`, commit, and open a pull request. Because the app is one very large file, prefer small targeted edits — reformatting or whitespace churn makes diffs unreadable.
