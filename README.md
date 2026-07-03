# Ledger — Expense Tracker (PWA)

A installable, offline-capable expense tracker. Data is cached on-device
and synced to a private, hidden folder in your Google Drive (not visible
in your regular Drive file list — it's the same storage area apps like
this use for their own settings).

## 1. Put it on GitHub

1. Create a new **public** GitHub repository (Pages needs public for the
   free tier, or use a private repo if you're on GitHub Pro/Team).
2. Upload all files in this folder to the repo root (`index.html`,
   `app.js`, `style.css`, `manifest.json`, `sw.js`, `icons/`).
3. Go to **Settings → Pages**, set source to your default branch,
   folder `/ (root)`, and save.
4. Your app will be live at `https://<your-username>.github.io/<repo-name>/`
   within a minute or two.

## 2. Set up Google Drive sync

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   create a new project (or reuse one).
2. Enable the **Google Drive API** for that project
   (APIs & Services → Library → search "Google Drive API" → Enable).
3. Go to **APIs & Services → Credentials → Create Credentials →
   OAuth client ID**.
   - Application type: **Web application**
   - Authorized JavaScript origins: add your GitHub Pages URL, e.g.
     `https://<your-username>.github.io`
   - Save, then copy the generated **Client ID**.
4. You'll also need to configure the **OAuth consent screen** (if
   prompted) — choose "External," fill in an app name, and add your own
   Google account as a test user (this keeps it free and skips Google's
   verification review, since only you will use it).
5. Open `app.js` and paste your client ID into:
   ```js
   const CONFIG = {
     GOOGLE_CLIENT_ID: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
     ...
   };
   ```
6. Commit and push. Reload the app, tap **Connect Google Drive** at the
   top, and sign in.

## 3. Install it on Android

1. Open your GitHub Pages URL in Chrome on your phone.
2. Tap the **⋮** menu → **Add to Home screen** (Chrome may also prompt
   this automatically after a visit or two).
3. It now opens full-screen like a native app, works offline, and syncs
   to Drive whenever you have a connection and are signed in.

## How data flows

- Every add/delete saves instantly to the phone's local storage — the
  app works fully offline.
- Changes are pushed to a `ledger-data.json` file in your Drive's
  app-data area about a second after you stop editing.
- On sign-in, the app pulls anything from Drive you don't already have
  locally and merges it in — so the same account can be used across
  multiple phones.

## Notes

- No backend server is required — everything runs client-side and talks
  directly to Google's APIs.
- If you skip the Drive setup, the app still works — it just stays
  local to that one device.
