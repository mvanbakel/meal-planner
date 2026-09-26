// store: the ONLY file that knows how data is saved.
//
// Everything lives in the browser's localStorage under one key, organised into
// named "collections" (like tables in a database): recipes, ingredients,
// recipeIngredients, and later mealPlans, flyers, etc.
//
// To move to a real database later (Supabase, an API, ...), rewrite the
// internals of this file and keep the same functions. Nothing else changes.
const store = (() => {
  const STORAGE_KEY = "meal-planner.data";
  const SCHEMA_VERSION = 1;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // Corrupt or unreadable data: fall through and start empty.
    }
    return { version: SCHEMA_VERSION };
  }

  function save(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  // Returns a copy of every record in a collection ([] if it doesn't exist yet).
  function list(collection) {
    return (load()[collection] ?? []).map((record) => ({ ...record }));
  }

  function get(collection, id) {
    return list(collection).find((record) => record.id === id) ?? null;
  }

  // Adds a record, giving it an id and timestamps. Returns the saved record.
  function insert(collection, fields) {
    return insertMany(collection, [fields])[0];
  }

  // Adds several records in one save (much faster than many inserts).
  function insertMany(collection, fieldsList) {
    const data = load();
    const now = new Date().toISOString();
    const records = fieldsList.map((fields) => ({ id: crypto.randomUUID(), ...fields, createdAt: now, updatedAt: now }));
    data[collection] = [...(data[collection] ?? []), ...records];
    save(data);
    return records.map((record) => ({ ...record }));
  }

  // Merges `changes` into the record with this id. Returns it, or null if not found.
  function update(collection, id, changes) {
    const data = load();
    const record = (data[collection] ?? []).find((r) => r.id === id);
    if (!record) return null;
    Object.assign(record, changes, { id, updatedAt: new Date().toISOString() });
    save(data);
    return { ...record };
  }

  // Deletes every record in the collection for which `shouldRemove(record)` is true.
  function removeWhere(collection, shouldRemove) {
    const data = load();
    data[collection] = (data[collection] ?? []).filter((r) => !shouldRemove(r));
    save(data);
  }

  function remove(collection, id) {
    removeWhere(collection, (record) => record.id === id);
  }

  // ---------- Backups ----------

  // Everything, as text to save in a file. `app` and `exportedAt` identify the file.
  function exportData() {
    return JSON.stringify({ app: "meal-planner", exportedAt: new Date().toISOString(), ...load() }, null, 2);
  }

  // Reads a backup file's text WITHOUT saving it. Returns { data, counts, exportedAt } or { error }.
  // counts: how many records of each kind the backup holds, to show before replacing.
  function readBackup(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { error: "This file isn't a Meal Planner backup (it isn't readable JSON)." };
    }
    if (!data || data.app !== "meal-planner" || typeof data.version !== "number") {
      return { error: "This file isn't a Meal Planner backup." };
    }
    if (data.version > SCHEMA_VERSION) {
      return { error: "This backup is from a newer version of the app. Refresh the page and try again." };
    }
    const collections = Object.entries(data).filter(([, value]) => Array.isArray(value));
    if (collections.some(([, records]) => records.some((r) => !r || typeof r.id !== "string"))) {
      return { error: "This backup looks damaged (some records are missing their id)." };
    }
    const { exportedAt } = data;
    delete data.app;
    delete data.exportedAt;
    return { data, exportedAt, counts: Object.fromEntries(collections.map(([name, records]) => [name, records.length])) };
  }

  // Replaces ALL data on this device with a backup read by readBackup().
  function replaceAll(data) {
    save(data);
  }

  return { list, get, insert, insertMany, update, remove, removeWhere, exportData, readBackup, replaceAll };
})();
