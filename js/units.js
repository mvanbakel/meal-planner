// units: the list of units a recipe ingredient can use.
//
// `kind` groups units that measure the same thing. Units of the same kind can
// be added together on the grocery list (grams + kilograms), different kinds
// never can (grams + cans), unless you tell the app how they relate.
//
// `toBase` says how many of the base unit one of this unit is. Weights are
// converted through grams, volumes through millilitres:
//   1 kg = 1000 g, so kg has toBase 1000.
// Cups and spoons use Canadian metric sizes (1 cup = 250 ml, 1 tbsp = 15 ml).
// Count units (cans, cloves...) have no toBase: 1 can is only ever 1 can.
//
// `wholeOnly` marks things you buy in whole numbers (you can't buy 2.5 cans),
// so they get rounded up, and the app says that it did.
const UNITS = [
  { key: "g", kind: "mass", toBase: 1 },
  { key: "kg", kind: "mass", toBase: 1000 },
  { key: "oz", kind: "mass", toBase: 28.3495 },
  { key: "lb", kind: "mass", toBase: 453.592 },
  { key: "ml", kind: "volume", toBase: 1 },
  { key: "L", kind: "volume", toBase: 1000 },
  { key: "tsp", kind: "volume", toBase: 5 },
  { key: "tbsp", kind: "volume", toBase: 15 },
  { key: "cup", kind: "volume", toBase: 250 },
  { key: "each", kind: "count", wholeOnly: true },
  { key: "can", kind: "count", wholeOnly: true },
  { key: "package", kind: "count", wholeOnly: true },
  { key: "bunch", kind: "count", wholeOnly: true },
  { key: "clove", kind: "count" },
  { key: "slice", kind: "count" },
  { key: "pinch", kind: "count" },
];

// Headings for the unit dropdown.
const UNIT_KIND_LABELS = { mass: "Weight", volume: "Volume", count: "Count" };

// The unit everything of a kind is converted to before adding.
const BASE_UNITS = { mass: "g", volume: "ml" };

function findUnit(key) {
  return UNITS.find((unit) => unit.key === key) ?? null;
}

// Converts an amount to its kind's base unit: 1.5 kg -> 1500 (g), 2 tbsp -> 30 (ml).
// Count units are returned unchanged.
function toBaseQuantity(quantity, unitKey) {
  return quantity * (findUnit(unitKey)?.toBase ?? 1);
}
