// UI layer: draws pages and handles clicks. Talks to `recipes`, never to `store`.
//
// Pages are chosen by the part of the address after "#":
//   #/                         recipe list
//   #/recipes/new              new recipe form
//   #/recipes/import           upload a recipe PDF
//   #/recipes/<id>             view a recipe (add ?portions=6 to open it scaled)
//   #/recipes/<id>/edit        edit a recipe
//   #/plan                     this week's meal plan
//   #/plan/2026-09-28          the meal plan for the week starting that Monday
//   #/grocery, #/grocery/2026-09-28   the grocery list for this week / that week
//   #/shop, #/shop/2026-09-28  in-store checklist for this week / that week
//   #/goals, #/goals/2026-09-28  daily nutrition goals + that week's review
//   #/data                     download / load a backup
//   #/flyers, #/flyers/<id>    flyer import (hidden for now)
// Using the address means the browser's Back button and bookmarks just work.
const view = document.getElementById("view");

// Small helper for building HTML elements:
//   el("p", { className: "muted" }, "Hello")  ->  <p class="muted">Hello</p>
// Text is always inserted as text (never as HTML), so typed input can't break the page.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key in node && key !== "list") node[key] = value; // input.list is read-only
    else node.setAttribute(key, value);
  }
  node.append(...present(children));
  return node;
}

// Drops empty values (false, null, undefined, "") so `condition && el(...)` can
// be used to show something only sometimes, without printing "false".
function present(children) {
  return children.flat().filter((child) => child != null && child !== false && child !== "");
}

function go(path) {
  location.hash = path;
}

