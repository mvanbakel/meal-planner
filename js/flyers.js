// flyers: importing weekly sale data. No HTML here.
//
// Two collections (see README "Data model"):
//   flyers         - one per import: { storeName, weekStart, source, fileName, startDate, endDate }
//   flyerProducts  - one per product: { flyerId, productName, category, brand, regularPrice,
//                    salePrice, saleDescription, unit, unitQuantity, unitKey, startDate, endDate }
//
// How data gets in, in three steps:
//   1. A SOURCE turns raw input into plain rows ({ "Product Name": "...", ... }).
//      Today: CSV text and JSON text. An authorized store API would be one more
//      source whose rows come from the internet instead of a file.
//   2. normalizeProduct() turns any row into a FlyerProduct, whatever the
//      column names were, and lists any problems.
//   3. flyers.importFlyer() saves the flyer and its products.
// Steps 2 and 3 don't care where the data came from.

// ---------- Step 1: sources ----------

// Splits CSV text into rows of cells. Handles "quoted, values" and "" inside
// quotes. The separator is detected from the first line: comma, tab, semicolon
// or | (so "Chicken Breast | Meat | Brand X | 12.99" works too).
function parseDelimited(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const separator = [",", "\t", ";", "|"]
    .map((sep) => ({ sep, count: firstLine.split(sep).length }))
    .sort((a, b) => b.count - a.count)[0].sep;

  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; } // "" = a literal quote
      else if (char === '"') inQuotes = false;
      else cell += char;
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === separator) {
      row.push(cell); cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);

  // Drop blank lines.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const FLYER_SOURCES = {
  csv: {
    label: "CSV",
    // First row = column names; each following row becomes { columnName: value }.
    parse(text) {
      const [header = [], ...rows] = parseDelimited(text);
      return {
        columns: header,
        rows: rows.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""]))),
      };
    },
  },
  json: {
    label: "JSON",
    // Accepts either a list of products, or { store, startDate, endDate, products: [...] }.
    parse(text) {
      const data = JSON.parse(text);
      if (Array.isArray(data)) return { rows: data };
      if (data && Array.isArray(data.products)) {
        return {
          rows: data.products,
          flyer: { storeName: data.store ?? data.storeName, startDate: data.startDate, endDate: data.endDate },
        };
      }
      throw new Error('JSON must be a list of products, or an object with a "products" list.');
    },
  },
  // Later: an authorized API source, e.g.
  //   api: { label: "Store API", async fetchRows(storeId, week) { ... return { rows } } }
};

