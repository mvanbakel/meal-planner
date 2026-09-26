// nutrition: calories and nutrients for ingredients, recipes and the meal plan.
// No HTML here.
//
// Data comes from Health Canada's Canadian Nutrient File (CNF): free, no
// sign-up. Values are per 100 g of a food. Each ingredient is linked ONCE to a
// CNF food (the user picks it), and the result is saved on the Ingredient:
//
//   ingredient.nutrition = {
//     foodCode, foodName,            // which CNF food it was linked to
//     per100g: { kcal, protein, ... },
//     gramsPerMl, gramsPerMlSource,  // for cups/spoons/ml: how heavy 1 ml is
//     gramsPerUnit: { each: { grams, source }, can: {...} },  // for counted units
//   }
//   or { ignored: true } for things like water or "salt to taste".

// The nutrients the app tracks, with their CNF id numbers.
const NUTRIENTS = [
  { key: "kcal", label: "Calories", unit: "kcal", cnfId: 208 },
  { key: "protein", label: "Protein", unit: "g", cnfId: 203 },
  { key: "carbs", label: "Carbs", unit: "g", cnfId: 205 },
  { key: "fat", label: "Fat", unit: "g", cnfId: 204 },
  { key: "fibre", label: "Fibre", unit: "g", cnfId: 291 },
  { key: "sugars", label: "Sugars", unit: "g", cnfId: 269 },
  { key: "saturatedFat", label: "Saturated fat", unit: "g", cnfId: 606 },
  { key: "sodium", label: "Sodium", unit: "mg", cnfId: 307 },
];
const MACROS = ["kcal", "protein", "carbs", "fat"];

// ---------- The data source (Canadian Nutrient File) ----------
// Everything that knows about the CNF website is in here. Another database
// (e.g. USDA FoodData Central) could be added as a second source with the
// same two functions: searchFoods() and getFood().

const CNF_API = "https://food-nutrition.canada.ca/api/canadian-nutrient-file";

const cnfSource = (() => {
  let foodList = null; // all ~5,700 food names, downloaded once per visit

  async function getJson(path) {
    let response;
    try {
      response = await fetch(`${CNF_API}/${path}${path.includes("?") ? "&" : "?"}lang=en&type=json`);
    } catch {
      throw new Error("Couldn't reach Health Canada's nutrient database. Check your internet connection.");
    }
    if (!response.ok) throw new Error(`Health Canada's nutrient database answered with an error (${response.status}).`);
    return response.json();
  }

  async function allFoods() {
    foodList ??= getJson("food/").then((foods) =>
      foods.map((f) => ({ foodCode: f.food_code, foodName: f.food_description })));
    try {
      return await foodList;
    } catch (error) {
      foodList = null; // let the next try download again
      throw error;
    }
  }

  // Full details for one food: nutrients per 100 g, and serving measures
  // converted to grams. CNF gives each measure as a multiple of 100 g
  // ("1 medium" = 1.19 means 119 g).
  async function getFood(foodCode) {
    const [amounts, servings] = await Promise.all([
      getJson(`nutrientamount/?id=${foodCode}`),
      getJson(`servingsize/?id=${foodCode}`),
    ]);
    const per100g = {};
    for (const nutrient of NUTRIENTS) {
      const found = amounts.find((a) => a.nutrient_name_id === nutrient.cnfId);
      per100g[nutrient.key] = found ? found.nutrient_value : null;
    }
    const measures = servings
      .filter((s) => s.conversion_factor_value > 0)
      .map((s) => ({ name: s.measure_name, grams: s.conversion_factor_value * 100 }));
    return { foodCode, foodName: servings[0]?.food_description ?? amounts[0]?.food_description ?? "", per100g, measures };
  }

  return { allFoods, getFood };
})();

// ---------- Searching ----------

// Words that don't help find a food.
const SEARCH_IGNORE = new Set(["of", "and", "the", "a", "fresh", "large", "small", "medium", "chopped",
  "diced", "sliced", "minced", "cut", "into", "cubes", "to", "taste", "for", "optional", "about"]);
// What recipes call something vs. what CNF calls it.
const SEARCH_SYNONYMS = { bell: "sweet", cilantro: "coriander", scallion: "onions spring", garbanzo: "chickpeas",
  egg: "egg chicken whole", eggs: "egg chicken whole" }; // a plain "egg" means a hen's egg

