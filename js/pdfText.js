// pdfText: pulls the text out of a PDF file, as lines in reading order.
// Uses Mozilla's pdf.js (vendor/pdfjs), loaded only when a PDF is opened.
//
// A PDF doesn't store "lines"; it stores bits of text at x/y positions on the
// page. This file puts bits at the same height together into lines, and
// handles two-column recipes (ingredients on the left, steps on the right).

const PDFJS_FILES = ["vendor/pdfjs/pdf.min.js", "vendor/pdfjs/pdf.worker.min.js"];
let pdfjsReady = null;

// Adds pdf.js to the page the first time it's needed.
// Loading the "worker" file as a normal script makes pdf.js run on the main
// page, which also works when index.html is opened straight from disk.
function loadPdfLibrary() {
  // Load the files one after another (the worker needs the library first).
  pdfjsReady ??= PDFJS_FILES.reduce((previous, src) => previous.then(() => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.append(script);
  })), Promise.resolve()).then(() => window.pdfjsLib);
  return pdfjsReady;
}

// Groups one page's text bits into lines. Each result: { text, size, x }.
function pageToLines(items) {
  const bits = items
    .filter((item) => item.str.trim() !== "")
    .map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      // Font size: the height of the text's scaling (transform) matrix.
      size: Math.hypot(item.transform[2], item.transform[3]) || item.height,
      width: item.width,
    }));

  // Rows: bits whose heights are within half a letter of each other.
  // PDF y counts UP from the bottom of the page, so bigger y = higher.
  const rows = [];
  for (const bit of bits.sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r.y - bit.y) < bit.size * 0.5);
    if (row) row.bits.push(bit);
    else rows.push({ y: bit.y, bits: [bit] });
  }

  // Within a row, go left to right. A big gap (over 3 letters wide) means
  // the next bit belongs to another column, so the row is split there.
  const segments = [];
  for (const row of rows) {
    row.bits.sort((a, b) => a.x - b.x);
    let current = null;
    for (const bit of row.bits) {
      const gap = current ? bit.x - current.end : 0;
      if (!current || gap > bit.size * 3) {
        current = { text: bit.text, x: bit.x, y: row.y, size: bit.size, end: bit.x + bit.width };
        segments.push(current);
      } else {
        const needsSpace = gap > bit.size * 0.15 && !current.text.endsWith(" ") && !bit.text.startsWith(" ");
        current.text += (needsSpace ? " " : "") + bit.text;
        current.size = Math.max(current.size, bit.size);
        current.end = bit.x + bit.width;
      }
    }
  }

  // Two columns? If at least a fifth of the rows were split in two, read the
  // whole left column top to bottom, then the right column.
  const splitRows = rows.filter((row) => segments.filter((s) => s.y === row.y).length > 1);
  if (splitRows.length >= Math.max(2, rows.length * 0.2)) {
    const rightStarts = splitRows
      .map((row) => segments.filter((s) => s.y === row.y).sort((a, b) => a.x - b.x)[1].x)
      .sort((a, b) => a - b);
    const boundary = rightStarts[Math.floor(rightStarts.length / 2)] - 1; // the middle value
    const left = segments.filter((s) => s.x < boundary);
    const right = segments.filter((s) => s.x >= boundary);
    return [...left, ...right].map(({ text, size, x }) => ({ text: text.trim(), size, x }));
  }
  return segments.map(({ text, size, x }) => ({ text: text.trim(), size, x }));
}

// Reads a PDF File (from an <input type="file">). Returns { lines, pageCount }.
function extractPdfLines(file) {
  return loadPdfLibrary().then(async (pdfjsLib) => {
    const data = new Uint8Array(await file.arrayBuffer());
    // isEvalSupported: false switches off a pdf.js feature with a known
    // security problem (CVE-2024-4367). Reading text doesn't need it.
    const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const lines = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      lines.push(...pageToLines((await page.getTextContent()).items));
    }
    return { lines, pageCount: pdf.numPages };
  });
}
