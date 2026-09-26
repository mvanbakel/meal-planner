# Meal Planner

Plan meals from saved recipes, scale portions, build a grocery list, and (later)
match it against weekly flyer sales. Plain HTML/CSS/JavaScript: no frameworks,
no build step. One library, stored in the project (not loaded from the internet):
Mozilla's pdf.js 3.11.174 in `vendor/pdfjs/` (Apache 2.0 licence), used only to read recipe PDFs.

## Running it

Open `index.html` in Chrome (double-click it, or `open index.html` in Terminal).
Data is saved in that browser only (`localStorage`). Clearing the browser's site
data erases it, and a different browser/device/address starts empty.

## Structure

```
index.html        page shell; loads the scripts in order
styles.css        all styling (light + dark mode, phone layout)
js/store.js       the ONLY file that reads/writes storage
js/units.js       units, what they measure (weight/volume/count), conversions to g / ml
js/quantity.js    parse "1 1/2" -> 1.5, format 1500 -> "1,500", scaleQuantity(), roundUpIfWhole()
js/recipes.js     recipe rules: validate, save, load, delete, scale (no HTML)
js/pdfText.js     reads a PDF's text into lines (handles two-column layouts)
js/recipeParser.js turns recipe text into a draft recipe: parseIngredientLine(), parseRecipeText()
js/mealPlans.js   weekly plan rules: weeks (Mondays), add/change/remove meals, totals
js/grocery.js     combineGroceryItems() + the week's list with the user's merges/edits
js/flyers.js      flyer import: sources (CSV, JSON) -> normalizeProduct() -> saved flyer (hidden, see below)
js/categories.js  store sections and guessCategory() from an ingredient's name
js/shopping.js    in-store checklist: sections, ticked-off items
js/nutrition.js   calories & nutrients: Canadian Nutrient File lookup, toGrams(), per recipe / per day
js/goals.js       daily nutrition goals and reviewWeek()
vendor/pdfjs/     pdf.js library + licence
sample-data/      sample-flyer.csv, sample-recipe.pdf, sample-recipe-two-column.pdf
js/app.js         UI: draws pages, handles clicks, simple #/ page routing
```

Layers only talk downward: `app.js` → `recipes.js` / `mealPlans.js` / `grocery.js` / `flyers.js` → `store.js`.
Calculations (`quantity.js`, and later `grocery.js`, `matching.js`, `pricing.js`)
are plain functions with no HTML, so they're easy to test and reuse.

To switch to a real database later, rewrite `store.js` only.

## Data model

Each concept is its own collection, linked by ids (like database tables).

