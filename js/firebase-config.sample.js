// 1. Copy this file and rename the copy to "firebase-config.js" (same folder).
// 2. Go to your Firebase project → ⚙️ Project settings → General → "Your apps"
//    → Web app → and copy the values it gives you into the object below.
// 3. Save. That's it — do not edit anything else in this file.
//
// This config is safe to commit to a public GitHub repo: it's a public
// client identifier, not a secret. Firestore Security Rules (set up in the
// Firebase console, see README.md) are what actually control access.

export const firebaseConfig = {
  apiKey: "PASTE_YOUR_API_KEY_HERE",
  authDomain: "PASTE_YOUR_AUTH_DOMAIN_HERE",
  projectId: "PASTE_YOUR_PROJECT_ID_HERE",
  storageBucket: "PASTE_YOUR_STORAGE_BUCKET_HERE",
  messagingSenderId: "PASTE_YOUR_SENDER_ID_HERE",
  appId: "PASTE_YOUR_APP_ID_HERE"
};
