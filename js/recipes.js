// recipes: rules for creating, reading, changing and deleting recipes.
// No HTML here. The UI (app.js) calls these functions, and these call `store`.
//
// Three collections are involved (see README "Data model"):
//   recipes           - one per meal: name, description, portions
//   ingredients       - one per distinct ingredient, shared by all recipes
//   recipeIngredients - links a recipe to an ingredient with a quantity + unit
const recipes = (() => {
  // "  Chicken   Breast " -> "chicken breast". Used to recognise the same
  // ingredient no matter how it was typed.
  function normalizeName(name) {
    return String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function tidy(text) {
    return String(text ?? "").trim().replace(/\s+/g, " ");
  }

  // Returns the ingredient with this name, creating it if it's new.
  function findOrCreateIngredient(name) {
    const normalized = normalizeName(name);
    const existing = store.list("ingredients").find((i) => i.normalizedName === normalized);
    if (existing) return existing;
    return store.insert("ingredients", { name: tidy(name), normalizedName: normalized });
  }

  // Checks a recipe before saving. Returns a list of problems ([] = all good).
  // `input` looks like:
  //   { name, description, portions, ingredients: [{ name, quantity, unit, note }] }
  function validate(input) {
    const errors = [];
    if (!tidy(input.name)) errors.push("Give the meal a name.");
    if (!Number.isInteger(input.portions) || input.portions < 1) {
      errors.push("Portions must be a whole number of 1 or more.");
    }
    if (input.ingredients.length === 0) errors.push("Add at least one ingredient.");

    input.ingredients.forEach((row, index) => {
      const label = tidy(row.name) || `Ingredient ${index + 1}`;
      if (!tidy(row.name)) errors.push(`${label}: enter a name.`);
      if (row.quantity === null) errors.push(`${label}: enter a quantity like 600, 1.5 or 1/2.`);
      if (!findUnit(row.unit)) errors.push(`${label}: choose a unit.`);
    });
    return errors;
  }

  // All recipes, alphabetical, each with an `ingredientCount`.
  function listRecipes() {
    const links = store.list("recipeIngredients");
    return store
      .list("recipes")
      .map((recipe) => ({
        ...recipe,
        ingredientCount: links.filter((link) => link.recipeId === recipe.id).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // One recipe with its ingredients filled in, or null if it doesn't exist.
  // Each ingredient: { id, ingredientId, name, quantity, unit, note }
  function getRecipe(id) {
    const recipe = store.get("recipes", id);
    if (!recipe) return null;

    const ingredients = store.list("ingredients");
    const rows = store
      .list("recipeIngredients")
      .filter((link) => link.recipeId === id)
      .sort((a, b) => a.position - b.position)
      .map((link) => ({
        ...link,
        name: ingredients.find((i) => i.id === link.ingredientId)?.name ?? "(unknown ingredient)",
      }));

    return { ...recipe, ingredients: rows };
  }

  // Creates a recipe (no id) or replaces an existing one (with id).
  // Returns { recipe } on success or { errors } if validation failed.
  function saveRecipe(id, input) {
    const errors = validate(input);
    if (errors.length > 0) return { errors };

    const fields = {
      name: tidy(input.name),
      description: String(input.description ?? "").trim(),
      portions: input.portions,
    };
    const recipe = id ? store.update("recipes", id, fields) : store.insert("recipes", fields);
    if (!recipe) return { errors: ["This recipe no longer exists."] };

    // Simplest correct way to edit a list: delete the old ingredient lines and
    // write the new ones in the order shown on screen.
    store.removeWhere("recipeIngredients", (link) => link.recipeId === recipe.id);
    input.ingredients.forEach((row, position) => {
      store.insert("recipeIngredients", {
        recipeId: recipe.id,
        ingredientId: findOrCreateIngredient(row.name).id,
        quantity: row.quantity,
        unit: row.unit,
        note: tidy(row.note),
        position,
      });
    });

    return { recipe: getRecipe(recipe.id) };
  }

  // Returns the recipe's ingredient lines scaled to `desiredPortions`.
  // Each line keeps its original fields and gains a `scaled` result from
  // scaleQuantity(): { quantity, exact, rounded }.
  function scaleRecipe(recipe, desiredPortions) {
    return recipe.ingredients.map((row) => ({
      ...row,
      scaled: scaleQuantity(row.quantity, recipe.portions, desiredPortions, row.unit),
    }));
  }

  // How many meal-plan entries use this recipe (to warn before deleting).
  function countPlanUses(id) {
    return store.list("mealPlanItems").filter((item) => item.recipeId === id).length;
  }

  // Deletes the recipe, its ingredient lines, and any meal-plan entries for it.
  // Shared ingredients are kept because other recipes (and later, flyer
  // matches) may still use them.
  function deleteRecipe(id) {
    store.removeWhere("recipeIngredients", (link) => link.recipeId === id);
    store.removeWhere("mealPlanItems", (item) => item.recipeId === id);
    store.remove("recipes", id);
  }

  // Ingredient names already used in at least one recipe, for autocomplete.
  function knownIngredientNames() {
    const usedIds = new Set(store.list("recipeIngredients").map((link) => link.ingredientId));
    return store
      .list("ingredients")
      .filter((i) => usedIds.has(i.id))
      .map((i) => i.name)
      .sort((a, b) => a.localeCompare(b));
  }

  return { listRecipes, getRecipe, saveRecipe, scaleRecipe, countPlanUses, deleteRecipe,
    knownIngredientNames };
})();

// The example from the project brief, offered on an empty recipe list so
// there's something to look at straight away.
const EXAMPLE_RECIPE = {
  name: "Chicken Burrito Bowl",
  description: "Rice bowls with seasoned chicken, beans, peppers and salsa.",
  portions: 4,
  ingredients: [
    { name: "Chicken breast", quantity: 600, unit: "g", note: "" },
    { name: "Rice", quantity: 300, unit: "g", note: "" },
    { name: "Black beans", quantity: 1, unit: "can", note: "" },
    { name: "Bell peppers", quantity: 2, unit: "each", note: "" },
    { name: "Salsa", quantity: 200, unit: "ml", note: "" },
  ],
};
