import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { openWorkbookData, worksheetData, validateWorkbookFile, MAX_WORKBOOK_BYTES } from "../web/gpa-workbook-data.mjs";
import { detectGpaMapping, mapGpaSheet, suggestTarget, reviewedTierAssignments } from "../web/gpa-import.mjs";
import { openGpaWorkbook } from "../web/gpa-workbook.mjs";

const script = await readFile(new URL("../web/vendor/xlsx-0.20.3.full.min.js", import.meta.url), "utf8");
const scope = {};
runInNewContext(script, scope);
const XLSX = scope.XLSX;
const binary = (book, kind = "xlsx") => new Uint8Array(XLSX.write(book, { bookType: kind, type: "array" }));
function fixture() {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Instructions"], ["Fictional test data only"]]), "Read me");
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Student ID", "First name", "Last name", "GPA"],
    [910123456, "Sample", "Member", 2.699],
    ["012345678", "Leading", "Zero", 3.5],
  ]);
  sheet.A2.z = "0.00E+00";
  sheet.D2.z = "0.00";
  XLSX.utils.book_append_sheet(book, sheet, "GPA");
  book.Workbook = { Sheets: [{ Hidden: 1 }, { Hidden: 0 }] };
  return book;
}

test("Excel parser is the pinned official SheetJS release", () => {
  assert.equal(XLSX.version, "0.20.3");
  assert.equal(createHash("sha256").update(script).digest("hex"), "cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41");
});

for (const [kind, filename] of [["xlsx", "grades.xlsx"], ["biff8", "grades.xls"]]) {
  test(`${filename}: select a worksheet and preserve raw GPA, IDs, and text zeros`, () => {
    const reader = openWorkbookData(binary(fixture(), kind), filename, XLSX);
    assert.deepEqual(Array.from(reader.sheets, sheet => sheet.name), ["Read me", "GPA"]);
    assert.equal(reader.sheets[0].hidden, true);
    const sheet = reader.readSheet(1);
    assert.equal(sheet.rows[1][0], "910123456", "scientific display does not truncate an identifier");
    assert.equal(sheet.rows[1][3], "2.699", "GPA display rounding cannot change the tier");
    assert.equal(sheet.rows[2][0], "012345678");
    const rows = mapGpaSheet(sheet, detectGpaMapping(sheet));
    assert.equal(rows[0].tier, 4);
    assert.equal(rows[1].tier, 1);
    const targets = [{ name: "Sample Member", email: "sample@example.edu", schoolId: "910123456" }];
    assert.equal(suggestTarget(rows[0], targets), "sample@example.edu");
    assert.deepEqual(reviewedTierAssignments([{ row: rows[0], email: "sample@example.edu" }], targets), [{ email: "sample@example.edu", tier: 4 }]);
    assert.throws(() => reader.readSheet(2), /Choose a worksheet/);
  });
}

test("Excel cells retain physical row and column positions, including leading blanks", () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, { B3: { t: "s", v: "Name" }, C3: { t: "s", v: "GPA" },
    B4: { t: "s", v: "Sample Member" }, C4: { t: "n", v: 2.6 }, "!ref": "B3:C4" }, "Offset");
  const sheet = openWorkbookData(binary(book), "offset.xlsx", XLSX).readSheet(0);
  assert.deepEqual(sheet.rows[0], ["", "", ""]);
  assert.deepEqual(sheet.rows[2], ["", "Name", "GPA"]);
  const mapping = detectGpaMapping(sheet, 3);
  assert.equal(mapping.columns.full, 1);
  assert.equal(mapping.columns.gpa, 2);
  assert.equal(mapGpaSheet(sheet, mapping)[0].line, 4);
});

