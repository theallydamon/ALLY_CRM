# ALLY CRM

Personal life-management dashboard: content pipeline, song roadmap, life unlocks, apartment furnishing, brand deals, and the Mama work HQ. Single-page React app. Data persists in the browser via localStorage (no backend).

## Run locally
```bash
npm install
npm run dev
```

## Build for Netlify
```bash
npm run build
```
Publish directory: `dist`. Build command: `npm run build`.

## Push this into the repo
From inside this folder:
```bash
git init
git add .
git commit -m "ALLY CRM v3: sidebar nav, charts, gated apartment"
git branch -M main
git remote add origin https://github.com/theallydamon/ALLY_CRM.git
git push -u origin main
```
If the repo already has commits, use `git pull --rebase origin main` before pushing, or force with `git push -u origin main --force` if you want this to replace it.

## Notes
- `src/App.jsx` is the whole app. It also runs as a Claude artifact unchanged: it detects `window.storage` and falls back to `localStorage` outside it.
- Tailwind is loaded via CDN in `index.html` for zero-config styling.