| Concept | Fields | Phase |
|---|---|---|
| User | single local user for now; `userId` gets added when accounts exist | later |
| Recipe | id, name, description, portions | 1 ✅ |
| Ingredient | id, name, normalizedName (shared by all recipes), category (user's choice; otherwise guessed), nutrition (see below) | 1 ✅ |
| Ingredient.nutrition | foodCode + foodName (the CNF food chosen), per100g { kcal, protein, carbs, fat, fibre, sugars, saturatedFat, sodium }, gramsPerMl, gramsPerUnit { each/can/…: { grams, source } }; or { ignored: true } | 10 ✅ |
| RecipeIngredient | id, recipeId, ingredientId, quantity, unit, note, position | 1 ✅ |
| MealPlan | id, weekStart (Monday's date, "YYYY-MM-DD") | 3 ✅ |
| MealPlanItem | id, mealPlanId, recipeId, day (0 = Monday … 6 = Sunday), portions EATEN that day, position | 3 ✅ |
| GroceryItem | *calculated, not saved*: key, name, quantity, unit, sources (which recipes need it) | 4 ✅ |
| IngredientEquivalence | id, ingredientId, fromUnit, toQuantity, toUnit (1 can = 400 g) | 4 ✅ |
| GroceryMerge | id, mealPlanId, keys (items shown as one line), name | 4 ✅ |
| GroceryOverride | id, mealPlanId, key, quantity, unit, calculatedQuantity, calculatedUnit | 4 ✅ |
| Flyer | id, storeName, weekStart (planning week it's used for), source ("csv", "json", later "api"), fileName, startDate, endDate | 5 ✅ |
| FlyerProduct | id, flyerId, productName, category, brand, regularPrice, salePrice, saleDescription, unit (as written), unitQuantity + unitKey (parsed: "per kg" → 1 kg, "540 ml can" → 540 ml), startDate, endDate | 5 ✅ |
| NutritionGoal | id, nutrient (kcal, protein, …), min ("at least") and/or max ("at most") per day | 11 ✅ |
| ShoppingCheck | id, mealPlanId, key (a grocery item ticked off while shopping) | 8 ✅ |
| IngredientMatch | id, ingredientId, flyerProductId, reason, score, status (suggested/accepted/rejected) | 6 |

Every record also gets `createdAt` / `updatedAt`.

Why `Ingredient` is separate from `RecipeIngredient`: "Chicken breast" in two
recipes is the *same* ingredient, so the grocery list can add them together and
a flyer match only has to be accepted once.

Room for later (not built): a `store` field on Flyer (multiple stores / store-specific
lists), keeping old FlyerProducts (price history), pantry and expiry on Ingredient,
nutrition per Ingredient, and API sources that produce the same Flyer/FlyerProduct shape.

## Development plan

1. ✅ **Recipe database**: create, view, edit, delete recipes with ingredients.
2. ✅ **Portion scaling**: `scaleQuantity()` in `quantity.js`, `recipes.scaleRecipe()`;
   exact amounts, whole-only units (cans, each, package, bunch) rounded up and labelled;
   optional "Show calculations".
3. ✅ **Weekly meal plan**: `#/plan`; assign recipes and portions to days, change or
   remove them, move between weeks; `mealPlans.summarize()` gives totals per recipe.
   The plan records what you EAT each day (the user batch-cooks): the week's total per
   recipe is the batch to cook ("To cook this week"). "Add a meal to several days" adds one
   recipe to many days at once.
4. ✅ **Grocery list**: `#/grocery`; `combineGroceryItems()` adds the same ingredient
   in compatible units (g + kg, ml + tbsp), never cans + g unless the user sets a
   conversion; whole-only units rounded up after combining; manual edit (flags when the
   plan changes later) and merge; every total shows its sum.
5. ⏸ **Flyer import** (built, then hidden: Metro's terms of use forbid reproducing or
   downloading site content without written permission, and there's no public API, so there's
   no authorized data source yet. To re-enable: uncomment the route in `app.js` and the menu
   link in `index.html`): `#/flyers`; CSV (comma/tab/;/| separated) or JSON, upload or paste,
   preview with skipped rows explained, assigned to a planning week and store. New sources
   (e.g. an authorized API) plug into `FLYER_SOURCES`; nothing is scraped.
6. ⏸ *On hold until there's sale data.* **Sale matching**: `matchIngredient()` with a visible reason; accept/reject.
7. ⏸ *On hold until there's sale data.* **This Week recommendations**: sale coverage per meal plus `estimateSavings()`
   with the calculation shown.
8. ✅ **Shopping list**: `#/shop`; grouped into Produce / Meat / Dairy / Pantry / Frozen /
   Other (guessed from the name, changeable and remembered), which meals need each item,
   check-off saved per week. Prices/sale flags come back if sale data does.
9. ✅ **Recipe PDF import**: `#/recipes/import` ("Upload recipe PDF" on the Recipes page).
   No AI: finds the title (largest text), portions ("Serves 4"), the Ingredients section and
   the method, and splits lines like "1 ½ cups flour, sifted". Opens the normal recipe form
   as a draft; unclear lines are flagged ⚠ with the original PDF line shown. Scanned PDFs
   (no text) are detected and explained. pdf.js runs on the main page (no web worker) so it
   also works when index.html is opened from disk; `isEvalSupported: false` for CVE-2024-4367.
10. ✅ **Calories & macros**: Nutrition section on each recipe page. Each ingredient is linked
    once to a food in Health Canada's Canadian Nutrient File (free, no API key; the app suggests
    matches, the user picks). Amounts become grams via weight units, the food's g/ml (cups,
    spoons) or its "1 medium" weight; cans/packages are entered by the user. Per-portion and
    whole-recipe totals with every calculation shown; per-day totals on the meal plan
    (planned portions × per-portion nutrition). Needs an internet connection only to look foods up.
11. ✅ **Dietary goals**: `#/goals`; optional "at least" / "at most" per nutrient per day. Reviews
    the week: each planned day and the average vs every goal, with how far under/over. Days with
    incomplete nutrition are flagged. The meal plan shows "✓ goals met" / "N goals off target" per day.

New data for 9–11: `Ingredient.nutrition` (or a separate `IngredientNutrition`),
`NutritionGoal` (userId, nutrient, dailyTarget, min/max), and optional
`FoodLog` if tracking what was actually eaten rather than what was planned.

### Decisions for phases 9–11
- PDF import: **no AI**. Extract the text, make a best guess at name/portions/ingredients,
  and the user fixes it in the normal recipe form before saving.
- Nutrition data: **looked up** from a public database (Canadian Nutrient File or USDA
  FoodData Central), cached on the Ingredient.
- Tracking: **planned meals only** (no FoodLog).