test("Cached formula values are read without execution; missing or error results cannot become blank IDs", () => {
  const book = fixture();
  const source = book.Sheets.GPA;
  source.A2 = { t: "n", f: "910123456", v: 910123456 };
  source.D2 = { t: "n", f: "2+0.6", v: 2.6 };
  source.A3 = { t: "n", f: 'WEBSERVICE("https://example.invalid/never-follow")' };
  const parsed = openWorkbookData(binary(book), "formulas.xlsx", XLSX).readSheet(1);
  assert.equal(parsed.rows[1][3], "2.6");
  assert.match(parsed.rows[2][0], /Formula result unavailable/);
  assert.equal(parsed.warnings.length, 1);
  const row = mapGpaSheet(parsed, detectGpaMapping(parsed))[1];
  assert.ok(row.schoolIdIssue);
  assert.equal(suggestTarget(row, [{ name: "Leading Zero", email: "zero@example.edu" }]), "");
  assert.throws(() => reviewedTierAssignments([{ row, email: "zero@example.edu" }], [{ name: "Leading Zero", email: "zero@example.edu" }]), /correct the 900/);
  const unusual = worksheetData({ A1: { t: "z", F: "A1:A2" }, B1: { t: "e", v: 0 }, C1: { t: "b", v: true }, D1: { t: "d", v: new Date() }, E1: { t: "s", f: 'IF(A1=0,"",A1)', v: "" } }, XLSX);
  assert.match(unusual.rows[0][0], /Formula result unavailable/);
  assert.match(unusual.rows[0][1], /Excel cell error/);
  assert.match(unusual.rows[0][2], /Unsupported value/);
  assert.match(unusual.rows[0][3], /Unsupported value/);
  assert.match(unusual.rows[0][4], /Formula result unavailable/);
});

test("Workbook validation rejects disguised text, corruption, oversized archives and invalid extensions", () => {
  const bytes = binary(fixture());
  assert.equal(validateWorkbookFile(bytes, "grades.XLX"), bytes, "common .xlx typo is only accepted with Excel contents");
  assert.throws(() => validateWorkbookFile(new TextEncoder().encode("Name,GPA\nSample,3.5"), "grades.xlsx"), /not a readable Excel/);
  assert.throws(() => validateWorkbookFile(bytes.subarray(0, 100), "broken.xlsx"), /not a readable Excel/);
  assert.throws(() => validateWorkbookFile(bytes, "grades.xlsm"), /Choose an Excel/);
  assert.throws(() => validateWorkbookFile(bytes, "grades.xls"), /\.xlsx extension/);
  assert.throws(() => validateWorkbookFile(new Uint8Array(MAX_WORKBOOK_BYTES + 1), "large.xlsx"), /under 5 MB/);
  const tampered = bytes.slice(), view = new DataView(tampered.buffer);
  const end = tampered.length - 22, central = view.getUint32(end + 16, true);
  view.setUint32(central + 24, 21 * 1024 * 1024, true);
  assert.throws(() => validateWorkbookFile(tampered, "expanded.xlsx"), /expands beyond/);
});

test("Worksheet import refuses oversized content rather than silently truncating rows or columns", () => {
  for (const address of ["A1101", "DY1"]) {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, { A1: { t: "s", v: "Name" }, [address]: { t: "s", v: "Overflow" }, "!ref": `A1:${address}` }, "Too large");
    assert.throws(() => openWorkbookData(binary(book), "large.xlsx", XLSX).readSheet(0), /exceeds 1,100 rows or 128 columns/);
  }
  assert.throws(() => worksheetData({}, XLSX), /worksheet is empty/);
  const book = XLSX.utils.book_new();
  for (let index = 0; index < 33; index++) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Name"]]), `Sheet ${index}`);
  assert.throws(() => openWorkbookData(binary(book), "sheets.xlsx", XLSX), /more than 32/);
});

test("Worker reader transfers bytes locally and terminates pending work when the dialog closes", async () => {
  const original = globalThis.Worker, workers = [];
  class FakeWorker {
    constructor(url) { this.url = url; this.sent = []; workers.push(this); }
    postMessage(message, transfer) {
      this.sent.push({ message, transfer });
      if (message.action === "open") queueMicrotask(() => this.onmessage({ data: { id: message.id, value: { sheets: [{ name: "GPA" }] } } }));
    }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeWorker;
  try {
    const buffer = new ArrayBuffer(4), signal = new AbortController();
    const reader = await openGpaWorkbook({ name: "grades.xlsx", size: 4, arrayBuffer: async () => buffer }, { signal: signal.signal });
    assert.equal(workers[0].url.pathname.endsWith("/gpa-workbook-worker.js"), true);
    assert.deepEqual(workers[0].sent[0].transfer, [buffer]);
    const pending = reader.readSheet(0);
    signal.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(workers[0].terminated, true);
    await assert.rejects(reader.readSheet(0), { name: "AbortError" });
    reader.close();
    await assert.rejects(openGpaWorkbook({ name: "grades.xlsx", size: 4, arrayBuffer: async () => buffer }, { signal: signal.signal }), { name: "AbortError" });
    assert.equal(workers.length, 1);
  } finally { globalThis.Worker = original; }
});
