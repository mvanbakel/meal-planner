// grocery: builds the week's grocery list from the meal plan. No HTML here.
//
// The list itself is never saved. It's recalculated from the meal plan every
// time, so it's always up to date. Only the user's own changes are saved
// (see README "Data model"):
//   ingredientEquivalences - "1 can of black beans = 400 g" (applies to every week)
//   groceryMerges          - "show these items as one line" (per week)
//   groceryOverrides       - "I want 1 kg, not 975 g" (per week)

// ---------- Combining (pure functions: no saved data involved) ----------

// Which items can be added together. Weights go with weights and volumes with
// volumes (they can be converted), but count units only match themselves:
// 2 cans + 1 can = 3 cans, while 2 cans + 1 package can't be added.
function groupFor(unitKey) {
  const kind = findUnit(unitKey)?.kind;
  return kind === "count" ? `count:${unitKey}` : kind;
}

function kindOfGroup(group) {
  return group.startsWith("count:") ? "count" : group;
}

// Picks the unit to show a total in.
//   - One unit used everywhere: keep it (3 tbsp stays 3 tbsp),
//     except g/ml become kg/L from 1,000 up (1,100 g -> 1.1 kg).
//   - Mixed units (g and kg): show in g, or kg from 1,000 g up.
// `baseTotal` is the total in the base unit (g or ml), or the count.
function chooseDisplayUnit(group, baseTotal, unitsUsed) {
  const kind = kindOfGroup(group);
  if (kind === "count") return { quantity: baseTotal, unit: unitsUsed[0] };

  let unit = unitsUsed.length === 1 ? unitsUsed[0] : BASE_UNITS[kind];
  let quantity = baseTotal / findUnit(unit).toBase;
  if (unit === "g" && quantity >= 1000) [unit, quantity] = ["kg", quantity / 1000];
  if (unit === "ml" && quantity >= 1000) [unit, quantity] = ["L", quantity / 1000];
  return { quantity, unit };
}

// Fills in the final quantity/unit of an item from its running total,
// rounding up whole-only units only now, after everything has been added.
function finishItem(item) {
  const display = chooseDisplayUnit(item.group, item.baseTotal, item.unitsUsed);
  const rounding = roundUpIfWhole(display.quantity, display.unit);
  return { ...item, unit: display.unit, quantity: rounding.quantity, exact: rounding.exact, rounded: rounding.rounded };
}

// Combines required ingredient lines into grocery items.
//
// `lines`: one per ingredient per recipe, already scaled:
//   { ingredientId, name, quantity, unit, recipeName, portions }
// `equivalences`: the user's conversions, e.g.
//   { ingredientId, fromUnit: "can", toQuantity: 400, toUnit: "g" }
//
// Lines are added together only when they're the SAME ingredient AND their
// units can be added (see groupFor). Everything else stays a separate item,
// so "2 cans black beans" and "400 g black beans" stay apart until the user
// says how many grams are in a can.
function combineGroceryItems(lines, equivalences = []) {
  const items = new Map();

  for (const line of lines) {
    // With "1 can = 400 g", 2 cans is counted as 2 × 400 = 800 g.
    const via = equivalences.find((e) => e.ingredientId === line.ingredientId && e.fromUnit === line.unit);
    const asUnit = via ? via.toUnit : line.unit;
    const asQuantity = via ? line.quantity * via.toQuantity : line.quantity;

    const group = groupFor(asUnit);
    const key = `${line.ingredientId}|${group}`;
    const item = items.get(key) ?? {
      key, sourceKeys: [key], ingredientIds: [line.ingredientId], name: line.name,
      group, baseTotal: 0, unitsUsed: [], sources: [],
    };

    // Running total in the base unit (g or ml) so g and kg can be added.
    item.baseTotal += toBaseQuantity(asQuantity, asUnit);
    if (!item.unitsUsed.includes(asUnit)) item.unitsUsed.push(asUnit);
    item.sources.push({ ...line, via: via ?? null, asQuantity, asUnit });
    items.set(key, item);
  }

  return [...items.values()].map(finishItem);
}

