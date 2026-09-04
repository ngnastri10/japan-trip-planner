# Japan Trip Planner 🗾

A tiny collaborative web app for planning a family trip: a real interactive
map, click-to-add places, 👍 voting, and a day-by-day itinerary view.
No accounts, no installs for anyone — they just open a link and click.

It's plain HTML/CSS/JS (no build step) hosted for free on **GitHub Pages**,
with shared live data in a free **Firebase Firestore** database.

---

## One-time setup (you only — ~10 minutes, all clicking, no coding)

### 1. Create a free Firebase project

1. Go to https://console.firebase.google.com and sign in with any Google account.
2. Click **Add project**, give it a name (e.g. `japan-trip-planner`), and finish the wizard
   (you can decline Google Analytics — not needed).
3. Once the project opens, click the **⚙️ gear → Project settings**.
4. Under "Your apps", click the **`</>`** (Web) icon to register a new web app.
   Give it any nickname, click **Register app**. Firebase shows you a `firebaseConfig`
   object — keep this tab open, you'll copy from it in step 3 below.

### 2. Turn on Firestore (the database)

1. In the left sidebar, click **Build → Firestore Database**.
2. Click **Create database**. Choose any nearby region, and start in **test mode**
   for now (we'll paste stricter rules next).
3. Once it's created, go to the **Rules** tab and replace the contents with:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /places/{placeId} {
         allow read, write: if true;
       }
     }
   }
   ```

   Click **Publish**.

   > ⚠️ **Honest note on security**: this makes the `places` data readable and
   > writable by anyone who has (or guesses) your Firebase project ID — there's
   > no login. For a private family trip list that's a normal, low-risk
   > tradeoff (nobody else will know it exists), but don't put anything
   > sensitive in it. If you ever want it locked down further, that's a small
   > follow-up (anonymous auth) — just ask.
   >

### 3. Fill in your config file

1. In this project folder, copy `js/firebase-config.sample.js` and rename the
   copy to `js/firebase-config.js`.
2. Open it, and paste in the matching values from the `firebaseConfig` object
   Firebase showed you in step 1.4 (apiKey, authDomain, projectId, etc.).
3. Save the file.

### 4. Put it on GitHub

1. Create a new repo on https://github.com/new named `japan-trip-planner`
   (public is fine — remember, nothing secret lives in this repo).
2. From inside this folder:
   ```
   git init
   git add .
   git commit -m "Japan trip planner"
   git branch -M main
   git remote add origin https://github.com/<your-username>/japan-trip-planner.git
   git push -u origin main
   ```

   (No terminal experience? GitHub Desktop or the "upload files" button on
   the repo's web page both work too — just make sure `js/firebase-config.js`
   gets uploaded along with everything else.)

### 5. Turn on GitHub Pages

1. On the repo's GitHub page, go to **Settings → Pages**.
2. Under "Build and deployment", set **Source: Deploy from a branch**,
   branch **main**, folder **/(root)**. Save.
3. GitHub gives you a live URL after a minute or two, typically:
   `https://<your-username>.github.io/japan-trip-planner/`

### 6. Share it

Send that URL to your family. First time each person opens it, it asks for
their name (remembered on their device) — after that it's just tapping
around: search or click the map to drop a pin, fill in a few details, 👍
each other's ideas, and assign dates in the Itinerary tab.

---

## Updating the site later

Whenever you want new features or tweaks, just edit the files and:

```
git add .
git commit -m "describe the change"
git push
```

GitHub Pages redeploys automatically within a minute or two.

## What's under the hood

- **Map**: [Leaflet](https://leafletjs.com/) + Esri's free World Street Map tiles (English labels, no API key)
- **Search**: [Photon](https://photon.komoot.io/) (Komoot's free OpenStreetMap-based geocoder)
- **Data**: Firebase Firestore, synced live to every open tab via `onSnapshot`
- **Identity**: a name typed once, stored in that browser's `localStorage` —
  not a real login, just enough to attribute votes/additions