// "[" or "{" at the start means JSON; anything else is treated as CSV.
function detectSource(text) {
  return /^\s*[[{]/.test(text) ? "json" : "csv";
}

// ---------- Step 2: normalizing ----------

// Different files name columns differently. Column names are compared with
// spaces, capitals and punctuation removed ("Sale Price" -> "saleprice").
const FIELD_ALIASES = {
  productName: ["productname", "product", "name", "item", "itemname"],
  category: ["category", "department", "dept", "aisle"],
  brand: ["brand", "brandname", "manufacturer"],
  regularPrice: ["regularprice", "regular", "regprice", "was", "originalprice", "wasprice"],
  salePrice: ["saleprice", "sale", "price", "now", "nowprice", "flyerprice"],
  saleDescription: ["saledescription", "description", "promo", "promotion", "deal", "offer", "details"],
  unit: ["unit", "per", "priceunit", "size", "uom"],
  startDate: ["flyerstartdate", "startdate", "start", "validfrom", "from"],
  endDate: ["flyerenddate", "enddate", "end", "validto", "validuntil", "until", "to"],
};

function simplifyKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Finds which FlyerProduct field a column name means, or null if unknown.
function fieldForColumn(columnName) {
  const simple = simplifyKey(columnName);
  return Object.keys(FIELD_ALIASES).find((field) =>
    simple === simplifyKey(field) || FIELD_ALIASES[field].includes(simple)) ?? null;
}

// Reads a price. Returns a number, null if blank, or NaN if unreadable.
//   "$12.99" -> 12.99      "12,99" -> 12.99
//   "2/$5" or "2 for $5" -> 2.5  (a multi-buy deal is turned into the price of ONE)
function parsePrice(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim().toLowerCase().replace(/\$/g, "").replace(",", ".");
  if (!text) return null;
  const multiBuy = text.match(/^(\d+)\s*(?:\/|for)\s*(\d*\.?\d+)$/);
  if (multiBuy) return Number(multiBuy[2]) / Number(multiBuy[1]);
  return /^\d*\.?\d+$/.test(text) ? Number(text) : NaN;
}

// Words shoppers use for units, mapped to the app's unit keys (units.js).
const PRICE_UNIT_WORDS = {
  g: "g", gram: "g", grams: "g", kg: "kg", kilo: "kg", kilogram: "kg",
  lb: "lb", lbs: "lb", pound: "lb", oz: "oz",
  ml: "ml", l: "L", litre: "L", liter: "L",
  ea: "each", each: "each", item: "each", unit: "each",
  can: "can", pkg: "package", package: "package", pack: "package", bunch: "bunch",
};

// Understands what a price is FOR, so later phases can work out costs:
//   "per kg" -> { unitQuantity: 1, unitKey: "kg" }
//   "/lb"    -> { unitQuantity: 1, unitKey: "lb" }
//   "400 g"  -> { unitQuantity: 400, unitKey: "g" }   (a 400 g package)
//   "each"   -> { unitQuantity: 1, unitKey: "each" }
//   "540 ml can" -> { unitQuantity: 540, unitKey: "ml" }  (words after the unit are ignored)
// Returns nulls when it can't tell; the original text is always kept too.
function parsePriceUnit(text) {
  const cleaned = String(text ?? "").trim().toLowerCase().replace(/^(per|\/)\s*/, "");
  const match = cleaned.match(/^(\d*\.?\d+)?\s*([a-z]+)\b/);
  const unitKey = match ? PRICE_UNIT_WORDS[match[2]] : undefined;
  if (!unitKey) return { unitQuantity: null, unitKey: null };
  return { unitQuantity: match[1] ? Number(match[1]) : 1, unitKey };
}

function isIsoDateText(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T00:00`).getTime());
}

// Turns one raw row into a FlyerProduct. Returns { product, errors }.
// `defaults` fills in anything the row doesn't have (e.g. dates for the whole flyer).
function normalizeProduct(row, defaults = {}) {
  const values = { ...defaults };
  for (const [column, value] of Object.entries(row ?? {})) {
    const field = fieldForColumn(column);
    if (field && value !== "" && value != null) values[field] = typeof value === "string" ? value.trim() : value;
  }

  const errors = [];
  const productName = String(values.productName ?? "").trim();
  if (!productName) errors.push("no product name");

  const regularPrice = parsePrice(values.regularPrice);
  const salePrice = parsePrice(values.salePrice);
  if (Number.isNaN(regularPrice)) errors.push(`regular price "${values.regularPrice}" isn't a number`);
  if (Number.isNaN(salePrice)) errors.push(`sale price "${values.salePrice}" isn't a number`);
  if (regularPrice === null && salePrice === null) errors.push("no price");

  for (const field of ["startDate", "endDate"]) {
    if (values[field] && !isIsoDateText(values[field])) {
      errors.push(`${field === "startDate" ? "start" : "end"} date "${values[field]}" should look like 2026-09-24`);
    }
  }
  if (values.startDate && values.endDate && values.endDate < values.startDate) {
    errors.push("end date is before start date");
  }

  const unit = String(values.unit ?? "").trim();
  return {
    errors,
    product: {
      productName,
      category: String(values.category ?? "").trim(),
      brand: String(values.brand ?? "").trim(),
      regularPrice: Number.isNaN(regularPrice) ? null : regularPrice,
      salePrice: Number.isNaN(salePrice) ? null : salePrice,
      saleDescription: String(values.saleDescription ?? "").trim(),
      unit,
      ...parsePriceUnit(unit),
      startDate: values.startDate ?? null,
      endDate: values.endDate ?? null,
    },
  };
}

// Reads a whole file's text. Returns
//   { source, products, problems, flyer, unknownColumns }
// problems: [{ rowNumber, name, errors }] for rows that will be skipped.
// Throws an Error with a readable message if the file can't be read at all.
function readFlyerText(text) {
  const source = detectSource(text);
  let parsed;
  try {
    parsed = FLYER_SOURCES[source].parse(text);
  } catch (error) {
    throw new Error(`Couldn't read this as ${FLYER_SOURCES[source].label}: ${error.message}`);
  }
  // Check the column names first: a file without a header row is the most common mistake.
  const columns = parsed.columns ?? [...new Set(parsed.rows.flatMap((row) => Object.keys(row ?? {})))];
  if (!columns.some((c) => fieldForColumn(c) === "productName")) {
    throw new Error(`Couldn't find a product name column. The first row must be column names, e.g. "Product Name, Sale Price". The first row found was: ${columns.join(", ") || "(empty)"}`);
  }
  if (parsed.rows.length === 0) throw new Error("Found the column names but no products under them.");

  const flyerDefaults = { startDate: parsed.flyer?.startDate, endDate: parsed.flyer?.endDate };
  const products = [];
  const problems = [];
  parsed.rows.forEach((row, index) => {
    const { product, errors } = normalizeProduct(row, flyerDefaults);
    // Row numbers as you'd see them in a spreadsheet (row 1 is the header).
    if (errors.length) problems.push({ rowNumber: index + (source === "csv" ? 2 : 1), name: product.productName, errors });
    else products.push(product);
  });

  return {
    source,
    products,
    problems,
    flyer: parsed.flyer ?? {},
    unknownColumns: columns.filter((c) => !fieldForColumn(c)),
  };
}

// A starter file for the user to fill in.
const FLYER_CSV_TEMPLATE = [
  "Product Name,Category,Brand,Regular Price,Sale Price,Sale Description,Unit,Flyer Start Date,Flyer End Date",
  "Chicken Breast,Meat,Brand X,12.99,9.99,Save $3.00,per kg,2026-09-24,2026-09-30",
  "Bell Peppers,Produce,,1.99,1.29,,each,2026-09-24,2026-09-30",
  "Black Beans,Pantry,Brand Y,1.79,2/$3,2 for $3,540 ml can,2026-09-24,2026-09-30",
].join("\n");

// ---------- Step 3: saving ----------

const flyers = (() => {
  // Earliest start and latest end date among the products (or null).
  function dateRange(products) {
    const starts = products.map((p) => p.startDate).filter(Boolean).sort();
    const ends = products.map((p) => p.endDate).filter(Boolean).sort();
    return { startDate: starts[0] ?? null, endDate: ends[ends.length - 1] ?? null };
  }

  // Saves a flyer and its products. `details`: { storeName, weekStart, source, fileName }.
  function importFlyer(details, products) {
    const flyer = store.insert("flyers", {
      storeName: String(details.storeName ?? "").trim() || "Unnamed store",
      weekStart: details.weekStart,
      source: details.source,
      fileName: details.fileName ?? "",
      ...dateRange(products),
    });
    store.insertMany("flyerProducts", products.map((product) => ({ flyerId: flyer.id, ...product })));
    return flyer;
  }

  // All flyers, newest week first, each with a productCount.
  function listFlyers() {
    const products = store.list("flyerProducts");
    return store.list("flyers")
      .map((flyer) => ({ ...flyer, productCount: products.filter((p) => p.flyerId === flyer.id).length }))
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || b.createdAt.localeCompare(a.createdAt));
  }

  // One flyer with its products (by category, then name), or null.
  function getFlyer(id) {
    const flyer = store.get("flyers", id);
    if (!flyer) return null;
    const products = store.list("flyerProducts")
      .filter((p) => p.flyerId === id)
      .sort((a, b) => (a.category || "~").localeCompare(b.category || "~") || a.productName.localeCompare(b.productName));
    return { ...flyer, products };
  }

  // Products from every flyer assigned to this week (used for sale matching).
  function productsForWeek(weekStart) {
    const flyerIds = store.list("flyers").filter((f) => f.weekStart === weekStart).map((f) => f.id);
    return store.list("flyerProducts").filter((p) => flyerIds.includes(p.flyerId));
  }

  function deleteFlyer(id) {
    store.removeWhere("flyerProducts", (p) => p.flyerId === id);
    store.remove("flyers", id);
  }

  return { importFlyer, listFlyers, getFlyer, productsForWeek, deleteFlyer };
})();
