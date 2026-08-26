// Runs on the AnK ReVibe web app. Signals that the extension is installed
// and hands its Supabase access token to the service worker.
//
// IMPORTANT: the web app uses @supabase/ssr, which stores the session in
// COOKIES rather than localStorage - that is the whole point of the ssr
// package. ResellOS read localStorage, so that path alone will find nothing
// here. This tries three sources in order of reliability; see README for the
// one-line change that makes the first one work.
(function () {
  "use strict";

  const PROJECT_REF = "bmgjqnrazdfgjcbmtasp";
  const EXPLICIT_KEY = "ankrevibe_extension_token";
  const SESSION_KEY = "sb-" + PROJECT_REF + "-auth-token";

  // Lets the web app detect the extension without a round trip.
  const marker = document.createElement("div");
  marker.id = "ankrevibe-extension-installed";
  marker.style.display = "none";
  document.documentElement.appendChild(marker);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type === "ANKREVIBE_EXTENSION_CHECK") {
      const version = chrome.runtime.getManifest?.()?.version || "0.1.0";
      window.postMessage(
        { type: "ANKREVIBE_EXTENSION_RESPONSE", installed: true, version },
        window.location.origin
      );
    }
  });

  function tokenFromValue(raw) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      // supabase-js persists either the session object or a [access, refresh]
      // pair depending on version.
      if (Array.isArray(parsed)) return parsed[0] || null;
      return parsed?.currentSession?.access_token || parsed?.access_token || null;
    } catch {
      // A bare token string.
      return raw.indexOf(".") > 0 ? raw : null;
    }
  }

  /** 1. An explicit hand-off the app can opt into. Most reliable. */
  function fromExplicitKey() {
    try {
      return localStorage.getItem(EXPLICIT_KEY);
    } catch {
      return null;
    }
  }

  /** 2. supabase-js browser storage, if the app ever uses the non-ssr client. */
  function fromLocalStorage() {
    try {
      const direct = tokenFromValue(localStorage.getItem(SESSION_KEY));
      if (direct) return direct;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (key.indexOf("auth-token") >= 0 || key.indexOf("supabase") >= 0) {
          const token = tokenFromValue(localStorage.getItem(key));
          if (token) return token;
        }
      }
    } catch {
      /* storage blocked */
    }
    return null;
  }

  /**
   * @supabase/ssr encodes the session as `base64-<base64url payload>`, for
   * both the single-cookie and the chunked form. Decode before parsing -
   * skipping this was why the cookie path originally recovered nothing.
   */
  function decodeSessionValue(raw) {
    let value = decodeURIComponent(raw);
    if (value.indexOf("base64-") === 0) {
      const payload = value.slice("base64-".length).replace(/-/g, "+").replace(/_/g, "/");
      try {
        value = atob(payload);
      } catch {
        return null;
      }
    }
    return value;
  }

  /**
   * 3. The @supabase/ssr cookie. Readable because the browser client needs
   * it too, so it is not httpOnly. Large sessions are split across
   * .0/.1/... chunks, which must be concatenated in order before decoding -
   * each chunk is a slice of one base64 string, not valid base64 itself.
   */
  function fromCookie() {
    try {
      const jar = {};
      for (const part of document.cookie.split(";")) {
        const idx = part.indexOf("=");
        if (idx < 0) continue;
        jar[part.slice(0, idx).trim()] = part.slice(idx + 1);
      }

      const exact = jar[SESSION_KEY];
      if (exact) {
        const decoded = decodeSessionValue(exact);
        return decoded ? tokenFromValue(decoded) : null;
      }

      const chunks = Object.keys(jar)
        .filter((k) => k.indexOf(SESSION_KEY + ".") === 0)
        .sort((a, b) => Number(a.split(".").pop()) - Number(b.split(".").pop()));
      if (!chunks.length) return null;

      const decoded = decodeSessionValue(chunks.map((k) => jar[k]).join(""));
      return decoded ? tokenFromValue(decoded) : null;
    } catch {
      return null;
    }
  }

  function getToken() {
    return fromExplicitKey() || fromLocalStorage() || fromCookie();
  }

  let lastSent = null;

  function sendToken() {
    const token = getToken();
    if (!token || token === lastSent) return;
    lastSent = token;
    chrome.runtime
      .sendMessage({ type: "ANKREVIBE_AUTH", token })
      .catch(() => {
        chrome.storage.local.set({
          ankrevibe_token: token,
          supabase_token: token,
        });
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sendToken);
  } else {
    sendToken();
  }
  // Access tokens rotate roughly hourly; re-read periodically.
  setInterval(sendToken, 60000);
})();
