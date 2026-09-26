// shopping: the in-store checklist. No HTML here.
//
// Built from the week's grocery list (grocery.js), grouped by store section.
// Saved data (see README "Data model"):
//   ingredients.category - the user's chosen section for an ingredient (all weeks)
//   shoppingChecks       - { mealPlanId, key }: items ticked off this week
const shopping = (() => {
  // The section for a grocery item: the user's choice if they made one,
  // otherwise a guess from the name. Merged items use their first ingredient.
  function categoryFor(item) {
    const ingredient = store.get("ingredients", item.ingredientIds[0]);
    return ingredient?.category
      ? { category: ingredient.category, guessed: false }
      : { category: guessCategory(item.name), guessed: true };
  }

  // Returns { sections: [{ category, items }], total, checkedCount }.
  // Each item is a grocery item plus { category, guessed, checked, meals }.
  function buildList(weekStart) {
    const plan = mealPlans.findPlan(weekStart);
    const checkedKeys = new Set(
      store.list("shoppingChecks").filter((c) => plan && c.mealPlanId === plan.id).map((c) => c.key));

    const items = grocery.buildList(weekStart).items.map((item) => ({
      ...item,
      ...categoryFor(item),
      checked: checkedKeys.has(item.key),
      meals: [...new Set(item.sources.map((s) => s.recipeName))],
    }));

    const sections = CATEGORIES
      .map((category) => ({ category, items: items.filter((item) => item.category === category) }))
      .filter((section) => section.items.length > 0);

    return { sections, total: items.length, checkedCount: items.filter((i) => i.checked).length };
  }

  function setChecked(weekStart, key, checked) {
    const plan = mealPlans.findPlan(weekStart);
    if (!plan) return;
    store.removeWhere("shoppingChecks", (c) => c.mealPlanId === plan.id && c.key === key);
    if (checked) store.insert("shoppingChecks", { mealPlanId: plan.id, key });
  }

  function uncheckAll(weekStart) {
    const plan = mealPlans.findPlan(weekStart);
    if (plan) store.removeWhere("shoppingChecks", (c) => c.mealPlanId === plan.id);
  }

  // Saves the section for every ingredient in the item (so it sticks for future weeks).
  function setCategory(item, category) {
    if (!CATEGORIES.includes(category)) return;
    for (const id of item.ingredientIds) store.update("ingredients", id, { category });
  }

  return { buildList, setChecked, uncheckAll, setCategory };
})();
