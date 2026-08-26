// AnK ReVibe extension config.
//
// Keep in sync with the web app's .env.local (NEXT_PUBLIC_SUPABASE_URL /
// NEXT_PUBLIC_SUPABASE_ANON_KEY). The anon key is safe to ship here - it
// grants nothing on its own, because every table is behind RLS requiring an
// authenticated user. The extension gets that user's access token from the
// web app; see content-scripts/ankrevibe.js.
const CONFIG = {
  SUPABASE_URL: "https://bmgjqnrazdfgjcbmtasp.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtZ2pxbnJhemRmZ2pjYm10YXNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc3MDQ2ODAsImV4cCI6MjEwMzI4MDY4MH0.EKMIDCG00RRsZBYeqo0vI8jNSFyKrf6Q2VE2TGlnm90",

  // Where the AnK ReVibe web app runs. Add the production origin here, to
  // host_permissions, and to the bridge content script's matches once it is
  // deployed - the extension reads the auth token from this page.
  APP_ORIGINS: ["http://localhost:3000"],
};

// Reachable from the service worker and from content scripts.
if (typeof globalThis !== "undefined") globalThis.ANKREVIBE_CONFIG = CONFIG;