// Joins several items into one line (a manual merge by the user, e.g.
// "Bell pepper" + "Bell peppers"). Returns null if their units can't be added.
function mergeGroceryItems(parts, name, key) {
  if (parts.some((part) => part.group !== parts[0].group)) return null;
  return finishItem({
    key,
    sourceKeys: parts.flatMap((p) => p.sourceKeys),
    ingredientIds: [...new Set(parts.flatMap((p) => p.ingredientIds))],
    name,
    group: parts[0].group,
    baseTotal: parts.reduce((sum, p) => sum + p.baseTotal, 0),
    unitsUsed: [...new Set(parts.flatMap((p) => p.unitsUsed))],
    sources: parts.flatMap((p) => p.sources),
  });
}

// The sum behind an item, written out: "600 g + 500 g = 1,100 g = 1.1 kg".
// With mixed units each part is shown converted: "600 g + 0.5 kg (500 g) = 1,100 g ..."
// Returns null when there's nothing to explain (one recipe, nothing converted).
function explainTotal(item) {
  const base = BASE_UNITS[kindOfGroup(item.group)]; // undefined for count units
  const mixed = item.unitsUsed.length > 1;
  const totalUnit = mixed ? base : item.unitsUsed[0];
  const [first] = item.sources;
  if (item.sources.length === 1 && !first.via && totalUnit === item.unit && !item.rounded) return null;

  const parts = item.sources.map((s) => {
    const text = formatAmount(s.asQuantity, s.asUnit);
    return mixed && s.asUnit !== base ? `${text} (${formatAmount(toBaseQuantity(s.asQuantity, s.asUnit), base)})` : text;
  });
  const total = item.baseTotal / (findUnit(totalUnit).toBase ?? 1);

  let text = parts.join(" + ");
  if (parts.length > 1 || mixed) text += ` = ${formatAmount(total, totalUnit)}`;
  if (totalUnit !== item.unit) text += ` = ${formatAmount(item.exact, item.unit)}`;
  if (item.rounded) text += `, rounded up to ${formatAmount(item.quantity, item.unit)}`;
  return text;
}

// ---------- The week's list (uses saved data) ----------

