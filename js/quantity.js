// quantity: turning typed amounts into numbers and numbers back into text,
// and scaling amounts to a different number of portions.

// Reads what the user typed into a number. Accepts:
//   "600"  "1.5"  "1/2"  "1 1/2"
// Returns null if it isn't a positive number.
function parseQuantity(text) {
  const cleaned = String(text ?? "").trim().replace(",", ".");
  if (!cleaned) return null;

  // "1 1/2" = whole part 1, plus the fraction 1/2.
  const mixed = cleaned.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  // "1/2" = a fraction on its own.
  const fraction = cleaned.match(/^(\d+)\/(\d+)$/);

  let value;
  if (mixed) value = Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  else if (fraction) value = Number(fraction[1]) / Number(fraction[2]);
  else if (/^\d*\.?\d+$/.test(cleaned)) value = Number(cleaned);
  else return null;

  return Number.isFinite(value) && value > 0 ? value : null;
}

// Displays a number with thousands separators and at most 2 decimals:
//   1500 -> "1,500"   0.3333 -> "0.33"   2 -> "2"
function formatQuantity(value) {
  return value.toLocaleString("en-CA", { maximumFractionDigits: 2 });
}

// "1,500 g", or just "2" for whole items ("each").
function formatAmount(quantity, unit) {
  return unit === "each" ? formatQuantity(quantity) : `${formatQuantity(quantity)} ${unit}`;
}

// Scales one ingredient amount to a different number of portions.
//
//   scaled = original quantity × desired portions ÷ original portions
//
// Example: a recipe makes 4 portions and uses 600 g chicken. For 10 portions:
//   600 × 10 ÷ 4 = 1,500 g
//
// Most amounts are kept exact (no rounding). Units marked `wholeOnly` in
// units.js (cans, "each", packages, bunches) can't be bought in fractions, so
// they are rounded UP to the next whole number: needing 2.5 cans means buying 3.
//
// Returns:
//   { quantity, exact, rounded }
//   quantity - the amount to use (rounded up if needed)
//   exact    - the result before any rounding
//   rounded  - true if quantity differs from exact
function scaleQuantity(quantity, originalPortions, desiredPortions, unitKey) {
  return roundUpIfWhole((quantity * desiredPortions) / originalPortions, unitKey);
}

// Rounds up amounts of `wholeOnly` units (2.5 cans -> 3); leaves others exact.
// Returns { quantity, exact, rounded } like scaleQuantity().
function roundUpIfWhole(exact, unitKey) {
  if (!findUnit(unitKey)?.wholeOnly) return { quantity: exact, exact, rounded: false };

  // Computers store decimals slightly imprecisely (0.1 × 3 = 0.30000000000000004).
  // Tidy away those tiny errors before checking for a whole number, so
  // 3.0000000001 cans counts as 3 rather than being rounded up to 4.
  const cleaned = Math.round(exact * 1e9) / 1e9;
  if (Number.isInteger(cleaned)) return { quantity: cleaned, exact: cleaned, rounded: false };
  return { quantity: Math.ceil(cleaned), exact, rounded: true };
}

// Two amounts are "the same" if they differ by less than a billionth
// (see the note above about imprecise decimals).
function sameQuantity(a, b) {
  return Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

// 9.99 -> "$9.99"
function formatMoney(amount) {
  return amount.toLocaleString("en-CA", { style: "currency", currency: "CAD" });
}
