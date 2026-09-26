// recipeParser: turns a recipe's text (e.g. from a PDF) into a draft recipe.
// No AI: just patterns. Recipes are written in many ways, so this is a
// best guess that the user always checks in the normal recipe form.
//
// parseRecipeText(lines) -> { name, portions, description, ingredients }
// Each ingredient: { name, quantity, unit, note, source, needsReview }
//   source      - the original line, shown so the user can compare
//   needsReview - true if the amount or unit couldn't be worked out

// Fraction characters some recipes use: "½ cup".
const UNICODE_FRACTIONS = {
  "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4, "⅕": 1 / 5, "⅖": 2 / 5,
  "⅗": 3 / 5, "⅘": 4 / 5, "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8,
};

// How recipes write each unit (all lower case), mapped to the app's units.
// Single letters are handled separately because "t" (tsp) and "T" (tbsp) differ.
const UNIT_WORDS = {
  g: ["g", "gr", "gram", "grams", "gramme", "grammes"],
  kg: ["kg", "kgs", "kilogram", "kilograms", "kilo", "kilos"],
  ml: ["ml", "millilitre", "millilitres", "milliliter", "milliliters"],
  L: ["l", "litre", "litres", "liter", "liters"],
  tsp: ["tsp", "tsps", "teaspoon", "teaspoons"],
  tbsp: ["tbsp", "tbsps", "tbs", "tbl", "tablespoon", "tablespoons"],
  cup: ["cup", "cups", "c"],
  oz: ["oz", "ounce", "ounces"],
  lb: ["lb", "lbs", "pound", "pounds"],
  can: ["can", "cans", "tin", "tins"],
  package: ["package", "packages", "pkg", "pkgs", "pack", "packs", "packet", "packets"],
  bunch: ["bunch", "bunches"],
  clove: ["clove", "cloves"],
  slice: ["slice", "slices"],
  pinch: ["pinch", "pinches"],
};

// Size words moved from the name into the note: "2 large eggs" -> eggs (large).
const SIZE_WORDS = ["small", "medium", "large", "extra-large", "jumbo"];

const SECTION_HEADINGS = {
  ingredients: /^ingredients?\s*:?$/i,
  // Anything that usually comes after the ingredient list.
  end: /^(directions|instructions|method|preparation|steps|how to make( it)?|notes?|nutrition( facts| information)?|tips)\s*:?$/i,
};

// Reads the amount at the start of a line. Handles "2", "1.5", "1/2",
// "1 1/2", "½", "1½", "1 ½", and ranges like "1-2" or "1 to 2".
// Returns { quantity, rest, range } or null if the line doesn't start with an amount.
function readLeadingQuantity(text) {
  // Put a space between a number and a fraction character: "1½" -> "1 ½".
  const spaced = text.replace(/(\d)([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g, "$1 $2");
  const number = String.raw`(?:\d+\s+\d+/\d+|\d+/\d+|\d*\.\d+|\d+(?:\s+[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])?|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])`;
  const match = spaced.match(new RegExp(String.raw`^(${number})(?:\s*(?:-|–|to)\s*(${number}))?\s*(.*)$`));
  if (!match) return null;

  const toNumber = (part) => part.trim().split(/\s+/).reduce((sum, piece) => {
    if (UNICODE_FRACTIONS[piece]) return sum + UNICODE_FRACTIONS[piece];
    if (piece.includes("/")) {
      const [top, bottom] = piece.split("/").map(Number);
      return sum + top / bottom;
    }
    return sum + Number(piece);
  }, 0);

  // For a range ("1-2 onions"), use the larger number so you buy enough.
  const low = toNumber(match[1]);
  const high = match[2] ? toNumber(match[2]) : null;
  return {
    quantity: high ?? low,
    range: high ? `${match[1].trim()}–${match[2].trim()}` : null,
    rest: match[3],
  };
}

// Reads a unit word at the start of `text`. Returns { unit, rest } or null.
function readLeadingUnit(text) {
  const match = text.match(/^([A-Za-z]+)\.?(?=\s|$)\s*(.*)$/);
  if (!match) return null;
  const [, word, rest] = match;
  if (word === "t") return { unit: "tsp", rest };
  if (word === "T" || word === "TB") return { unit: "tbsp", rest };
  const lower = word.toLowerCase();
  const unit = Object.keys(UNIT_WORDS).find((key) => UNIT_WORDS[key].includes(lower));
  return unit ? { unit, rest } : null;
}

// Splits one ingredient line into its parts. Examples:
//   "600 g chicken breast"              -> 600, g, "chicken breast"
//   "1 ½ cups flour, sifted"            -> 1.5, cup, "flour", note "sifted"
//   "1 (540 ml) can black beans"        -> 1, can, "black beans", note "540 ml"
//   "2 large eggs"                      -> 2, each, "eggs", note "large"
//   "Salt and pepper to taste"          -> no amount: needs review
function parseIngredientLine(line) {
  const source = line.trim();
  // Remove list bullets: "•", "-", "*", "▢", "☐".
  let text = source.replace(/^[•\-*▢☐◦·]\s*/, "");
  const notes = [];

  let quantity = null;
  let unit = "";
  const amount = readLeadingQuantity(text);
  if (amount) {
    quantity = amount.quantity;
    text = amount.rest;
    if (amount.range) notes.push(`recipe says ${amount.range}`);

    // A package size right after the amount: "1 (540 ml) can" or "2 x 400g tins".
    const bracket = text.match(/^\(([^)]*)\)\s*(.*)$/) ?? text.match(/^[x×]\s*(\d[\d.]*\s*[a-zA-Z]*)\s+(.*)$/);
    if (bracket) {
      notes.push(bracket[1].trim());
      text = bracket[2];
    }

    const unitMatch = readLeadingUnit(text);
    if (unitMatch) {
      unit = unitMatch.unit;
      text = unitMatch.rest;
    } else {
      unit = "each"; // "2 bell peppers": counted items
    }
    text = text.replace(/^of\s+/i, ""); // "2 cups of flour"
  }

  // Size words go to the note: "large eggs" -> "eggs" + "large".
  const size = text.match(new RegExp(`^(${SIZE_WORDS.join("|")})\\s+(.*)$`, "i"));
  if (size) {
    notes.push(size[1].toLowerCase());
    text = size[2];
  }

  // Anything after a comma, or in brackets at the end, is a note:
  // "onion, finely chopped" or "butter (softened)". Commas inside brackets
  // don't count: "chicken thighs (bone-in, skin-on)".
  const comma = firstCommaOutsideBrackets(text);
  if (comma > 0) {
    notes.push(text.slice(comma + 1).trim());
    text = text.slice(0, comma);
  }
  const trailingBracket = text.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (trailingBracket && trailingBracket[1]) {
    notes.push(trailingBracket[2].trim());
    text = trailingBracket[1];
  }

  return {
    name: text.trim(),
    quantity,
    unit,
    note: notes.filter(Boolean).join(", "),
    source,
    needsReview: quantity === null || !text.trim(),
  };
}

// Position of the first comma that isn't inside (brackets), or -1.
function firstCommaOutsideBrackets(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth = Math.max(0, depth - 1);
    else if (text[i] === "," && depth === 0) return i;
  }
  return -1;
}

