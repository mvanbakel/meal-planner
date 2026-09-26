// sync: keeps this device's data and the cloud copy (Supabase) the same,
// so the app shows the same recipes on your phone and your computer.
//
// How it works:
//   - The app always reads and writes this device's copy (store.js).
//   - After each change, the whole data set is sent to the cloud (1.5 s later,
//     so a burst of changes is sent once).
//   - When the app opens, or you come back to it, it checks the cloud for
//     newer data from your other device and loads it.
//   - The cloud row has a `version` number that goes up by 1 on every save.
//     This device remembers which version its data is based on. If the cloud
//     has moved on AND this device has unsent changes, both devices changed
//     things: instead of silently overwriting one, the app asks which to keep.
//
// Sign-in is by email (no password). Supabase's free email service sends a
// sign-in LINK (its templates can't be changed to send a code), so there are
// three ways in:
//   1. Click the link: it opens the app with the sign-in in the address
//      (#access_token=...), which completeSignInFromLink() picks up.
//   2. Copy the link and paste it into the app (needed for the iPhone
//      home-screen app, which doesn't share data with Safari).
//   3. Type a 6-digit code, if the email has one.
// The free email service only sends ~2 emails an hour, so once signed in you
// can also set a password (setPassword) and sign in with it on other devices
// (signInWithPassword), with no email needed.
//
// The URL and key below are public by design: they only allow what the
// database's security rules allow (each signed-in person, their own row).
const SUPABASE_URL = "https://zqnlayfkimegjuhchroh.supabase.co";
const SUPABASE_KEY = "sb_publishable_GBtwzQalt2ODQqQsqtPwWQ_hDWd98Q4";
const SYNC_TABLE = "/rest/v1/meal_planner_data";

