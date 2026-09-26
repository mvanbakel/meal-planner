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

  return { list, get, insert, insertMany, update, remove, removeWhere };
})();