// plural(3, "product") -> "3 products", plural(1, "product") -> "1 product"
function plural(count, word) {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

function portionsLabel(count) {
  return plural(count, "portion");
}

// ---------- Recipe list ----------

function renderRecipeList() {
  const all = recipes.listRecipes();

  const header = el(
    "div",
    { className: "page-header" },
    el("h1", {}, "Recipes"),
    el("div", { className: "actions" },
      el("a", { className: "button", href: "#/recipes/import" }, "Upload recipe PDF"),
      el("a", { className: "button primary", href: "#/recipes/new" }, "+ New recipe"))
  );

  if (all.length === 0) {
    const loadExample = el("button", { type: "button", className: "button", onClick: () => {
      const { recipe } = recipes.saveRecipe(null, EXAMPLE_RECIPE);
      go(`/recipes/${recipe.id}`);
    } }, "Add the example Chicken Burrito Bowl");

    return [header, el("div", { className: "empty" },
      el("p", {}, "No recipes yet. Create your first one, or start with an example."),
      loadExample
    )];
  }

  const cards = all.map((recipe) =>
    el("li", {},
      el("a", { className: "card recipe-card", href: `#/recipes/${recipe.id}` },
        el("strong", {}, recipe.name),
        recipe.description && el("span", { className: "muted clamp" }, recipe.description),
        el("span", { className: "meta" },
          `${portionsLabel(recipe.portions)} · ${recipe.ingredientCount} ingredients`)
      )
    )
  );
  return [header, el("ul", { className: "card-list" }, cards)];
}

// ---------- Import a recipe from PDF ----------

function renderRecipeImport() {
  const status = el("p", { className: "meta", "aria-live": "polite" });
  const fileInput = el("input", { type: "file", id: "recipe-pdf", accept: "application/pdf,.pdf",
    onChange: async () => {
      const file = fileInput.files[0];
      if (!file) return;
      status.className = "meta";
      status.textContent = "Reading the PDF…";
      try {
        const { lines } = await extractPdfLines(file);
        const rawText = lines.map((line) => line.text).join("\n");
        // Hardly any text means the PDF is a picture (a scan or photo).
        if (rawText.replace(/\s/g, "").length < 20) {
          throw new Error("This PDF has no text the app can read. It's probably a scan or photo. "
            + "Try a PDF where you can highlight the words, or enter the recipe by hand.");
        }
        const draft = { ...parseRecipeText(lines), fileName: file.name, rawText };
        view.replaceChildren(...present(renderRecipeForm(null, draft)));
        window.scrollTo(0, 0);
      } catch (error) {
        status.className = "error-text";
        status.textContent = error.name === "PasswordException"
          ? "This PDF is password-protected, so it can't be read."
          : error.message.startsWith("This PDF") ? error.message
            : "Couldn't read that file. Is it a PDF?";
        fileInput.value = "";
      }
    } });

  return [
    el("a", { className: "back", href: "#/" }, "← All recipes"),
    el("h1", {}, "Upload a recipe PDF"),
    el("section", { className: "card import-box" },
      el("ol", { className: "steps" },
        el("li", {}, "Choose a ", el("strong", {}, "PDF file"), " of a recipe below."),
        el("li", {}, "The app reads it and fills in a new recipe."),
        el("li", {}, "Check and fix anything it got wrong, then save.")),
      el("label", { htmlFor: "recipe-pdf" }, "Recipe PDF"),
      fileInput,
      status,
      el("details", { className: "help" },
        el("summary", {}, "Which PDFs work?"),
        el("p", {}, "PDFs with real text work: if you can highlight the words in the PDF, the app can read them. "
          + "A handy way to get one: on a recipe website, use Print → Save as PDF."),
        el("p", {}, "Scanned pages and photos of recipes can't be read."),
        el("p", {}, "It works best when the recipe has an “Ingredients” heading and lines like “600 g chicken breast”."))),
  ];
}

// ---------- View one recipe ----------

function renderRecipe(id, startPortions) {
  const recipe = recipes.getRecipe(id);
  if (!recipe) return renderNotFound();

  const deleteButton = el("button", { type: "button", className: "button danger", onClick: () => {
    const uses = recipes.countPlanUses(recipe.id);
    const planWarning = uses > 0
      ? ` It will also be removed from ${uses} meal plan ${uses === 1 ? "entry" : "entries"}.` : "";
    if (confirm(`Delete "${recipe.name}"?${planWarning} This can't be undone.`)) {
      recipes.deleteRecipe(recipe.id);
      go("/");
    }
  } }, "Delete");

  return [
    el("a", { className: "back", href: "#/" }, "← All recipes"),
    el("div", { className: "page-header" },
      el("h1", {}, recipe.name),
      el("div", { className: "actions" },
        el("a", { className: "button", href: `#/recipes/${recipe.id}/edit` }, "Edit"),
        deleteButton
      )
    ),
    recipe.description && el("p", { className: "description" }, recipe.description),
    renderScaler(recipe, startPortions),
    renderRecipeNutrition(recipe),
  ];
}

// Portion picker plus the ingredient table, redrawn whenever the portions change.
function renderScaler(recipe, startPortions) {
  let desired = startPortions ?? recipe.portions;
  let showMaths = false;

  const portionsInput = el("input", { id: "desired-portions", type: "number", min: 1, step: 1,
    inputMode: "numeric", value: desired, onInput: () => {
      const value = Number(portionsInput.value);
      if (Number.isInteger(value) && value >= 1) setDesired(value);
    } });
  const minus = el("button", { type: "button", className: "button step", "aria-label": "Fewer portions",
    onClick: () => setDesired(Math.max(1, desired - 1)) }, "−");
  const plus = el("button", { type: "button", className: "button step", "aria-label": "More portions",
    onClick: () => setDesired(desired + 1) }, "+");
  const reset = el("button", { type: "button", className: "link",
    onClick: () => setDesired(recipe.portions) }, "Reset");
  const mathsToggle = el("input", { type: "checkbox", id: "show-maths", onChange: () => {
    showMaths = mathsToggle.checked;
    draw();
  } });

  const summary = el("p", { className: "meta", "aria-live": "polite" });
  const table = el("table", { className: "ingredients" });

  function setDesired(value) {
    desired = value;
    portionsInput.value = value;
    draw();
  }

  function draw() {
    const scaling = desired !== recipe.portions;
    reset.hidden = !scaling;
    // e.g. "Scaled ×2.5 (10 ÷ 4 portions)"
    summary.textContent = scaling
      ? `Original recipe makes ${portionsLabel(recipe.portions)}. Scaled ×${formatQuantity(desired / recipe.portions)} (${desired} ÷ ${recipe.portions}).`
      : `Original recipe makes ${portionsLabel(recipe.portions)}.`;

    const rows = recipes.scaleRecipe(recipe, desired).map((row) => {
      const { scaled } = row;
      // "600 × 10 ÷ 4 = 1,500 g" (the formula from quantity.js, with real numbers)
      const maths = `${formatQuantity(row.quantity)} × ${desired} ÷ ${recipe.portions} = ${formatAmount(scaled.exact, row.unit)}`
        + (scaled.rounded ? ` → rounded up to ${formatQuantity(scaled.quantity)}` : "");

      return el("tr", {},
        el("td", {},
          row.name,
          row.note && el("span", { className: "muted" }, ` (${row.note})`),
          showMaths && el("div", { className: "maths" }, maths)
        ),
        scaling && el("td", { className: "num muted" }, formatAmount(row.quantity, row.unit)),
        el("td", { className: "num" },
          el("strong", {}, formatAmount(scaled.quantity, row.unit)),
          scaled.rounded && el("div", { className: "rounded-note" },
            `rounded up from ${formatQuantity(scaled.exact)}`)
        )
      );
    });

    table.replaceChildren(
      el("thead", {}, el("tr", {},
        el("th", {}, "Ingredient"),
        scaling && el("th", { className: "num" }, `Original (${recipe.portions})`),
        el("th", { className: "num" }, scaling ? `For ${desired}` : "Amount")
      )),
      el("tbody", {}, rows)
    );
  }

  draw();
  return el("section", { className: "scaler" },
    el("div", { className: "scaler-controls" },
      el("label", { htmlFor: "desired-portions" }, "Portions to make"),
      el("div", { className: "stepper" }, minus, portionsInput, plus),
      reset,
      el("label", { className: "toggle" }, mathsToggle, "Show calculations")
    ),
    summary,
    table
  );
}

// ---------- Nutrition ----------

// 1234.5 -> "1,235"; nutrients are shown as whole numbers (1 decimal under 10).
function formatNutrient(value) {
  return value.toLocaleString("en-CA", { maximumFractionDigits: value < 10 ? 1 : 0 });
}

function nutrientText(nutrients, key) {
  const { unit } = NUTRIENTS.find((n) => n.key === key);
  return `${formatNutrient(nutrients[key])} ${unit}`;
}

// Four big numbers: calories, protein, carbs, fat.
function renderMacroTiles(nutrients) {
  return el("div", { className: "macro-tiles" }, MACROS.map((key) =>
    el("div", { className: "macro-tile" },
      el("span", { className: "macro-value" }, nutrientText(nutrients, key)),
      el("span", { className: "meta" }, NUTRIENTS.find((n) => n.key === key).label))));
}

// "Fibre 8 g · Sugars 6 g · …" for the nutrients that aren't macros.
function otherNutrientsText(nutrients) {
  return NUTRIENTS.filter((n) => !MACROS.includes(n.key))
    .map((n) => `${n.label} ${nutrientText(nutrients, n.key)}`).join(" · ");
}

function renderRecipeNutrition(recipe) {
  const section = el("section", { className: "nutrition" });
  let searchFor = null;   // ingredient id whose food search is open
  let searchState = null; // { query, loading, results, error }

  async function runSearch(query, unitKey) {
    searchState = { query, unitKey, loading: true };
    draw();
    try {
      searchState = { query, unitKey, results: await nutrition.searchFoods(query, unitKey) };
    } catch (error) {
      searchState = { query, error: error.message };
    }
    draw();
  }

  async function choose(row, food) {
    searchState = { ...searchState, loading: true, results: null };
    draw();
    try {
      await nutrition.linkFood(row.ingredientId, food.foodCode);
      searchFor = searchState = null;
    } catch (error) {
      searchState = { query: searchState.query, error: error.message };
    }
    draw();
  }

  function openSearch(row) {
    searchFor = row.ingredientId;
    runSearch(row.name, row.unit);
  }

  function renderSearch(row) {
    const input = el("input", { value: searchState.query, "aria-label": "Search foods" });
    return el("div", { className: "food-search" },
      el("form", { className: "edit-amount", onSubmit: (event) => { event.preventDefault(); runSearch(input.value, row.unit); } },
        input, el("button", { type: "submit", className: "button" }, "Search")),
      searchState.loading && el("p", { className: "meta" }, "Searching Health Canada's nutrient database…"),
      searchState.error && el("p", { className: "error-text" }, searchState.error),
      searchState.results && (searchState.results.length === 0
        ? el("p", { className: "meta" }, "No matches. Try fewer or different words, e.g. “pepper sweet red”.")
        : el("ul", { className: "food-results" }, searchState.results.map((food) =>
          el("li", {}, el("button", { type: "button", className: "link", onClick: () => choose(row, food) },
            food.foodName))))),
      el("div", { className: "actions" },
        el("button", { type: "button", className: "button", onClick: () => {
          nutrition.ignore(row.ingredientId); searchFor = searchState = null; draw();
        } }, "Don't count it (water, salt…)"),
        el("button", { type: "button", className: "button", onClick: () => { searchFor = searchState = null; draw(); } },
          "Cancel")));
  }

  // "How much does 1 can weigh? [   ] g"
  function renderGramsForm(line) {
    const unit = line.missing === "ml" ? line.row.unit : line.missing;
    const input = el("input", { inputMode: "decimal", placeholder: "g", "aria-label": `Grams in 1 ${unit}`, className: "portions" });
    return el("form", { className: "edit-amount", onSubmit: (event) => {
      event.preventDefault();
      const grams = parseQuantity(input.value);
      if (!grams) return input.focus();
      // For cups/spoons, save the weight of 1 ml (so every volume unit works).
      if (line.missing === "ml") nutrition.setGramsPer(line.row.ingredientId, "ml", grams / toBaseQuantity(1, unit));
      else nutrition.setGramsPer(line.row.ingredientId, unit, grams);
      draw();
    } },
      el("span", {}, `How much does 1 ${unit} weigh?`), input, el("span", {}, "g"),
      el("button", { type: "submit", className: "button" }, "Save"));
  }

  function renderLine(line) {
    const { row } = line;
    const amount = formatAmount(row.quantity, row.unit);
    const change = el("button", { type: "button", className: "link", onClick: () => openSearch(row) }, "Change");

    let detail;
    if (searchFor === row.ingredientId) detail = renderSearch(row);
    else if (line.status === "unlinked") {
      detail = el("button", { type: "button", className: "button", onClick: () => openSearch(row) }, "Find nutrition info");
    } else if (line.status === "ignored") {
      detail = el("span", { className: "meta" }, "Not counted · ",
        el("button", { type: "button", className: "link", onClick: () => { nutrition.unlink(row.ingredientId); draw(); } }, "Undo"));
    } else if (line.status === "needsGrams") {
      detail = el("div", {}, el("span", { className: "meta" }, `${line.info.foodName} · `, change),
        renderGramsForm(line),
        el("p", { className: "meta" }, "Check the package label. This is saved for every recipe using this ingredient."));
    } else {
      // Written-out calculation: grams, then calories from the per-100 g value.
      const kcalPer100 = line.info.per100g.kcal ?? 0;
      detail = el("details", {},
        el("summary", {}, el("span", { className: "meta" }, line.info.foodName)),
        el("p", { className: "maths" }, line.how),
        el("p", { className: "maths" },
          `${formatQuantity(line.grams)} g × ${formatQuantity(kcalPer100)} kcal per 100 g = ${formatNutrient(line.nutrients.kcal)} kcal`),
        el("p", { className: "maths" }, MACROS.slice(1).map((key) => `${NUTRIENTS.find((n) => n.key === key).label} ${nutrientText(line.nutrients, key)}`).join(" · ")),
        el("div", { className: "actions" }, change,
          el("button", { type: "button", className: "link", onClick: () => { nutrition.unlink(row.ingredientId); draw(); } }, "Unlink")));
    }

    return el("li", { className: `nutrition-line ${line.status}` },
      el("div", { className: "shop-line" },
        el("span", { className: "item-name" }, row.name, el("span", { className: "muted" }, ` · ${amount}`)),
        line.status === "ok" && el("span", { className: "amount" }, `${formatNutrient(line.nutrients.kcal)} kcal`)),
      detail);
  }

  function draw() {
    const result = nutrition.forRecipe(recipe);
    const counted = result.lines.filter((l) => l.status === "ok").length;
    const countable = result.lines.filter((l) => l.status !== "ignored").length; // skip water, salt…
    const anyLinked = result.lines.some((l) => l.status !== "unlinked");

    section.replaceChildren(...present([
      el("h2", {}, "Nutrition"),
      !anyLinked && el("p", { className: "muted" },
        "Link each ingredient to a food in Health Canada's Canadian Nutrient File to see calories and macros. "
        + "You only do this once per ingredient; every recipe that uses it benefits."),
      anyLinked && el("div", { className: "card nutrition-summary" },
        el("p", { className: "label" }, "Per portion"),
        renderMacroTiles(result.perPortion),
        el("p", { className: "meta" }, otherNutrientsText(result.perPortion)),
        el("p", { className: "meta" },
          `Whole recipe (${portionsLabel(recipe.portions)}): ${nutrientText(result.total, "kcal")}`),
        result.missingCount > 0 && el("p", { className: "warn-text" },
          `⚠ Only ${counted} of ${countable} ingredients are counted so far, so these numbers are too low. Finish the ones below.`)),
      el("ul", { className: "nutrition-lines" }, result.lines.map(renderLine)),
      el("p", { className: "meta" }, "Source: Health Canada, Canadian Nutrient File. Values are estimates."),
    ]));
  }

  draw();
  return section;
}

// ---------- Create / edit form ----------

// `draft` (optional): a recipe read from a PDF, shown for checking before it's saved.
function renderRecipeForm(id, draft = null) {
  const existing = id ? recipes.getRecipe(id) : null;
  if (id && !existing) return renderNotFound();
  const start = existing ?? draft; // what to fill the boxes with

  const errorBox = el("div", { className: "errors", role: "alert", hidden: true });
  const nameInput = el("input", { id: "f-name", required: true, value: start?.name ?? "",
    placeholder: "e.g. Chicken Burrito Bowl", autocomplete: "off" });
  const descriptionInput = el("textarea", { id: "f-description", rows: draft?.description ? 8 : 3,
    placeholder: "Optional notes, method, where the recipe came from…" });
  descriptionInput.value = start?.description ?? "";
  const portionsInput = el("input", { id: "f-portions", type: "number", min: 1, step: 1,
    inputMode: "numeric", required: true, value: draft ? draft.portions ?? "" : existing?.portions ?? 4 });

  // Autocomplete from ingredients already used in other recipes, so the same
  // ingredient gets the same name (this matters for the grocery list later).
  const datalist = el("datalist", { id: "ingredient-names" },
    recipes.knownIngredientNames().map((name) => el("option", { value: name })));

  const rowList = el("ol", { className: "ingredient-rows" });
  const addRow = (row) => {
    rowList.append(renderIngredientRow(row));
    rowList.lastElementChild.querySelector("input").focus();
  };

  const startRows = start?.ingredients?.length ? start.ingredients : [{}];
  startRows.forEach((row) => rowList.append(renderIngredientRow(row)));

  const form = el("form", { className: "recipe-form", noValidate: true, onSubmit: (event) => {
    event.preventDefault();
    const input = {
      name: nameInput.value,
      description: descriptionInput.value,
      portions: Number(portionsInput.value),
      ingredients: [...rowList.children].map(readIngredientRow).filter((row) => !row.isBlank),
    };
    const result = recipes.saveRecipe(id, input);
    if (result.errors) {
      errorBox.replaceChildren(
        el("p", {}, "Please fix these before saving:"),
        el("ul", {}, result.errors.map((message) => el("li", {}, message)))
      );
      errorBox.hidden = false;
      errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    go(`/recipes/${result.recipe.id}`);
  } },
    errorBox,
    el("label", { htmlFor: "f-name" }, "Meal name"),
    nameInput,
    el("label", { htmlFor: "f-description" }, "Description"),
    descriptionInput,
    el("label", { htmlFor: "f-portions" }, "Portions the original recipe makes"),
    portionsInput,
    el("fieldset", {},
      el("legend", {}, "Ingredients"),
      el("div", { className: "row-headings", "aria-hidden": "true" },
        el("span", {}, "Ingredient"), el("span", {}, "Qty"), el("span", {}, "Unit")),
      rowList,
      el("button", { type: "button", className: "button", onClick: () => addRow({}) }, "+ Add ingredient")
    ),
    datalist,
    el("div", { className: "actions" },
      el("button", { type: "submit", className: "button primary" }, existing ? "Save changes" : "Save recipe"),
      el("a", { className: "button", href: existing ? `#/recipes/${existing.id}` : "#/" }, "Cancel")
    )
  );

  const title = existing ? `Edit ${existing.name}` : draft ? "Check the imported recipe" : "New recipe";
  return [el("h1", {}, title), draft && renderImportNotice(draft), form];
}

// The box above a PDF-imported recipe: what to check, and the raw text.
function renderImportNotice(draft) {
  const flagged = draft.ingredients.filter((row) => row.needsReview).length;
  return el("section", { className: "card notice" },
    el("p", {}, el("strong", {}, `Read from ${draft.fileName}. `),
      "This is the app's best guess, so check every line before saving. Nothing is saved until you click Save recipe."),
    el("ul", { className: "notice-points" },
      el("li", {}, `Found ${plural(draft.ingredients.length, "ingredient")}.`,
        flagged > 0 ? ` ${flagged} marked ⚠ ${flagged === 1 ? "needs" : "need"} an amount or unit.` : ""),
      !draft.portions && el("li", {}, "Couldn't find how many portions it makes. Please fill that in."),
      !draft.name && el("li", {}, "Couldn't find the recipe's name."),
      draft.description && el("li", {}, "The method was put in the description.")),
    el("details", {},
      el("summary", {}, "Show all the text found in the PDF"),
      el("pre", { className: "pdf-text" }, draft.rawText)));
}

// One editable ingredient line: name, quantity, unit, optional note, remove button.
// A dropdown of every unit, grouped under Weight / Volume / Count.
function unitSelect(selectedKey, props = {}) {
  return el("select", { "aria-label": "Unit", ...props },
    el("option", { value: "" }, "Unit…"),
    Object.entries(UNIT_KIND_LABELS).map(([kind, heading]) =>
      el("optgroup", { label: heading },
        UNITS.filter((unit) => unit.kind === kind).map((unit) =>
          el("option", { value: unit.key, selected: unit.key === selectedKey }, unit.key)))));
}

// A number as typed into a box: no thousands commas ("1500", not "1,500").
function quantityForInput(value) {
  return formatQuantity(value).replace(/,/g, "");
}

function renderIngredientRow(row) {
  const shownQuantity = row.quantity ? quantityForInput(row.quantity) : "";

  const li = el("li", { className: row.needsReview ? "ingredient-row needs-review" : "ingredient-row" },
    el("input", { className: "name", value: row.name ?? "", placeholder: "e.g. Rice",
      list: "ingredient-names", autocomplete: "off", "aria-label": "Ingredient name" }),
    el("input", { className: "qty", value: shownQuantity, placeholder: "300",
      inputMode: "decimal", autocomplete: "off", "aria-label": "Quantity",
      // Remember the exact saved number. The box shows it rounded (1/3 shows
      // as 0.33), so if the box is left unchanged we keep the exact value.
      dataset: { original: row.quantity ?? "", shown: shownQuantity } }),
    unitSelect(row.unit, { className: "unit" }),
    el("input", { className: "note", value: row.note ?? "", placeholder: "Note (optional), e.g. diced",
      autocomplete: "off", "aria-label": "Note" }),
    el("button", { type: "button", className: "remove", "aria-label": "Remove ingredient",
      onClick: () => li.remove() }, "×"),
    // For PDF imports: the original line, to compare against.
    row.source && el("span", { className: "row-source" }, `${row.needsReview ? "⚠ " : ""}From PDF: ${row.source}`)
  );
  return li;
}

function readIngredientRow(li) {
  const name = li.querySelector(".name").value;
  const qtyInput = li.querySelector(".qty");
  const unit = li.querySelector(".unit").value;
  const note = li.querySelector(".note").value;

  const unchanged = qtyInput.dataset.original && qtyInput.value.trim() === qtyInput.dataset.shown;
  const quantity = unchanged ? Number(qtyInput.dataset.original) : parseQuantity(qtyInput.value);

  // A completely empty line is ignored rather than reported as an error.
  const isBlank = !name.trim() && !qtyInput.value.trim() && !unit && !note.trim();
  return { name, quantity, unit, note, isBlank };
}

// ---------- Weekly meal plan ----------

function shortDate(iso) {
  return mealPlans.fromIsoDate(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

// "← Prev | Sep 21 – Sep 27 | Next →". `section` is "plan", "grocery", "shop" or "goals".
function renderWeekNav(section, weekStart) {
  return el("div", { className: "week-nav" },
    el("a", { className: "button", href: `#/${section}/${mealPlans.addDays(weekStart, -7)}` }, "← Prev"),
    el("div", { className: "week-label" },
      el("strong", {}, `${shortDate(weekStart)} – ${shortDate(mealPlans.addDays(weekStart, 6))}`),
      weekStart === mealPlans.weekStartFor()
        ? el("span", { className: "meta" }, "This week")
        : el("a", { href: `#/${section}` }, "Go to this week")
    ),
    el("a", { className: "button", href: `#/${section}/${mealPlans.addDays(weekStart, 7)}` }, "Next →")
  );
}

function renderMealPlan(weekStart) {
  const allRecipes = recipes.listRecipes();
  const today = mealPlans.addDays(mealPlans.weekStartFor(), (new Date().getDay() + 6) % 7);
  const weekNav = renderWeekNav("plan", weekStart);

  if (allRecipes.length === 0) {
    return [el("h1", {}, "Meal plan"), weekNav, el("div", { className: "empty" },
      el("p", {}, "You need at least one recipe before you can plan meals."),
      el("a", { className: "button primary", href: "#/recipes/new" }, "+ New recipe"))];
  }

  const summaryBox = el("section", { className: "card plan-summary", "aria-live": "polite" });
  const dayList = el("div", { className: "days" });
  const dayTotals = []; // the "N portions" label in each day's header, by day number
  const dayNutrition = []; // the calories/macros line under each day's header

  // A dropdown of all recipes, with `selectedId` chosen.
  function recipeSelect(selectedId, props) {
    return el("select", props,
      !selectedId && el("option", { value: "" }, "Pick a meal…"),
      allRecipes.map((r) => el("option", { value: r.id, selected: r.id === selectedId }, r.name)));
  }

  function portionsInput(value, props) {
    return el("input", { type: "number", min: 1, step: 1, inputMode: "numeric",
      className: "portions", value, ...props });
  }

  // Updates the week summary and each day's portion count from saved data.
  // Called after every change; cheaper than rebuilding the whole page, and it
  // doesn't steal focus from the box you're typing in.
  function refreshTotals() {
    const summary = mealPlans.summarize(weekStart);
    const items = mealPlans.listItems(weekStart);

    dayTotals.forEach((label, day) => {
      const total = items.filter((item) => item.day === day).reduce((sum, item) => sum + item.portions, 0);
      label.textContent = total ? portionsLabel(total) : "";
    });

    // Planned intake per day: each planned portion × that recipe's nutrition per portion.
    const week = nutrition.forWeek(weekStart);
    const review = goals.reviewWeek(weekStart);
    dayNutrition.forEach((line, day) => {
      const { nutrients, missingRecipes } = week.days[day];
      const hasMeals = items.some((item) => item.day === day);
      const offTarget = review.days[day].checks.filter((c) => c.status !== "ok").length;
      line.replaceChildren(...present([
        hasMeals && nutrients.kcal > 0 && MACROS.map((key) =>
          `${key === "kcal" ? "" : `${NUTRIENTS.find((n) => n.key === key).label} `}${nutrientText(nutrients, key)}`).join(" · "),
        hasMeals && missingRecipes.length > 0 && el("span", { className: "warn-text" },
          `${nutrients.kcal > 0 ? " · " : ""}⚠ nutrition incomplete for ${missingRecipes.join(", ")}`),
        hasMeals && review.goalKeys.length > 0 && " · ",
        hasMeals && review.goalKeys.length > 0 && el("a", { href: `#/goals/${weekStart}`,
          className: offTarget ? "goal-flag off" : "goal-flag ok" },
        offTarget ? `${plural(offTarget, "goal")} off target` : "✓ goals met"),
      ]));
    });

    if (summary.recipes.length === 0) {
      summaryBox.replaceChildren(el("strong", {}, "Nothing planned yet"),
        el("span", { className: "meta" }, "Add meals to the days below."));
      return;
    }
    const recipeCount = summary.recipes.length;
    summaryBox.replaceChildren(
      el("p", { className: "label" }, "To cook this week"),
      el("strong", {}, `${portionsLabel(summary.totalPortions)} across ${recipeCount} ${recipeCount === 1 ? "recipe" : "recipes"}`),
      el("ul", {}, summary.recipes.map((r) =>
        el("li", {},
          el("a", { href: `#/recipes/${r.recipeId}?portions=${r.portions}`,
            title: "Open the recipe scaled to this many portions" }, r.name),
          ` — ${portionsLabel(r.portions)} `,
          el("span", { className: "meta" }, `(${r.days.map((d) => DAYS[d].slice(0, 3)).join(", ")})`)
        )))
    );
  }

  function renderItem(item) {
    return el("li", { className: "plan-item" },
      recipeSelect(item.recipeId, { "aria-label": `Meal on ${DAYS[item.day]}`, onChange: (event) => {
        mealPlans.updateItem(item.id, { recipeId: event.target.value });
        refreshTotals();
      } }),
      portionsInput(item.portions, { "aria-label": "Portions", onChange: (event) => {
        const value = Number(event.target.value);
        if (Number.isInteger(value) && value >= 1) {
          mealPlans.updateItem(item.id, { portions: value });
          item.portions = value;
        } else {
          event.target.value = item.portions; // not a valid number: put the old value back
        }
        refreshTotals();
      } }),
      el("button", { type: "button", className: "remove", "aria-label": `Remove ${item.recipeName}`,
        onClick: () => { mealPlans.removeItem(item.id); draw(); } }, "×")
    );
  }

  function renderDay(day, items) {
    const date = mealPlans.addDays(weekStart, day);
    const total = el("span", { className: "meta" });
    dayTotals[day] = total;
    const nutritionLine = el("p", { className: "meta day-nutrition" });
    dayNutrition[day] = nutritionLine;

    const addSelect = recipeSelect(null, { "aria-label": `Meal to add on ${DAYS[day]}` });
    const addPortions = portionsInput(1, { "aria-label": "Portions to add" });
    const addForm = el("form", { className: "plan-add", onSubmit: (event) => {
      event.preventDefault();
      if (mealPlans.addItem(weekStart, day, addSelect.value, Number(addPortions.value))) draw();
      else addSelect.focus(); // nothing chosen (or bad portions): point at the dropdown
    } }, addSelect, addPortions, el("button", { type: "submit", className: "button" }, "Add"));

    return el("section", { className: date === today ? "card day today" : "card day" },
      el("header", {}, el("h2", {}, DAYS[day], el("span", { className: "meta" }, ` · ${shortDate(date)}`)), total),
      nutritionLine,
      items.length > 0 && el("ul", { className: "plan-items" }, items.map(renderItem)),
      addForm
    );
  }

  // Rebuilds the seven days (after adding or removing a meal).
  function draw() {
    const items = mealPlans.listItems(weekStart);
    dayList.replaceChildren(...DAYS.map((_, day) => renderDay(day, items.filter((i) => i.day === day))));
    refreshTotals();
  }

  // "Add to several days": one recipe, the same portions, on each ticked day.
  // Handy for batch cooking: cook once, eat it Monday to Thursday.
  function renderBatchForm() {
    const select = recipeSelect(null, { "aria-label": "Meal to add" });
    const portions = portionsInput(1, { "aria-label": "Portions per day" });
    const dayBoxes = DAYS.map((name, day) => el("label", { className: "day-toggle" },
      el("input", { type: "checkbox", value: day }), name.slice(0, 3)));
    const message = el("p", { className: "meta", "aria-live": "polite" });

    return el("details", { className: "card batch-form" },
      el("summary", {}, "Add a meal to several days"),
      el("form", { onSubmit: (event) => {
        event.preventDefault();
        const days = dayBoxes.map((box) => box.firstChild).filter((box) => box.checked).map((box) => Number(box.value));
        if (!select.value) { message.textContent = "Pick a meal."; return select.focus(); }
        if (days.length === 0) { message.textContent = "Tick at least one day."; return; }
        const added = mealPlans.addToDays(weekStart, days, select.value, Number(portions.value));
        if (added === 0) { message.textContent = "Portions must be a whole number of 1 or more."; return; }
        message.textContent = `Added to ${plural(added, "day")}.`;
        dayBoxes.forEach((box) => { box.firstChild.checked = false; });
        draw();
      } },
        el("div", { className: "plan-add" }, select, portions, el("span", { className: "meta" }, "per day")),
        el("div", { className: "day-toggles" }, dayBoxes),
        el("button", { type: "submit", className: "button primary" }, "Add"),
        message));
  }

  draw();
  return [
    el("div", { className: "page-header" },
      el("h1", {}, "Meal plan"),
      el("a", { className: "button", href: `#/grocery/${weekStart}` }, "Grocery list →")),
    el("p", { className: "muted intro" },
      "Plan what you'll eat each day. Portions of the same recipe are added up into one batch to cook."),
    weekNav, summaryBox, renderBatchForm(), dayList,
  ];
}

// ---------- Grocery list ----------

function renderGroceryList(weekStart) {
  const body = el("div");

  // Page state that survives redraws:
  let mergeMode = false;
  const selected = new Set();  // keys of items ticked for merging
  const openKeys = new Set();  // items whose details are expanded
  let editingKey = null;       // item whose amount is being edited
  let errorMessage = "";       // last error, shown next to what caused it
  let errorFor = null;         // "merge", an item key, or an ingredient id

  function fail(where, message) {
    errorFor = where;
    errorMessage = message;
    draw();
  }

  // Runs a change, then redraws. `action` returns an error message or null.
  function attempt(where, action) {
    const error = action();
    if (error) return fail(where, error);
    errorFor = null;
    draw();
  }

  function errorText(where) {
    return errorFor === where && el("p", { className: "error-text", role: "alert" }, errorMessage);
  }

  function badge(text, extraClass = "") {
    return el("span", { className: `badge ${extraClass}` }, text);
  }

  // "Black beans is listed twice (can and g)..." with a form to say how they relate.
  function renderConflict(conflict) {
    const units = conflict.units;
    // Usually you'd convert the count unit (can) into the weight/volume (g).
    const from = units.find((u) => findUnit(u).kind === "count") ?? units[0];
    const to = units.find((u) => groupFor(u) !== groupFor(from)) ?? units[1];
    const options = (chosen) => units.map((u) => el("option", { value: u, selected: u === chosen }, u));

    const fromSelect = el("select", { "aria-label": "From unit" }, options(from));
    const amountInput = el("input", { inputMode: "decimal", placeholder: "400", "aria-label": "Amount",
      className: "portions" });
    const toSelect = el("select", { "aria-label": "To unit" }, options(to));

    return el("li", {},
      el("p", {}, el("strong", {}, conflict.name),
        ` is listed more than once (${units.join(" and ")}) because those units can't be added together automatically. If you know how they relate, tell the app:`),
      el("form", { className: "equivalence-form", onSubmit: (event) => {
        event.preventDefault();
        attempt(conflict.ingredientId, () => grocery.setEquivalence(conflict.ingredientId,
          fromSelect.value, parseQuantity(amountInput.value), toSelect.value));
      } }, "1", fromSelect, "=", amountInput, toSelect, el("button", { type: "submit", className: "button" }, "Combine")),
      errorText(conflict.ingredientId)
    );
  }

  function renderSources(item) {
    const mixedIngredients = item.ingredientIds.length > 1;
    return el("ul", { className: "sources" }, item.sources.map((s) =>
      el("li", {},
        mixedIngredients ? `${s.name}, ` : "",
        `${s.recipeName} (${portionsLabel(s.portions)}): ${formatAmount(s.quantity, s.unit)}`,
        s.via && el("span", { className: "muted" },
          ` → ${formatAmount(s.asQuantity, s.asUnit)} (using 1 ${s.unit} = ${formatAmount(s.via.toQuantity, s.via.toUnit)})`)
      )));
  }

  function renderEditForm(item) {
    const qtyInput = el("input", { value: quantityForInput(item.quantity), inputMode: "decimal",
      "aria-label": "Amount", className: "portions" });
    const unitInput = unitSelect(item.unit);
    return el("form", { className: "edit-amount", onSubmit: (event) => {
      event.preventDefault();
      attempt(item.key, () => {
        const error = grocery.setOverride(weekStart, item, parseQuantity(qtyInput.value), unitInput.value);
        if (!error) editingKey = null; // saved: close the form (on error it stays open)
        return error;
      });
    } },
      qtyInput, unitInput,
      el("button", { type: "submit", className: "button primary" }, "Save"),
      el("button", { type: "button", className: "button", onClick: () => { editingKey = null; draw(); } }, "Cancel"));
  }

  function renderItem(item) {
    const details = el("details", { open: openKeys.has(item.key) },
      el("summary", {},
        el("span", { className: "item-name" }, item.name,
          item.mergeId && badge("merged"),
          item.override && badge(item.override.stale ? "edited · plan changed" : "edited",
            item.override.stale ? "warn" : ""),
          item.rounded && badge("rounded up")),
        el("span", { className: "amount" }, formatAmount(item.quantity, item.unit))
      ),
      el("div", { className: "item-details" },
        el("p", { className: "label" }, "Needed for"),
        renderSources(item),
        item.explanation && el("p", { className: "maths" }, "Total: ", item.explanation),
        item.override && el("p", { className: item.override.stale ? "warn-text" : "muted" },
          item.override.stale
            ? `Your meal plan changed after you edited this. The calculated amount is now ${formatAmount(item.calculated.quantity, item.calculated.unit)}.`
            : `You changed this from the calculated ${formatAmount(item.calculated.quantity, item.calculated.unit)}.`),
        editingKey === item.key
          ? renderEditForm(item)
          : el("div", { className: "actions" },
            el("button", { type: "button", className: "button", onClick: () => { editingKey = item.key; errorFor = null; draw(); } },
              "Edit amount"),
            item.override && el("button", { type: "button", className: "button",
              onClick: () => attempt(item.key, () => grocery.clearOverride(item)) }, "Use calculated amount"),
            item.mergeId && el("button", { type: "button", className: "button",
              onClick: () => attempt(item.key, () => grocery.unmerge(item)) }, "Unmerge")),
        errorText(item.key)
      )
    );
    details.addEventListener("toggle", () => {
      if (details.open) openKeys.add(item.key);
      else openKeys.delete(item.key);
    });

    if (!mergeMode) return el("li", { className: "grocery-item" }, details);

    const tick = el("input", { type: "checkbox", checked: selected.has(item.key),
      "aria-label": `Select ${item.name} to merge`, onChange: () => {
        if (tick.checked) selected.add(item.key);
        else selected.delete(item.key);
        updateMergeBar();
      } });
    return el("li", { className: "grocery-item selecting" }, tick, details);
  }

  // The merge bar's pieces, kept so ticking a box doesn't redraw the page.
  let mergeButton = null;
  let mergeName = null;
  function updateMergeBar() {
    if (!mergeButton) return;
    mergeButton.textContent = `Merge ${selected.size} selected`;
    mergeButton.disabled = selected.size < 2;
  }

  function renderToolbar(items) {
    if (!mergeMode) {
      mergeButton = mergeName = null;
      return el("div", { className: "toolbar" },
        el("span", { className: "meta" }, `${items.length} ${items.length === 1 ? "item" : "items"}`),
        el("button", { type: "button", className: "button", onClick: () => { mergeMode = true; errorFor = null; draw(); } },
          "Merge items…"));
    }

    mergeName = el("input", { placeholder: "Name for the combined item (optional)", "aria-label": "Merged item name" });
    mergeButton = el("button", { type: "submit", className: "button primary" });
    updateMergeBar();
    return el("form", { className: "merge-bar card", onSubmit: (event) => {
      event.preventDefault();
      const chosen = items.filter((item) => selected.has(item.key));
      attempt("merge", () => {
        const error = grocery.mergeItems(weekStart, chosen, mergeName.value);
        if (!error) { mergeMode = false; selected.clear(); }
        return error;
      });
    } },
      el("p", {}, "Tick the items to combine into one line, e.g. “Bell pepper” and “Bell peppers”."),
      mergeName,
      el("div", { className: "actions" }, mergeButton,
        el("button", { type: "button", className: "button", onClick: () => {
          mergeMode = false; selected.clear(); errorFor = null; draw();
        } }, "Cancel")),
      errorText("merge"));
  }

  function draw() {
    const summary = mealPlans.summarize(weekStart);
    if (summary.recipes.length === 0) {
      body.replaceChildren(el("div", { className: "empty" },
        el("p", {}, "Nothing is planned for this week, so there's nothing to buy yet."),
        el("a", { className: "button primary", href: `#/plan/${weekStart}` }, "Plan meals")));
      return;
    }

    const { items, conflicts, equivalences } = grocery.buildList(weekStart);
    for (const key of selected) {
      if (!items.some((item) => item.key === key)) selected.delete(key);
    }

    body.replaceChildren(...present([
      el("p", { className: "meta" },
        `For ${portionsLabel(summary.totalPortions)}: `,
        summary.recipes.map((r) => `${r.name} ×${r.portions}`).join(", ")),
      conflicts.length > 0 && el("section", { className: "card notice" },
        el("ul", {}, conflicts.map(renderConflict))),
      renderToolbar(items),
      el("ul", { className: "grocery-list" }, items.map(renderItem)),
      equivalences.length > 0 && el("section", { className: "conversions" },
        el("h2", {}, "Unit conversions you've set"),
        el("ul", {}, equivalences.map((e) => el("li", {},
          `${e.name}: 1 ${e.fromUnit} = ${formatAmount(e.toQuantity, e.toUnit)} `,
          el("button", { type: "button", className: "link",
            onClick: () => attempt(null, () => grocery.removeEquivalence(e.id)) }, "Remove")))))
    ]));
  }

  draw();
  return [
    el("div", { className: "page-header" },
      el("h1", {}, "Grocery list"),
      el("div", { className: "actions" },
        el("a", { className: "button", href: `#/plan/${weekStart}` }, "← Meal plan"),
        el("a", { className: "button primary", href: `#/shop/${weekStart}` }, "Start shopping →"))),
    renderWeekNav("grocery", weekStart),
    body,
  ];
}

// ---------- Dietary goals ----------

// { min: 2000, max: 2200 } -> "2,000–2,200 kcal"; { min: 120 } -> "at least 120 g"
function goalText(goal, unit) {
  if (goal.min !== null && goal.max !== null) return `${formatNutrient(goal.min)}–${formatNutrient(goal.max)} ${unit}`;
  if (goal.min !== null) return `at least ${formatNutrient(goal.min)} ${unit}`;
  return `at most ${formatNutrient(goal.max)} ${unit}`;
}

// One nutrient's result: "Calories 1,850 kcal (goal 2,000–2,200 kcal) ↓ 150 under"
function renderGoalCheck(check) {
  const { label, unit } = NUTRIENTS.find((n) => n.key === check.key);
  const difference = check.status === "under" ? `↓ ${formatNutrient(check.goal.min - check.value)} ${unit} under`
    : check.status === "over" ? `↑ ${formatNutrient(check.value - check.goal.max)} ${unit} over` : "✓";
  return el("li", { className: `goal-check ${check.status}` },
    el("span", {}, el("strong", {}, label), ` ${formatNutrient(check.value)} ${unit}`,
      el("span", { className: "meta" }, ` (goal ${goalText(check.goal, unit)})`)),
    el("span", { className: "goal-status" }, difference));
}

function renderGoalsForm(onSaved) {
  const current = goals.getGoals();
  const message = el("p", { "aria-live": "polite" });
  const rows = NUTRIENTS.map((n) => {
    const min = el("input", { inputMode: "decimal", value: current[n.key]?.min ?? "", placeholder: "—",
      "aria-label": `${n.label}: at least` });
    const max = el("input", { inputMode: "decimal", value: current[n.key]?.max ?? "", placeholder: "—",
      "aria-label": `${n.label}: at most` });
    return { nutrient: n, min, max };
  });

  // Empty box = no limit. Returns a number, null (empty) or NaN (not a number).
  // Commas are thousands separators here: "2,300" means 2300.
  const read = (input) => {
    const text = input.value.replace(/[,\s]/g, "");
    return text === "" ? null : Number(text);
  };

  return el("form", { className: "card goals-form", onSubmit: (event) => {
    event.preventDefault();
    const errors = rows.map(({ nutrient, min, max }) => {
      const error = goals.setGoal(nutrient.key, read(min), read(max));
      return error && `${nutrient.label}: ${error}`;
    }).filter(Boolean);
    message.className = errors.length ? "error-text" : "meta";
    message.textContent = errors.length ? errors.join(" ") : "Goals saved.";
    onSaved();
  } },
    el("h2", {}, "Your daily goals"),
    el("p", { className: "meta" }, "Leave a box empty for no limit. Set only the ones you care about."),
    el("div", { className: "goals-grid" },
      el("span", {}, ""), el("span", { className: "label" }, "At least"), el("span", { className: "label" }, "At most"),
      rows.flatMap(({ nutrient, min, max }) => [
        el("span", {}, nutrient.label, el("span", { className: "meta" }, ` (${nutrient.unit})`)), min, max])),
    el("p", { className: "meta" },
      "For reference, the Daily Values Health Canada uses on food labels include: sodium 2,300 mg, fibre 28 g, "
      + "sugars 100 g, saturated + trans fat 20 g. Everyone's needs differ; for personal targets, ask a doctor or dietitian."),
    el("div", { className: "actions" }, el("button", { type: "submit", className: "button primary" }, "Save goals")),
    message);
}

function renderGoals(weekStart) {
  const reviewBox = el("section", { className: "goals-review" });

  function drawReview() {
    const review = goals.reviewWeek(weekStart);
    let content;
    if (review.goalKeys.length === 0) {
      content = [el("p", { className: "muted" }, "Set at least one goal above to see how this week's plan measures up.")];
    } else if (review.plannedDays === 0) {
      content = [el("div", { className: "empty" }, el("p", {}, "Nothing is planned for this week yet."),
        el("a", { className: "button primary", href: `#/plan/${weekStart}` }, "Plan meals"))];
    } else {
      content = [
        el("p", { className: "review-headline" },
          `${review.daysOnTarget} of ${plural(review.plannedDays, "planned day")} meet all your goals.`),
        el("div", { className: "card" },
          el("p", { className: "label" }, "Average per planned day"),
          el("ul", { className: "goal-checks" }, review.averages.map(renderGoalCheck))),
        review.days.filter((d) => d.planned).map((d) => el("div", { className: "card day-review" },
          el("h3", {}, DAYS[d.day], el("span", { className: "meta" }, ` · ${shortDate(mealPlans.addDays(weekStart, d.day))}`)),
          d.incomplete && el("p", { className: "warn-text" },
            `⚠ Nutrition isn't complete for ${d.missingRecipes.join(", ")}, so real amounts are higher. `,
            el("a", { href: `#/recipes/${mealPlans.listItems(weekStart).find((i) => i.recipeName === d.missingRecipes[0])?.recipeId}` },
              "Finish it")),
          el("ul", { className: "goal-checks" }, d.checks.map(renderGoalCheck)))),
        el("p", { className: "meta" },
          "Based on what you've planned to eat each day (planned portions × nutrition per portion). "
          + "Days with nothing planned aren't counted."),
      ];
    }
    reviewBox.replaceChildren(el("h2", {}, "This week vs your goals"), ...present(content));
  }

  drawReview();
  return [
    el("h1", {}, "Dietary goals"),
    renderGoalsForm(drawReview),
    renderWeekNav("goals", weekStart),
    reviewBox,
  ];
}

// ---------- Shopping list ----------

function renderShoppingList(weekStart) {
  const body = el("div");
  let editingSections = false; // show a section dropdown on each item

  function renderItem(item) {
    const id = `shop-${item.key}`;
    const checkbox = el("input", { type: "checkbox", id, checked: item.checked, onChange: () => {
      shopping.setChecked(weekStart, item.key, checkbox.checked);
      draw();
    } });

    return el("li", { className: item.checked ? "shop-item checked" : "shop-item" },
      checkbox,
      el("label", { htmlFor: id },
        el("span", { className: "shop-line" },
          el("span", { className: "item-name" }, item.name),
          el("span", { className: "amount" }, formatAmount(item.quantity, item.unit))),
        el("span", { className: "meta" }, item.meals.join(", "))),
      editingSections && el("select", { "aria-label": `Section for ${item.name}`,
        className: item.guessed ? "section-select guessed" : "section-select",
        onChange: (event) => { shopping.setCategory(item, event.target.value); draw(); } },
        CATEGORIES.map((c) => el("option", { value: c, selected: c === item.category },
          item.guessed && c === item.category ? `${c} (guess)` : c)))
    );
  }

  function draw() {
    const { sections, total, checkedCount } = shopping.buildList(weekStart);
    if (total === 0) {
      body.replaceChildren(el("div", { className: "empty" },
        el("p", {}, "Nothing is planned for this week, so there's nothing to buy yet."),
        el("a", { className: "button primary", href: `#/plan/${weekStart}` }, "Plan meals")));
      return;
    }

    body.replaceChildren(...present([
      el("div", { className: "toolbar" },
        el("span", { className: total === checkedCount ? "progress done" : "progress" },
          total === checkedCount ? `All ${total} items done ✓` : `${checkedCount} of ${total} items checked`),
        el("div", { className: "actions" },
          checkedCount > 0 && el("button", { type: "button", className: "button", onClick: () => {
            if (confirm("Uncheck every item?")) { shopping.uncheckAll(weekStart); draw(); }
          } }, "Uncheck all"),
          el("button", { type: "button", className: editingSections ? "button primary" : "button",
            "aria-pressed": String(editingSections), onClick: () => { editingSections = !editingSections; draw(); } },
            editingSections ? "Done" : "Change sections"))),
      editingSections && el("p", { className: "meta" },
        "Pick the store section for each item. “(guess)” means the app guessed from the name; your choice is remembered for future weeks."),
      sections.map((section) => {
        const left = section.items.filter((i) => !i.checked).length;
        return el("section", { className: "shop-section" },
          el("h2", {}, section.category, el("span", { className: "meta" }, left ? ` ${left} left` : " ✓")),
          el("ul", { className: "shop-items" }, section.items.map(renderItem)));
      }),
    ]));
  }

  draw();
  return [
    el("div", { className: "page-header" },
      el("h1", {}, "Shopping list"),
      el("a", { className: "button", href: `#/grocery/${weekStart}` }, "Edit grocery list")),
    renderWeekNav("shop", weekStart),
    body,
  ];
}

// ---------- Backup & data ----------

// "5 recipes · 3 planned weeks · 2 goals" from collection sizes.
function dataSummary(counts) {
  return [
    plural(counts.recipes ?? 0, "recipe"),
    plural(counts.mealPlans ?? 0, "planned week"),
    plural(counts.nutritionGoals ?? 0, "goal"),
  ].join(" · ");
}

// ---------- Sync between devices ----------

function formatTime(iso) {
  return new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
}

// One line for the footer: "✓ Synced Sep 26, 1:23 p.m." and so on.
function syncStatusText() {
  const { status, message } = sync.status();
  if (!sync.isSignedIn() && status !== "signedOut") return "Sync is off";
  return {
    syncing: "Syncing…",
    synced: `✓ Synced ${sync.lastSyncedAt() ? formatTime(sync.lastSyncedAt()) : ""}`,
    offline: "Offline: changes will sync later",
    conflict: "⚠ Sync needs your choice",
    signedOut: "⚠ Signed out of sync",
    error: `⚠ ${message}`,
    off: "Sync is on",
  }[status];
}

// The banner above every page, shown only when sync needs attention.
function renderSyncBanner() {
  const banner = document.getElementById("sync-banner");
  const { status, message } = sync.status();
  const summary = sync.conflictSummary();

  if (status === "conflict" && summary) {
    banner.replaceChildren(el("div", { className: "card notice sync-notice" },
      el("p", {}, el("strong", {}, "Your devices have different data. Which do you want to keep?")),
      el("ul", { className: "notice-points" },
        el("li", {}, `This device: ${dataSummary(summary.device)}`),
        el("li", {}, `Your other device (saved ${formatTime(summary.cloudUpdatedAt)}): ${dataSummary(summary.cloud)}`)),
      el("p", { className: "meta" }, "The one you don't keep is replaced. To be safe, you can download a backup first on the ",
        el("a", { href: "#/data" }, "Backup & data"), " page."),
      el("div", { className: "actions" },
        el("button", { type: "button", className: "button primary", onClick: () => sync.resolveConflict("device") },
          "Keep this device's data"),
        el("button", { type: "button", className: "button", onClick: () => sync.resolveConflict("cloud") },
          "Use the other device's data"))));
  } else if (status === "signedOut") {
    banner.replaceChildren(el("div", { className: "card notice sync-notice" },
      el("p", {}, `${message} `, el("a", { href: "#/data" }, "Sign in"))));
  } else {
    banner.replaceChildren();
  }
  document.getElementById("sync-status").textContent = syncStatusText();
}

// Sign in / signed-in panel on the Backup & data page.
function renderSyncPanel() {
  const panel = el("section", { className: "card import-box" });
  let step = "email"; // "email" -> "code"
  let email = "";

  function draw(errorMessage = "", info = "") {
    const error = errorMessage && el("p", { className: "error-text", role: "alert" }, errorMessage);
    const note = info && el("p", { className: "meta" }, info);

    if (sync.isSignedIn()) {
      panel.replaceChildren(...present([
        el("h2", {}, "Sync between devices"),
        el("p", {}, "Signed in as ", el("strong", {}, sync.email() ?? "you"), "."),
        el("p", { className: "meta" }, syncStatusText()),
        el("div", { className: "actions" },
          el("button", { type: "button", className: "button", onClick: () => sync.syncNow() }, "Sync now"),
          el("button", { type: "button", className: "button", onClick: async () => { await sync.signOut(); draw(); } },
            "Sign out")),
        el("p", { className: "meta" }, "Signing out stops syncing on this device. Your data stays on it."),
      ]));
      return;
    }

    if (step === "email") {
      const input = el("input", { type: "email", id: "sync-email", value: email, autocomplete: "email",
        placeholder: "you@example.com", required: true });
      panel.replaceChildren(...present([
        el("h2", {}, "Sync between devices"),
        el("p", {}, "Sign in with your email on each device to keep your recipes, plans and goals the same everywhere. "
          + "We'll email you a sign-in link; there's no password."),
        el("form", { className: "sync-form", onSubmit: async (event) => {
          event.preventDefault();
          email = input.value;
          draw("", "Sending…");
          try {
            await sync.sendCode(email);
            step = "code";
            draw("", `Email sent to ${email}. It can take a minute; check your junk folder too.`);
          } catch (e) {
            draw(e.message);
          }
        } },
          el("label", { htmlFor: "sync-email" }, "Email"), input,
          el("button", { type: "submit", className: "button primary" }, "Email me a sign-in link")),
        note, error,
        el("p", { className: "meta" },
          "Data already on this device is kept. If your other device has different data, you'll be asked which to keep."),
      ]));
      return;
    }

    const codeInput = el("input", { id: "sync-code", autocomplete: "one-time-code",
      placeholder: "https://… or 123456", required: true });
    panel.replaceChildren(...present([
      el("h2", {}, "Sync between devices"),
      el("form", { className: "sync-form", onSubmit: async (event) => {
        event.preventDefault();
        draw("", "Signing in…");
        try {
          await sync.verifyCode(email, codeInput.value);
          draw();
        } catch (e) {
          draw(e.message.includes("expired") || e.message.includes("invalid")
            ? "That link or code didn't work. Links work once and expire after an hour; send a new one." : e.message);
        }
      } },
        el("ul", { className: "steps" },
          el("li", {}, "On this device's browser: just click the link in the email."),
          el("li", {}, "In the iPhone home-screen app: in Mail, press and hold the link, choose ",
            el("strong", {}, "Copy Link"), ", then paste it here.")),
        el("label", { htmlFor: "sync-code" }, "Sign-in link (or code) from the email"), codeInput,
        el("button", { type: "submit", className: "button primary" }, "Sign in")),
      note, error,
      el("button", { type: "button", className: "link", onClick: () => { step = "email"; draw(); } },
        "Use a different email or send a new link"),
    ]));
  }

  sync.onStatus(() => { if (panel.isConnected && sync.isSignedIn()) draw(); });
  // A message left by the sign-in link (see the start-up code at the bottom).
  const linkMessage = sessionStorage.getItem("meal-planner.signInMessage");
  sessionStorage.removeItem("meal-planner.signInMessage");
  if (linkMessage && !sync.isSignedIn()) draw(linkMessage);
  else draw();
  return panel;
}

function renderBackup() {
  const countNow = () => ({
    recipes: store.list("recipes").length,
    mealPlans: store.list("mealPlans").length,
    nutritionGoals: store.list("nutritionGoals").length,
  });
  const loadArea = el("div", { "aria-live": "polite" });

  const fileInput = el("input", { type: "file", id: "backup-file", accept: ".json,application/json",
    onChange: async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const backup = store.readBackup(await file.text());
      if (backup.error) {
        loadArea.replaceChildren(el("p", { className: "error-text" }, backup.error));
        fileInput.value = "";
        return;
      }
      const made = backup.exportedAt
        ? new Date(backup.exportedAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "an unknown date";
      loadArea.replaceChildren(
        el("p", {}, el("strong", {}, `Backup from ${made}: `), dataSummary(backup.counts)),
        el("p", { className: "warn-text" }, `This replaces everything on this device (${dataSummary(countNow())}).`),
        el("div", { className: "actions" },
          el("button", { type: "button", className: "button danger", onClick: () => {
            if (!confirm("Replace all data on this device with this backup?")) return;
            store.replaceAll(backup.data);
            loadArea.replaceChildren(el("p", {}, "✓ Backup loaded. ", el("a", { href: "#/" }, "Go to your recipes")));
            currentCounts.textContent = `This device has: ${dataSummary(countNow())}`;
            fileInput.value = "";
          } }, "Replace this device's data"),
          el("button", { type: "button", className: "button", onClick: () => {
            loadArea.replaceChildren(); fileInput.value = "";
          } }, "Cancel")));
    } });

  const currentCounts = el("p", { className: "meta" }, `This device has: ${dataSummary(countNow())}`);

  return [
    el("h1", {}, "Backup & data"),
    renderSyncPanel(),
    el("p", { className: "muted" },
      "Your data is saved in this browser, and in the cloud too if sync is on. A backup file lets you keep "
      + "your own copy, or move everything to another device or browser."),
    el("section", { className: "card import-box" },
      el("h2", {}, "Download a backup"),
      el("p", {}, "Saves all your recipes, meal plans, grocery edits, nutrition links and goals to one file. "
        + "On an iPhone it goes to the Files app, in Downloads."),
      currentCounts,
      el("div", { className: "actions" },
        el("button", { type: "button", className: "button primary", onClick: () => {
          // en-CA dates look like 2026-09-26 (today, in local time).
          downloadText(`meal-planner-backup-${new Date().toLocaleDateString("en-CA")}.json`,
            store.exportData(), "application/json");
        } }, "Download backup"))),
    el("section", { className: "card import-box backup-load" },
      el("h2", {}, "Load a backup"),
      el("p", {}, "Choose a backup file to replace everything on this device with it. "
        + "If you might want this device's current data back, download a backup of it first."),
      el("label", { htmlFor: "backup-file" }, "Backup file (.json)"),
      fileInput,
      loadArea),
  ];
}

// ---------- Flyers ----------

function weekRangeLabel(weekStart) {
  return `${shortDate(weekStart)} – ${shortDate(mealPlans.addDays(weekStart, 6))}`;
}

// Hands the user a file to save (used for the CSV template).
function downloadText(fileName, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el("a", { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function priceCell(value) {
  return el("td", { className: "num" }, value == null ? "—" : formatMoney(value));
}

function renderFlyers() {
  const all = flyers.listFlyers();

  const list = all.length === 0
    ? el("p", { className: "muted" }, "No flyers imported yet.")
    : el("ul", { className: "card-list" }, all.map((flyer) =>
      el("li", {}, el("a", { className: "card", href: `#/flyers/${flyer.id}` },
        el("strong", {}, `${flyer.storeName} · week of ${weekRangeLabel(flyer.weekStart)}`),
        el("span", { className: "meta" },
          `${plural(flyer.productCount, "product")} · ${flyer.source.toUpperCase()}${flyer.fileName ? ` (${flyer.fileName})` : ""}`)))));

  return [
    el("h1", {}, "Flyers"),
    el("p", { className: "muted" },
      "Weekly sale prices you import here are compared with your grocery list in the next steps."),
    renderFlyerImport(),
    el("h2", { className: "section-title" }, "Imported flyers"),
    list,
  ];
}

function renderFlyerImport() {
  let fileText = "";
  let fileName = "";
  let reading = null; // result of readFlyerText() while previewing

  const fileInput = el("input", { type: "file", id: "flyer-file", accept: ".csv,.tsv,.txt,.json,text/csv,application/json",
    onChange: async () => {
      const file = fileInput.files[0];
      fileText = file ? await file.text() : "";
      fileName = file?.name ?? "";
      pasteBox.value = "";
      showPreview();
    } });
  const pasteBox = el("textarea", { rows: 5, placeholder: "Product Name,Sale Price,Unit\nChicken Breast,9.99,per kg",
    "aria-label": "Flyer data (CSV or JSON)" });
  const storeInput = el("input", { id: "flyer-store", value: "Metro", autocomplete: "off" });
  const weekInput = el("input", { id: "flyer-week", type: "date", value: mealPlans.weekStartFor(),
    onChange: () => updateWeekLabel() });
  const weekLabel = el("span", { className: "meta" });
  const preview = el("div", { className: "flyer-preview", "aria-live": "polite" });

  function chosenWeekStart() {
    return mealPlans.isIsoDate(weekInput.value)
      ? mealPlans.weekStartFor(mealPlans.fromIsoDate(weekInput.value)) : null;
  }

  function updateWeekLabel() {
    const week = chosenWeekStart();
    weekLabel.textContent = week ? `Planning week: ${weekRangeLabel(week)}` : "Pick a date";
  }

  function showPreview() {
    const text = pasteBox.value.trim() ? pasteBox.value : fileText;
    reading = null;
    if (!text.trim()) {
      preview.replaceChildren();
      return;
    }
    try {
      reading = readFlyerText(text);
    } catch (error) {
      preview.replaceChildren(el("div", { className: "errors", role: "alert" }, el("p", {}, error.message)));
      return;
    }

    // Suggest the planning week from the flyer's own start date.
    const firstStart = reading.products.map((p) => p.startDate).filter(Boolean).sort()[0];
    if (firstStart) weekInput.value = firstStart;
    if (reading.flyer.storeName) storeInput.value = reading.flyer.storeName;
    updateWeekLabel();

    const { products, problems, unknownColumns } = reading;
    preview.replaceChildren(...present([
      el("p", {}, el("strong", {}, `${products.length} ${products.length === 1 ? "product" : "products"} ready to import`),
        problems.length > 0 ? `, ${problems.length} skipped` : ""),
      problems.length > 0 && el("div", { className: "card notice" },
        el("p", {}, "These rows will be skipped:"),
        el("ul", { className: "problem-list" }, problems.map((p) =>
          el("li", {}, `Row ${p.rowNumber}${p.name ? ` (${p.name})` : ""}: ${p.errors.join("; ")}`)))),
      unknownColumns.length > 0 && el("p", { className: "meta" },
        `Ignored columns the app doesn't use: ${unknownColumns.join(", ")}`),
      products.length > 0 && renderProductTable(products),
      products.length > 0 && el("div", { className: "actions" },
        el("button", { type: "button", className: "button primary", onClick: doImport },
          `Import ${products.length} ${products.length === 1 ? "product" : "products"}`),
        el("button", { type: "button", className: "button", onClick: reset }, "Cancel")),
    ]));
  }

  function doImport() {
    const weekStart = chosenWeekStart();
    if (!weekStart) return weekInput.focus();
    try {
      const flyer = flyers.importFlyer(
        { storeName: storeInput.value, weekStart, source: reading.source, fileName }, reading.products);
      go(`/flyers/${flyer.id}`);
    } catch {
      // Most likely the browser's storage is full.
      preview.prepend(el("div", { className: "errors", role: "alert" },
        el("p", {}, "Couldn't save this flyer. The browser's storage may be full; try deleting old flyers.")));
    }
  }

  function reset() {
    fileInput.value = "";
    pasteBox.value = "";
    fileText = fileName = "";
    showPreview();
  }

  updateWeekLabel();
  return el("section", { className: "card import-box" },
    el("h2", {}, "Import a flyer"),
    el("ol", { className: "steps" },
      el("li", {}, "Upload a ", el("strong", {}, "CSV or JSON file"), " of this week's sale items (or paste the data)."),
      el("li", {}, "Check the preview."),
      el("li", {}, "Click Import.")),
    el("label", { htmlFor: "flyer-file" }, "Flyer file (.csv or .json)"),
    fileInput,
    el("details", {},
      el("summary", {}, "Or paste the data instead"),
      pasteBox,
      el("button", { type: "button", className: "button", onClick: () => {
        fileInput.value = ""; fileText = fileName = ""; showPreview();
      } }, "Preview pasted data")),
    el("div", { className: "import-fields" },
      el("div", {}, el("label", { htmlFor: "flyer-store" }, "Store"), storeInput),
      el("div", {}, el("label", { htmlFor: "flyer-week" }, "Any day in the week it's for"), weekInput, weekLabel)),
    el("details", { className: "help" },
      el("summary", {}, "What should the file look like?"),
      el("p", {}, "The first row must be column names. Only ", el("strong", {}, "Product Name"),
        " and a price are required. The app understands these columns (other names like “Price” or “Was” work too):"),
      el("p", { className: "meta" },
        "Product Name, Category, Brand, Regular Price, Sale Price, Sale Description, Unit, Flyer Start Date, Flyer End Date"),
      el("p", {}, "Dates look like 2026-09-24. Prices can be 9.99, $9.99 or 2/$5. Units like “per kg”, “/lb”, “each” or “400 g”."),
      el("button", { type: "button", className: "button", onClick: () =>
        downloadText("flyer-template.csv", FLYER_CSV_TEMPLATE, "text/csv") }, "Download a CSV template")),
    preview
  );
}

function renderProductTable(products) {
  return el("div", { className: "table-scroll" }, el("table", { className: "ingredients products" },
    el("thead", {}, el("tr", {},
      el("th", {}, "Product"), el("th", { className: "hide-narrow" }, "Category"),
      el("th", { className: "num" }, "Regular"), el("th", { className: "num" }, "Sale"), el("th", {}, "Unit"))),
    el("tbody", {}, products.map((p) => {
      // How much cheaper the sale price is, as a percentage of the regular price.
      const saving = p.regularPrice > 0 && p.salePrice != null && p.salePrice < p.regularPrice
        ? Math.round(((p.regularPrice - p.salePrice) / p.regularPrice) * 100) : null;
      return el("tr", {},
        el("td", {}, p.productName,
          (p.brand || p.saleDescription) && el("div", { className: "meta" },
            [p.brand, p.saleDescription].filter(Boolean).join(" · "))),
        el("td", { className: "hide-narrow" }, p.category || "—"),
        priceCell(p.regularPrice),
        el("td", { className: "num" }, p.salePrice == null ? "—" : formatMoney(p.salePrice),
          saving !== null && el("div", { className: "saving" }, `save ${saving}%`)),
        el("td", {}, p.unit || "—"));
    }))));
}

function renderFlyer(id) {
  const flyer = flyers.getFlyer(id);
  if (!flyer) return renderNotFound();

  const deleteButton = el("button", { type: "button", className: "button danger", onClick: () => {
    if (confirm(`Delete the ${flyer.storeName} flyer and its ${plural(flyer.products.length, "product")}?`)) {
      flyers.deleteFlyer(flyer.id);
      go("/flyers");
    }
  } }, "Delete flyer");

  const validDates = flyer.startDate
    ? `Valid ${shortDate(flyer.startDate)}${flyer.endDate ? ` – ${shortDate(flyer.endDate)}` : ""} · ` : "";

  return [
    el("a", { className: "back", href: "#/flyers" }, "← All flyers"),
    el("div", { className: "page-header" }, el("h1", {}, flyer.storeName), deleteButton),
    el("p", { className: "meta" },
      `${validDates}Used for the week of ${weekRangeLabel(flyer.weekStart)} · ${plural(flyer.products.length, "product")}`),
    renderProductTable(flyer.products),
  ];
}

// ---------- Routing ----------

function renderNotFound() {
  return [el("h1", {}, "Not found"),
    el("p", {}, "That page or recipe doesn't exist (it may have been deleted). ",
      el("a", { href: "#/" }, "Back to recipes"))];
}

function route() {
  // "#/recipes/abc?portions=6" -> path parts ["recipes", "abc"] and query { portions: "6" }
  const [path, queryString = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const query = new URLSearchParams(queryString);
  const queryPortions = Number(query.get("portions"));
  const startPortions = Number.isInteger(queryPortions) && queryPortions >= 1 ? queryPortions : undefined;
  let content;

  if (parts.length === 0) content = renderRecipeList();
  else if (parts[0] === "plan" && !parts[1]) content = renderMealPlan(mealPlans.weekStartFor());
  else if (parts[0] === "plan" && mealPlans.isIsoDate(parts[1])) {
    content = renderMealPlan(mealPlans.weekStartFor(mealPlans.fromIsoDate(parts[1])));
  }
  else if (parts[0] === "grocery" && !parts[1]) content = renderGroceryList(mealPlans.weekStartFor());
  else if (parts[0] === "grocery" && mealPlans.isIsoDate(parts[1])) {
    content = renderGroceryList(mealPlans.weekStartFor(mealPlans.fromIsoDate(parts[1])));
  }
  else if (parts[0] === "data") content = renderBackup();
  else if (parts[0] === "goals" && !parts[1]) content = renderGoals(mealPlans.weekStartFor());
  else if (parts[0] === "goals" && mealPlans.isIsoDate(parts[1])) {
    content = renderGoals(mealPlans.weekStartFor(mealPlans.fromIsoDate(parts[1])));
  }
  else if (parts[0] === "shop" && !parts[1]) content = renderShoppingList(mealPlans.weekStartFor());
  else if (parts[0] === "shop" && mealPlans.isIsoDate(parts[1])) {
    content = renderShoppingList(mealPlans.weekStartFor(mealPlans.fromIsoDate(parts[1])));
  }
  // Flyers are hidden for now (no authorized data source). The code is kept;
  // uncomment these two lines and the menu link in index.html to bring it back.
  // else if (parts[0] === "flyers" && !parts[1]) content = renderFlyers();
  // else if (parts[0] === "flyers") content = renderFlyer(parts[1]);
  else if (parts[0] === "recipes" && parts[1] === "new") content = renderRecipeForm(null);
  else if (parts[0] === "recipes" && parts[1] === "import") content = renderRecipeImport();
  else if (parts[0] === "recipes" && parts[1] && parts[2] === "edit") content = renderRecipeForm(parts[1]);
  else if (parts[0] === "recipes" && parts[1]) content = renderRecipe(parts[1], startPortions);
  else content = renderNotFound();

  view.replaceChildren(...present([content]));

  // Highlight the current section in the top menu.
  const section = ["plan", "grocery", "shop", "goals", "flyers"].includes(parts[0]) ? parts[0] : "recipes";
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === section) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  window.scrollTo(0, 0);
}

// Coming back from the sign-in link in the email? Finish signing in, then
// show the Backup & data page (instead of treating the link's details as a page).
const linkSignIn = sync.completeSignInFromLink();
if (linkSignIn) {
  sessionStorage.setItem("meal-planner.signInMessage", linkSignIn.error ?? "✓ Signed in. Syncing…");
  history.replaceState(null, "", "#/data");
}

window.addEventListener("hashchange", route);
route();

// Sync: redraw the page when newer data arrives from another device, keep the
// status line and banner current, and check the cloud once at start-up.
sync.onRemoteData(route);
sync.onStatus(renderSyncBanner);
renderSyncBanner();
sync.syncNow();