class SyncError extends Error {
  // kind: "offline" (no connection), "signedOut" (sign-in expired), or "error"
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const sync = (() => {
  let status = "off"; // off | syncing | synced | offline | conflict | error | signedOut
  let message = "";
  let conflict = null; // { remote } while waiting for the user to choose
  let running = null;  // the sync in progress, so two don't run at once
  let pushTimer = null;
  let changeCount = 0; // local changes made since the page loaded
  const statusListeners = [];
  const dataListeners = [];

  const getState = () => store.getSyncState();
  const setState = (changes) => store.setSyncState({ ...getState(), ...changes });

  function setStatus(newStatus, newMessage = "") {
    status = newStatus;
    message = newMessage;
    statusListeners.forEach((listener) => listener());
  }

  // ---------- Talking to Supabase ----------

  async function request(path, { method = "GET", body, auth = true, prefer } = {}) {
    const headers = { apikey: SUPABASE_KEY, "Content-Type": "application/json" };
    if (auth) headers.Authorization = `Bearer ${await accessToken()}`;
    if (prefer) headers.Prefer = prefer;

    let response;
    try {
      response = await fetch(SUPABASE_URL + path, { method, headers, body: body && JSON.stringify(body) });
    } catch {
      throw new SyncError("offline", "Can't reach the sync server. Changes are saved on this device and will sync when you're back online.");
    }
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const detail = json?.msg || json?.message || json?.error_description || `error ${response.status}`;
      // 401, or "session_not_found": this device's sign-in has ended (e.g. it was
      // signed out from elsewhere), even if its access token hasn't expired yet.
      const signedOut = response.status === 401 || json?.error_code === "session_not_found"
        || /session .*does not exist/i.test(detail);
      throw new SyncError(signedOut ? "signedOut" : "error", detail);
    }
    return json;
  }

  // Sign-in details from a Supabase auth answer. `expiresAt` is in milliseconds.
  function sessionFrom(auth) {
    return {
      accessToken: auth.access_token,
      refreshToken: auth.refresh_token,
      expiresAt: Date.now() + auth.expires_in * 1000,
      email: auth.user?.email,
    };
  }

  // A valid access token, renewing it first if it's about to expire (they last ~1 hour).
  async function accessToken() {
    const { session } = getState();
    if (!session) throw new SyncError("signedOut", "Not signed in.");
    if (session.expiresAt - 60_000 > Date.now()) return session.accessToken;
    try {
      const renewed = await request("/auth/v1/token?grant_type=refresh_token",
        { method: "POST", auth: false, body: { refresh_token: session.refreshToken } });
      setState({ session: sessionFrom(renewed) });
      return renewed.access_token;
    } catch (error) {
      if (error.kind === "offline") throw error;
      setState({ session: null });
      throw new SyncError("signedOut", "Your sign-in expired. Sign in again to keep syncing.");
    }
  }

  // ---------- Signing in and out ----------

  // Where the email's link should bring you back to: this page's address.
  // (Supabase only allows addresses listed in its URL Configuration; for any
  // other it uses the Site URL.)
  function appAddress() {
    return location.origin + location.pathname;
  }

  async function sendCode(email) {
    await request(`/auth/v1/otp?redirect_to=${encodeURIComponent(appAddress())}`,
      { method: "POST", auth: false, body: { email: email.trim(), create_user: true } });
  }

  // Data already on this device that was never synced counts as "unsent
  // changes", so it's never thrown away without asking.
  async function startSession(session) {
    setState({ session, version: null, dirty: store.hasData() });
    await syncNow();
  }

  // `input` is either the 6-digit code or the whole sign-in link from the email.
  async function verifyCode(email, input) {
    const text = input.trim();
    if (!/^https?:\/\//i.test(text)) {
      const auth = await request("/auth/v1/verify", { method: "POST", auth: false,
        body: { type: "email", email: email.trim(), token: text } });
      return startSession(sessionFrom(auth));
    }

    // A pasted link looks like .../auth/v1/verify?token=abc123&type=magiclink&redirect_to=...
    // Its `token` can be exchanged for a sign-in directly, without opening the link.
    let link;
    try {
      link = new URL(text);
    } catch {
      throw new SyncError("error", "That doesn't look like the sign-in link from the email.");
    }
    const tokenHash = link.searchParams.get("token");
    if (!tokenHash) throw new SyncError("error", "That doesn't look like the sign-in link from the email.");
    const auth = await request("/auth/v1/verify", { method: "POST", auth: false,
      body: { type: link.searchParams.get("type") || "email", token_hash: tokenHash } });
    return startSession(sessionFrom(auth));
  }

  async function signInWithPassword(email, password) {
    const auth = await request("/auth/v1/token?grant_type=password", { method: "POST", auth: false,
      body: { email: email.trim(), password } });
    return startSession(sessionFrom(auth));
  }

  // Sets (or changes) the password of the signed-in account.
  async function setPassword(password) {
    try {
      await request("/auth/v1/user", { method: "PUT", body: { password } });
    } catch (error) {
      if (error.kind === "signedOut") {
        handleError(error); // shows "sign in again" everywhere
        throw new SyncError("signedOut", "This device's sign-in has ended, so the password couldn't be saved. Sign in again, then set it.");
      }
      throw error;
    }
  }

  // After clicking the email's link, the app opens with the sign-in in the address:
  //   #access_token=...&refresh_token=...&expires_in=3600&type=magiclink
  // or, if the link was used or expired: #error=...&error_description=...
  // Returns null (nothing to do), { signedIn: true } or { error: "message" }.
  function completeSignInFromLink() {
    const params = new URLSearchParams(location.hash.replace(/^#\/?/, ""));
    if (params.get("error_description")) {
      return { error: `The sign-in link didn't work (${params.get("error_description").replace(/\+/g, " ")}). Send a new one.` };
    }
    const accessToken = params.get("access_token");
    if (!accessToken) return null;
    // The access token contains the account's email: it's three dot-separated
    // parts, and the middle one is base64 text holding JSON.
    let email = null;
    try {
      const payload = accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      email = JSON.parse(atob(payload)).email ?? null;
    } catch {
      // Not important: the email is only shown on screen.
    }
    startSession({
      accessToken,
      refreshToken: params.get("refresh_token"),
      expiresAt: Date.now() + Number(params.get("expires_in") || 3600) * 1000,
      email,
    });
    return { signedIn: true };
  }

  async function signOut() {
    try {
      // scope=local: sign out THIS device only. (Supabase's default signs out
      // every device, which would silently break sync on your other ones.)
      await request("/auth/v1/logout?scope=local", { method: "POST" });
    } catch {
      // Signing out locally is what matters.
    }
    setState({ session: null, version: null, dirty: false });
    conflict = null;
    setStatus("off");
  }

  // ---------- Syncing ----------

  // Loads the cloud copy onto this device.
  function applyRemote(remote) {
    store.replaceAll(remote.data, { fromSync: true });
    setState({ version: remote.version, dirty: false });
    dataListeners.forEach((listener) => listener());
  }

  // Sends this device's data. `baseVersion` is the cloud version it's based on
  // (null if the cloud has nothing yet). The update only happens if the cloud is
  // still at that version; otherwise another device saved in between.
  // Returns true if saved, false if the cloud had moved on.
  async function push(baseVersion) {
    const countAtStart = changeCount;
    const body = { data: store.getAll(), version: (baseVersion ?? 0) + 1, updated_at: new Date().toISOString() };
    const rows = baseVersion === null
      ? await request(SYNC_TABLE, { method: "POST", body, prefer: "return=representation" })
      : await request(`${SYNC_TABLE}?version=eq.${baseVersion}`, { method: "PATCH", body, prefer: "return=representation" });
    if (!rows || rows.length === 0) return false;
    // Only mark as sent if nothing changed while we were sending.
    setState({ version: body.version, dirty: changeCount !== countAtStart });
    return true;
  }

  async function fetchRemote() {
    const rows = await request(`${SYNC_TABLE}?select=data,version,updated_at`);
    return rows[0] ?? null;
  }

  function handleError(error) {
    if (error.kind === "offline") setStatus("offline", error.message);
    else if (error.kind === "signedOut") {
      setState({ session: null });
      setStatus("signedOut", "Your sync sign-in has ended. Sign in again to keep syncing; your data is safe on this device.");
    }
    else setStatus("error", `Sync problem: ${error.message}`);
  }

  function markSynced() {
    setState({ lastSyncedAt: new Date().toISOString() });
    setStatus("synced");
  }

  // Brings this device and the cloud up to date. Safe to call any time.
  function syncNow() {
    if (!getState().session) {
      setStatus("off");
      return Promise.resolve();
    }
    if (conflict) return Promise.resolve(); // waiting for the user to choose
    running ??= (async () => {
      setStatus("syncing");
      try {
        const remote = await fetchRemote();
        const { version, dirty } = getState();

        if (!remote) {
          // Nothing in the cloud yet: this device's data becomes the cloud copy.
          if (!(await push(null))) throw new SyncError("error", "another device saved at the same moment; try again");
        } else if (remote.version === version) {
          // The cloud hasn't changed since our last sync: just send our changes.
          if (dirty && !(await push(version))) {
            conflict = { remote: await fetchRemote() };
            return setStatus("conflict");
          }
        } else if (!dirty) {
          // The cloud has newer data and this device has no unsent changes: load it.
          applyRemote(remote);
        } else {
          // Both changed: ask the user.
          conflict = { remote };
          return setStatus("conflict");
        }
        markSynced();
      } catch (error) {
        handleError(error);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  // The user's answer to a conflict: "cloud" (use the other device's data)
  // or "device" (keep this device's data and overwrite the cloud).
  async function resolveConflict(choice) {
    if (!conflict) return;
    const { remote } = conflict;
    conflict = null;
    try {
      if (choice === "cloud") applyRemote(remote);
      else if (!(await push(remote.version))) return syncNow();
      markSynced();
    } catch (error) {
      handleError(error);
    }
  }

  // A short summary of both sides of a conflict, for the question to the user.
  function conflictSummary() {
    if (!conflict) return null;
    const count = (data, name) => (data?.[name] ?? []).length;
    const describe = (data) => ({ recipes: count(data, "recipes"), mealPlans: count(data, "mealPlans"), nutritionGoals: count(data, "nutritionGoals") });
    return {
      device: describe(store.getAll()),
      cloud: describe(conflict.remote.data),
      cloudUpdatedAt: conflict.remote.updated_at,
    };
  }

  // ---------- Wiring ----------

  // Every change in the app: remember there's something to send, and send it soon.
  store.onChange(() => {
    changeCount++;
    if (!getState().session) return;
    setState({ dirty: true });
    clearTimeout(pushTimer);
    pushTimer = setTimeout(syncNow, 1500);
  });

  // Check for changes from the other device when the app is opened again or
  // comes back online.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncNow();
  });
  window.addEventListener("online", () => syncNow());

  return {
    sendCode, verifyCode, completeSignInFromLink, signInWithPassword, setPassword, signOut, syncNow, resolveConflict, conflictSummary,
    isSignedIn: () => Boolean(getState().session),
    email: () => getState().session?.email ?? null,
    lastSyncedAt: () => getState().lastSyncedAt ?? null,
    status: () => ({ status, message }),
    onStatus: (listener) => statusListeners.push(listener),
    onRemoteData: (listener) => dataListeners.push(listener),
  };
})();