const grocery = (() => {
  // Every ingredient line needed for the week, scaled to the planned portions.
  // Uses the EXACT scaled amount; rounding happens after combining.
  function requiredLines(weekStart) {
    return mealPlans.summarize(weekStart).recipes.flatMap((planned) => {
      const recipe = recipes.getRecipe(planned.recipeId);
      return recipe.ingredients.map((row) => ({
        ingredientId: row.ingredientId,
        name: row.name,
        quantity: (row.quantity * planned.portions) / recipe.portions,
        unit: row.unit,
        recipeName: recipe.name,
        portions: planned.portions,
      }));
    });
  }

  function forPlan(collection, plan) {
    return plan ? store.list(collection).filter((record) => record.mealPlanId === plan.id) : [];
  }

  // Returns { items, conflicts, equivalences }.
  //   items        - the grocery list, alphabetical
  //   conflicts    - ingredients listed more than once because their units
  //                  can't be added (the user can fix this with an equivalence)
  //   equivalences - the conversions that were used
  function buildList(weekStart) {
    const plan = mealPlans.findPlan(weekStart);
    const lines = requiredLines(weekStart);
    const allEquivalences = store.list("ingredientEquivalences");
    let items = combineGroceryItems(lines, allEquivalences);

    // 1. Apply the user's merges. A merge whose items are gone is skipped.
    for (const merge of forPlan("groceryMerges", plan)) {
      const parts = items.filter((item) => merge.keys.includes(item.key));
      if (parts.length === 0) continue;
      const merged = mergeGroceryItems(parts, merge.name, `merge:${merge.id}`);
      if (!merged) continue; // units no longer compatible: leave them separate
      items = [...items.filter((item) => !parts.includes(item)), { ...merged, mergeId: merge.id }];
    }

    // Write out the sum behind each calculated amount (before any hand edits).
    items = items.map((item) => ({ ...item, explanation: explainTotal(item) }));

    // 2. Apply the user's edited amounts. If the meal plan has changed since
    // the edit, the calculated amount won't match any more: flag it as `stale`.
    const overrides = forPlan("groceryOverrides", plan);
    items = items.map((item) => {
      const override = overrides.find((o) => o.key === item.key);
      if (!override) return item;
      const stale = override.calculatedUnit !== item.unit || !sameQuantity(override.calculatedQuantity, item.quantity);
      return {
        ...item,
        calculated: { quantity: item.quantity, unit: item.unit },
        override: { id: override.id, stale },
        quantity: override.quantity,
        unit: override.unit,
        rounded: false,
      };
    });

    // 3. Find ingredients that appear more than once because of units.
    const byIngredient = new Map();
    for (const item of items) {
      if (item.ingredientIds.length !== 1) continue; // merged items are the user's choice
      const list = byIngredient.get(item.ingredientIds[0]) ?? [];
      byIngredient.set(item.ingredientIds[0], [...list, item]);
    }
    const conflicts = [...byIngredient.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([ingredientId, list]) => ({
        ingredientId,
        name: list[0].name,
        units: [...new Set(list.flatMap((item) => item.sources.map((s) => s.unit)))],
      }));

    const usedEquivalences = allEquivalences
      .filter((e) => lines.some((l) => l.ingredientId === e.ingredientId && l.unit === e.fromUnit))
      .map((e) => ({ ...e, name: store.get("ingredients", e.ingredientId)?.name ?? "?" }));

    items.sort((a, b) => a.name.localeCompare(b.name));
    return { items, conflicts, equivalences: usedEquivalences };
  }

  // "1 fromUnit of this ingredient = toQuantity toUnit". Returns an error
  // message, or null on success. Replaces any existing rule for the same unit.
  function setEquivalence(ingredientId, fromUnit, toQuantity, toUnit) {
    if (!findUnit(fromUnit) || !findUnit(toUnit)) return "Choose both units.";
    if (groupFor(fromUnit) === groupFor(toUnit)) return "Those units can already be added together.";
    if (!(toQuantity > 0)) return "Enter an amount like 400 or 1.5.";
    store.removeWhere("ingredientEquivalences",
      (e) => e.ingredientId === ingredientId && e.fromUnit === fromUnit);
    store.insert("ingredientEquivalences", { ingredientId, fromUnit, toQuantity, toUnit });
    return null;
  }

  function removeEquivalence(id) {
    store.remove("ingredientEquivalences", id);
  }

  // Joins the chosen items into one line called `name`. Returns an error
  // message, or null on success. Merging an already-merged item replaces
  // that merge with the bigger one.
  function mergeItems(weekStart, items, name) {
    if (items.length < 2) return "Select at least two items to merge.";
    if (!mergeGroceryItems(items, name, "check")) {
      return "Those items use units that can't be added together (for example cans and grams).";
    }
    const plan = mealPlans.findPlan(weekStart);
    for (const item of items) {
      if (item.mergeId) store.remove("groceryMerges", item.mergeId);
    }
    // Edited amounts on the old lines no longer apply to the new combined line.
    const oldKeys = items.map((item) => item.key);
    store.removeWhere("groceryOverrides", (o) => o.mealPlanId === plan.id && oldKeys.includes(o.key));
    store.insert("groceryMerges", {
      mealPlanId: plan.id,
      keys: items.flatMap((item) => item.sourceKeys),
      name: String(name ?? "").trim() || items[0].name,
    });
    return null;
  }

  function unmerge(item) {
    store.remove("groceryMerges", item.mergeId);
    store.removeWhere("groceryOverrides", (o) => o.key === item.key);
  }

  // Saves a hand-edited amount for an item. Returns an error message or null.
  function setOverride(weekStart, item, quantity, unit) {
    if (quantity === null) return "Enter an amount like 1, 1.5 or 1/2.";
    if (!findUnit(unit)) return "Choose a unit.";
    const plan = mealPlans.findPlan(weekStart);
    const calculated = item.calculated ?? { quantity: item.quantity, unit: item.unit };
    store.removeWhere("groceryOverrides", (o) => o.mealPlanId === plan.id && o.key === item.key);
    store.insert("groceryOverrides", {
      mealPlanId: plan.id, key: item.key, quantity, unit,
      // Remember what the app calculated, to notice later if the plan changes.
      calculatedQuantity: calculated.quantity, calculatedUnit: calculated.unit,
    });
    return null;
  }

  function clearOverride(item) {
    store.remove("groceryOverrides", item.override.id);
  }

  return { buildList, setEquivalence, removeEquivalence, mergeItems, unmerge, setOverride, clearOverride };
})();