// Numbered steps ("1. Preheat the oven") look like amounts, so spot them.
function looksLikeStep(line) {
  return /^\d+\s*[.)]\s+\S/.test(line) || /^step\s+\d+/i.test(line);
}

// "Serves 4", "Servings: 6", "Makes 12", "Yield: 8 portions", "4 servings".
function findPortions(lines) {
  for (const { text } of lines) {
    const before = text.match(/\b(?:serves|servings?|yields?|makes|portions?)\b\s*:?\s*(\d+)/i);
    if (before) return Number(before[1]);
    const after = text.match(/\b(\d+)\s*(?:servings|portions|people)\b/i);
    if (after) return Number(after[1]);
  }
  return null;
}

// The title: the biggest text near the top that isn't a section heading.
function findName(lines) {
  const candidates = lines.slice(0, 15).filter(({ text }) =>
    text.length > 2 && text.length < 90 && !SECTION_HEADINGS.ingredients.test(text) && !SECTION_HEADINGS.end.test(text));
  if (candidates.length === 0) return "";
  return candidates.reduce((best, line) => (line.size > best.size + 0.5 ? line : best)).text;
}

// `lines`: [{ text, size }] in reading order (from extractPdfLines).
function parseRecipeText(lines) {
  const clean = lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);

  const startIndex = clean.findIndex((l) => SECTION_HEADINGS.ingredients.test(l.text));
  const endIndex = clean.findIndex((l, i) => i > startIndex && SECTION_HEADINGS.end.test(l.text));

  let ingredientLines;
  if (startIndex >= 0) {
    // There's an "Ingredients" heading: take everything up to the next section.
    ingredientLines = clean.slice(startIndex + 1, endIndex > startIndex ? endIndex : undefined)
      .map((l) => l.text)
      .filter((text) => !looksLikeStep(text));
  } else {
    // No heading: take lines that start with an amount and are short enough
    // to be an ingredient (long lines are usually instructions).
    ingredientLines = clean.map((l) => l.text)
      .filter((text) => readLeadingQuantity(text) && !looksLikeStep(text) && text.length <= 80);
  }

  const ingredients = [];
  for (const text of ingredientLines) {
    // Skip sub-headings like "For the sauce:".
    if (/:$/.test(text) && !readLeadingQuantity(text)) continue;
    const parsed = parseIngredientLine(text);
    // A line with no amount that starts lower-case, right after a long line,
    // is probably the end of that ingredient wrapped onto a new line: join it on.
    const previous = ingredients[ingredients.length - 1];
    if (parsed.quantity === null && /^[a-z(]/.test(text) && previous && previous.source.length >= 35) {
      previous.source += ` ${text}`;
      previous.note = [previous.note, text].filter(Boolean).join(" ");
      continue;
    }
    ingredients.push(parsed);
  }

  // The method becomes the description, so it's kept with the recipe.
  const methodLines = endIndex >= 0
    ? clean.slice(endIndex + 1).map((l) => l.text).filter((t) => !SECTION_HEADINGS.end.test(t))
    : [];

  return {
    name: findName(clean),
    portions: findPortions(clean),
    description: methodLines.join("\n"),
    ingredients,
  };
}
