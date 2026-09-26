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
// Sign-in uses a 6-digit code sent by email (no password).
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
      throw new SyncError(response.status === 401 ? "signedOut" : "error", detail);
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

  async function sendCode(email) {
    await request("/auth/v1/otp", { method: "POST", auth: false, body: { email: email.trim(), create_user: true } });
  }

  async function verifyCode(email, code) {
    const auth = await request("/auth/v1/verify", { method: "POST", auth: false,
      body: { type: "email", email: email.trim(), token: code.trim() } });
    // Data already on this device that was never synced counts as "unsent changes",
    // so it's never thrown away without asking.
    setState({ session: sessionFrom(auth), version: null, dirty: store.hasData() });
    await syncNow();
  }

  async function signOut() {
    try {
      await request("/auth/v1/logout", { method: "POST" });
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
    sendCode, verifyCode, signOut, syncNow, resolveConflict, conflictSummary,
    isSignedIn: () => Boolean(getState().session),
    email: () => getState().session?.email ?? null,
    lastSyncedAt: () => getState().lastSyncedAt ?? null,
    status: () => ({ status, message }),
    onStatus: (listener) => statusListeners.push(listener),
    onRemoteData: (listener) => dataListeners.push(listener),
  };
})();