// "Peppers," -> "pepper"; "tomatoes" -> "tomato". Crude, but CNF and recipes
// often differ only by plural.
function searchWord(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length > 4 && w.endsWith("oes")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

// Splits text into search words. `useSynonyms` is for the user's search only,
// never for the database's food names.
function searchWords(text, useSynonyms = false) {
  return text.split(/[\s,()/-]+/)
    .flatMap((word) => ((useSynonyms && SEARCH_SYNONYMS[word.toLowerCase()]) || word).split(" "))
    .map(searchWord)
    .filter((w) => w && !SEARCH_IGNORE.has(w));
}

// Food groups in CNF that are ready-made dishes rather than ingredients.
// They're pushed down the list unless the search asks for them ("rice soup").
const PREPARED_FOOD_WORDS = ["babyfood", "soup", "alcohol", "fast", "restaurant", "snack", "salad",
  "dessert", "beverage", "sandwich", "dinner", "entree", "sauce", "cereal"];

// Ranks foods by how well their name matches `query`. Returns the top `limit`.
// `unitKey` (optional) is the unit the recipe uses: for "can", canned foods win.
// Score:
//   +10 for each query word found in the food's name (the main thing)
//   +2  for "raw" or "dry": recipes usually start from raw or dry ingredients
//   +4  for "canned" when the recipe measures in cans
//   -8  for ready-made dishes (see PREPARED_FOOD_WORDS)
//   -0.3 per word, so "Rice, white" beats "Rice, white, with chicken and vegetables"
function rankFoods(foods, query, unitKey = null, limit = 12) {
  const wanted = searchWords(query, true);
  if (wanted.length === 0) return [];
  return foods
    .map((food) => {
      const words = searchWords(food.foodName);
      const found = wanted.filter((w) => words.some((fw) => fw.startsWith(w))).length;
      const prepared = PREPARED_FOOD_WORDS.some((p) => words.includes(p) && !wanted.includes(p));
      const score = found * 10
        + (words.includes("raw") || words.includes("dry") ? 2 : 0)
        + (unitKey === "can" && words.includes("canned") ? 4 : 0)
        - (prepared ? 8 : 0)
        - words.length * 0.3;
      return { ...food, found, score };
    })
    .filter((food) => food.found > 0)
    .sort((a, b) => b.found - a.found || b.score - a.score)
    .slice(0, limit);
}

// ---------- Converting amounts to grams ----------

// From a food's measures, work out the conversions to save on the ingredient.
function conversionsFromMeasures(measures) {
  // Weight of 1 ml: prefer a plain "250ml" measure over "250ml chopped".
  const mlMeasures = measures
    .map((m) => ({ ...m, ml: Number(m.name.match(/^(\d+(?:\.\d+)?)\s*ml\b/i)?.[1]) }))
    .filter((m) => m.ml > 0)
    .sort((a, b) => /^\d+(\.\d+)?\s*ml$/i.test(b.name) - /^\d+(\.\d+)?\s*ml$/i.test(a.name));
  const mlMeasure = mlMeasures[0];

  // Weight of one item: prefer "1 medium", then "1 large", "1 small", then other "1 ...".
  const one = measures.filter((m) => /^1\s+(?!food guide|ring)/i.test(m.name) && !/ml\b/i.test(m.name));
  const eachMeasure = ["medium", "large", "small", ""]
    .map((size) => one.find((m) => m.name.toLowerCase().includes(size)))
    .find(Boolean);

  const gramsPerUnit = {};
  if (eachMeasure) gramsPerUnit.each = { grams: eachMeasure.grams, source: `CNF: ${eachMeasure.name}` };
  for (const unit of ["clove", "slice"]) {
    // Only "1 clove", "1 slice"... not "100ml slices" (that's a volume of slices).
    const measure = one.find((m) => m.name.toLowerCase().includes(unit));
    if (measure) gramsPerUnit[unit] = { grams: measure.grams, source: `CNF: ${measure.name}` };
  }

  return {
    gramsPerMl: mlMeasure ? mlMeasure.grams / mlMeasure.ml : null,
    gramsPerMlSource: mlMeasure ? `CNF: ${mlMeasure.name} = ${formatQuantity(mlMeasure.grams)} g` : null,
    gramsPerUnit,
  };
}

// Converts a recipe amount to grams. Returns { grams, how } or { grams: null, missing }.
//   how     - the steps, written out: "1.5 cup = 375 ml × 0.78 g/ml = 293 g"
//   missing - "ml" (needs a weight per ml) or a unit like "can" (needs grams per can)
function toGrams(quantity, unitKey, nutrition) {
  const unit = findUnit(unitKey);
  if (unit.kind === "mass") {
    const grams = toBaseQuantity(quantity, unitKey);
    return { grams, how: unitKey === "g" ? `${formatQuantity(grams)} g` : `${formatAmount(quantity, unitKey)} = ${formatQuantity(grams)} g` };
  }
  if (unit.kind === "volume") {
    if (!nutrition.gramsPerMl) return { grams: null, missing: "ml" };
    const ml = toBaseQuantity(quantity, unitKey);
    const grams = ml * nutrition.gramsPerMl;
    const asMl = unitKey === "ml" ? "" : ` = ${formatQuantity(ml)} ml`;
    return { grams, how: `${formatAmount(quantity, unitKey)}${asMl} × ${formatQuantity(nutrition.gramsPerMl)} g/ml = ${formatQuantity(grams)} g` };
  }
  const perUnit = nutrition.gramsPerUnit?.[unitKey];
  if (!perUnit) return { grams: null, missing: unitKey };
  const grams = quantity * perUnit.grams;
  return { grams, how: `${formatAmount(quantity, unitKey)} × ${formatQuantity(perUnit.grams)} g = ${formatQuantity(grams)} g` };
}

// Nutrients in `grams` of a food: each value per 100 g × grams ÷ 100.
function nutrientsForGrams(per100g, grams) {
  const result = {};
  for (const { key } of NUTRIENTS) result[key] = per100g[key] == null ? 0 : (per100g[key] * grams) / 100;
  return result;
}

function emptyNutrients() {
  return Object.fromEntries(NUTRIENTS.map(({ key }) => [key, 0]));
}

function addNutrients(total, extra, times = 1) {
  const result = { ...total };
  for (const { key } of NUTRIENTS) result[key] += extra[key] * times;
  return result;
}

// ---------- Saved data ----------

const nutrition = (() => {
  // Links an ingredient to a CNF food (fetching its details). Returns the saved nutrition.
  async function linkFood(ingredientId, foodCode) {
    const food = await cnfSource.getFood(foodCode);
    const previous = store.get("ingredients", ingredientId)?.nutrition;
    // Keep any grams-per-unit the user typed in themselves.
    const userUnits = Object.fromEntries(Object.entries(previous?.gramsPerUnit ?? {})
      .filter(([, value]) => value.source === "you"));
    const conversions = conversionsFromMeasures(food.measures);
    const saved = {
      foodCode: food.foodCode,
      foodName: food.foodName,
      per100g: food.per100g,
      ...conversions,
      gramsPerUnit: { ...conversions.gramsPerUnit, ...userUnits },
    };
    store.update("ingredients", ingredientId, { nutrition: saved });
    return saved;
  }

  // "1 can = 540 g", typed by the user. For "ml" this sets the weight of 1 ml.
  function setGramsPer(ingredientId, unitKey, grams) {
    const ingredient = store.get("ingredients", ingredientId);
    if (!ingredient?.nutrition || !(grams > 0)) return;
    const updated = unitKey === "ml"
      ? { ...ingredient.nutrition, gramsPerMl: grams, gramsPerMlSource: "you" }
      : { ...ingredient.nutrition,
        gramsPerUnit: { ...ingredient.nutrition.gramsPerUnit, [unitKey]: { grams, source: "you" } } };
    store.update("ingredients", ingredientId, { nutrition: updated });
  }

  // For water, "salt to taste" and other things that shouldn't count.
  function ignore(ingredientId) {
    store.update("ingredients", ingredientId, { nutrition: { ignored: true } });
  }

  function unlink(ingredientId) {
    store.update("ingredients", ingredientId, { nutrition: null });
  }

  // Nutrition for a whole recipe. Returns:
  //   { lines, total, perPortion, missingCount }
  //   lines: one per ingredient, each with a `status`:
  //     "ok"        - counted: { grams, how, nutrients }
  //     "ignored"   - user said it doesn't count
  //     "unlinked"  - not linked to a food yet
  //     "needsGrams"- linked, but the unit can't be turned into grams (`missing`)
  function forRecipe(recipe) {
    const ingredients = new Map(store.list("ingredients").map((i) => [i.id, i]));
    let total = emptyNutrients();
    const lines = recipe.ingredients.map((row) => {
      const info = ingredients.get(row.ingredientId)?.nutrition;
      if (!info) return { row, status: "unlinked" };
      if (info.ignored) return { row, status: "ignored" };
      const converted = toGrams(row.quantity, row.unit, info);
      if (converted.grams === null) return { row, status: "needsGrams", missing: converted.missing, info };
      const nutrients = nutrientsForGrams(info.per100g, converted.grams);
      total = addNutrients(total, nutrients);
      return { row, status: "ok", info, grams: converted.grams, how: converted.how, nutrients };
    });
    const perPortion = Object.fromEntries(Object.entries(total).map(([key, value]) => [key, value / recipe.portions]));
    const missingCount = lines.filter((l) => l.status === "unlinked" || l.status === "needsGrams").length;
    return { lines, total, perPortion, missingCount };
  }

  // Planned intake for each day of a week: planned portions × nutrition per portion.
  // Returns { days: [{ day, nutrients, missingRecipes }], weekTotal }.
  function forWeek(weekStart) {
    const perRecipe = new Map();
    const days = DAYS.map((_, day) => ({ day, nutrients: emptyNutrients(), missingRecipes: [] }));
    for (const item of mealPlans.listItems(weekStart)) {
      if (!perRecipe.has(item.recipeId)) perRecipe.set(item.recipeId, forRecipe(recipes.getRecipe(item.recipeId)));
      const result = perRecipe.get(item.recipeId);
      const day = days[item.day];
      day.nutrients = addNutrients(day.nutrients, result.perPortion, item.portions);
      if (result.missingCount > 0 && !day.missingRecipes.includes(item.recipeName)) day.missingRecipes.push(item.recipeName);
    }
    return { days };
  }

  return { searchFoods: async (query, unitKey) => rankFoods(await cnfSource.allFoods(), query, unitKey),
    linkFood, setGramsPer, ignore, unlink, forRecipe, forWeek };
})();
