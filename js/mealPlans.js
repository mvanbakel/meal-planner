// mealPlans: rules for the weekly meal plan. No HTML here.
//
// The plan records what you EAT each day. If you batch-cook, plan 1 portion
// on each day you'll eat it; the week's total per recipe (summarize()) is the
// batch to cook and shop for.
//
// Two collections (see README "Data model"):
//   mealPlans      - one per week: { weekStart }  (weekStart = that Monday, "2026-09-28")
//   mealPlanItems  - one per meal on a day: { mealPlanId, recipeId, day, portions, position }
//                    day is 0-6, where 0 = Monday
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const mealPlans = (() => {
  // --- Dates ---
  // Weeks are identified by their Monday, written as "YYYY-MM-DD".
  // All date maths uses the local calendar (not UTC), so a week never shifts
  // by a day because of time zones.

  function toIsoDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function fromIsoDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function isIsoDate(text) {
    return /^\d{4}-\d{2}-\d{2}$/.test(text ?? "") && !Number.isNaN(fromIsoDate(text).getTime());
  }

  // The Monday on or before `date`.
  // JavaScript numbers days Sunday=0 … Saturday=6. (getDay() + 6) % 7 turns
  // that into Monday=0 … Sunday=6, which is how many days to step back.
  function weekStartFor(date = new Date()) {
    const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return toIsoDate(monday);
  }

  function addDays(iso, days) {
    const date = fromIsoDate(iso);
    date.setDate(date.getDate() + days);
    return toIsoDate(date);
  }

  // --- Plans and items ---

  function findPlan(weekStart) {
    return store.list("mealPlans").find((plan) => plan.weekStart === weekStart) ?? null;
  }

  // Plans are only created once something is added, so browsing empty weeks
  // doesn't fill storage with empty plans.
  function findOrCreatePlan(weekStart) {
    return findPlan(weekStart) ?? store.insert("mealPlans", { weekStart });
  }

  function isValidPortions(portions) {
    return Number.isInteger(portions) && portions >= 1;
  }

  // The week's items, each with its recipe's name attached, in day order.
  // Items whose recipe no longer exists are skipped.
  function listItems(weekStart) {
    const plan = findPlan(weekStart);
    if (!plan) return [];
    const recipesById = new Map(store.list("recipes").map((r) => [r.id, r]));
    return store
      .list("mealPlanItems")
      .filter((item) => item.mealPlanId === plan.id && recipesById.has(item.recipeId))
      .map((item) => ({ ...item, recipeName: recipesById.get(item.recipeId).name }))
      .sort((a, b) => a.day - b.day || a.position - b.position);
  }

  // Returns the new item, or null if the input isn't valid.
  function addItem(weekStart, day, recipeId, portions) {
    if (!DAYS[day] || !store.get("recipes", recipeId) || !isValidPortions(portions)) return null;
    const plan = findOrCreatePlan(weekStart);
    const position = store.list("mealPlanItems").filter((i) => i.mealPlanId === plan.id).length;
    return store.insert("mealPlanItems", { mealPlanId: plan.id, recipeId, day, portions, position });
  }

  // Adds the same meal to several days (for batch cooking). `days`: day numbers.
  // Returns how many were added.
  function addToDays(weekStart, days, recipeId, portions) {
    return days.filter((day) => addItem(weekStart, day, recipeId, portions)).length;
  }

  // `changes` can include recipeId, portions and/or day. Invalid values are ignored.
  function updateItem(id, changes) {
    const safe = {};
    if ("portions" in changes && isValidPortions(changes.portions)) safe.portions = changes.portions;
    if ("recipeId" in changes && store.get("recipes", changes.recipeId)) safe.recipeId = changes.recipeId;
    if ("day" in changes && DAYS[changes.day]) safe.day = changes.day;
    return store.update("mealPlanItems", id, safe);
  }

  function removeItem(id) {
    store.remove("mealPlanItems", id);
  }

  // Totals for the week, grouped by recipe. Example: burrito bowl on Monday (2)
  // and Wednesday (2) plus pasta on Tuesday (3) gives
  //   { totalPortions: 7, recipes: [
  //       { recipeId, name: "Chicken Burrito Bowl", portions: 4, days: [0, 2] },
  //       { recipeId, name: "Chicken Pasta",        portions: 3, days: [1] } ] }
  // Later phases use this to know how much of each recipe to cook and shop for.
  function summarize(weekStart) {
    const byRecipe = new Map();
    for (const item of listItems(weekStart)) {
      const entry = byRecipe.get(item.recipeId)
        ?? { recipeId: item.recipeId, name: item.recipeName, portions: 0, days: [] };
      entry.portions += item.portions;
      if (!entry.days.includes(item.day)) entry.days.push(item.day);
      byRecipe.set(item.recipeId, entry);
    }
    const recipes = [...byRecipe.values()].sort((a, b) => a.name.localeCompare(b.name));
    const totalPortions = recipes.reduce((sum, r) => sum + r.portions, 0);
    return { totalPortions, recipes };
  }

  return {
    weekStartFor, addDays, fromIsoDate, isIsoDate,
    findPlan, listItems, addItem, addToDays, updateItem, removeItem, summarize,
  };
})();
