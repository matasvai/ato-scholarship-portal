// Excel-only reader shared by the browser worker and fictional-fixture tests.
// No network calls, formula evaluation, HTML conversion, or persistent storage.
export const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;
const MAX_SHEETS = 32;
const MAX_ROWS = 1100;
const MAX_COLUMNS = 128;
const fail = message => { throw Error(message); };
const malformed = () => fail("This is not a readable Excel workbook. Open it in Excel and save a new .xlsx copy, or export CSV.");

function bytesOf(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_WORKBOOK_BYTES)
    fail("Choose a nonempty Excel file under 5 MB.");
  return bytes;
}

// Check archive declarations before SheetJS expands any XML. Worker timeout and
// termination provide a second bound; archive metadata is not a memory sandbox.
function checkZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uint16 = offset => view.getUint16(offset, true);
  const uint32 = offset => view.getUint32(offset, true);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (uint32(offset) === 0x06054b50 && offset + 22 + uint16(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) malformed();
  const count = uint16(end + 10), centralSize = uint32(end + 12), centralOffset = uint32(end + 16);
  if (uint16(end + 4) || uint16(end + 6) || uint16(end + 8) !== count ||
      !count || count > 512 || centralOffset + centralSize !== end)
    fail("This workbook archive is too large or uses an unsupported format. Save a smaller .xlsx copy.");
  let offset = centralOffset, expanded = 0;
  const names = new Set();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || uint32(offset) !== 0x02014b50) malformed();
    const flags = uint16(offset + 8), compression = uint16(offset + 10);
    const compressed = uint32(offset + 20), uncompressed = uint32(offset + 24);
    const nameLength = uint16(offset + 28), extra = uint16(offset + 30), comment = uint16(offset + 32);
    const next = offset + 46 + nameLength + extra + comment;
    if (next > end || uint16(offset + 34) || uint32(offset + 42) >= centralOffset) malformed();
    if (flags & 1) fail("Password-protected workbooks cannot be imported. Save an unencrypted copy first.");
    if (![0, 8].includes(compression)) fail("This workbook uses unsupported compression. Save a new .xlsx copy.");
    expanded += uncompressed;
    if (expanded > MAX_EXPANDED_BYTES || compressed > MAX_WORKBOOK_BYTES ||
        uncompressed > Math.max(1, compressed) * 300)
      fail("This workbook expands beyond the import limit. Keep just the GPA worksheet and try again.");
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (names.has(name)) malformed();
    names.add(name);
    offset = next;
  }
  if (offset !== end || !names.has("[Content_Types].xml") || !names.has("xl/workbook.xml")) malformed();
}

export function validateWorkbookFile(input, filename) {
  const bytes = bytesOf(input);
  const extension = String(filename || "").toLowerCase().match(/\.(xlsx|xls|xlx)$/)?.[1];
  if (!extension) fail("Choose an Excel .xlsx or .xls file, or a CSV export.");
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => bytes[index] === byte);
  if (zip) {
    if (extension === "xls") fail("This file contains an .xlsx workbook. Save it with the .xlsx extension and try again.");
    checkZip(bytes);
    return bytes;
  }
  if (ole && extension !== "xlsx") return bytes;
  if (ole) fail("This .xlsx file may be encrypted. Open it in Excel and save an unencrypted .xlsx copy.");
  malformed();
}

const options = { type: "array", raw: true, dense: false, cellFormula: true,
  cellHTML: false, cellText: false, cellDates: true, sheetStubs: true,
  bookDeps: false, bookVBA: false, bookFiles: false, WTF: true };

function read(bytes, XLSX, extra) {
  try { return XLSX.read(bytes, { ...options, ...extra }); }
  catch (error) {
    if (/password|encrypt/i.test(error?.message || ""))
      fail("Password-protected workbooks cannot be imported. Save an unencrypted copy first.");
    malformed();
  }
}

export function openWorkbookData(input, filename, XLSX) {
  const bytes = validateWorkbookFile(input, filename);
  // `bookSheets:true` omits visibility metadata. An empty sheet selection reads
  // the workbook directory without parsing worksheet cells, including Hidden.
  const metadata = read(bytes, XLSX, { sheets: [] });
  const names = metadata?.SheetNames;
  if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== "string" || name.length > 128) ||
      new Set(names).size !== names.length) malformed();
  if (names.length > MAX_SHEETS) fail("The workbook has more than 32 worksheets. Save a copy containing only the GPA worksheet.");
  return {
    sheets: names.map((name, index) => ({ name, hidden: Boolean(metadata.Workbook?.Sheets?.[index]?.Hidden) })),
    readSheet(index) {
      if (!Number.isInteger(index) || index < 0 || index >= names.length) fail("Choose a worksheet from this workbook.");
      const workbook = read(bytes, XLSX, { sheets: names[index] });
      const sheet = workbook?.Sheets?.[names[index]];
      if (!sheet || sheet["!type"]) fail("Choose a worksheet containing the GPA table.");
      return worksheetData(sheet, XLSX);
    },
  };
}

export function worksheetData(sheet, XLSX) {
  let lastRow = -1, lastColumn = -1, hasFormulas = false;
  const cells = [];
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!") || !cell || (cell.t === "z" && !cell.f && !cell.F)) continue;
    if (!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) malformed();
    const { r, c } = XLSX.utils.decode_cell(address);
    if (r >= MAX_ROWS || c >= MAX_COLUMNS)
      fail("The worksheet exceeds 1,100 rows or 128 columns. Copy the GPA table to a smaller worksheet.");
    hasFormulas ||= Boolean(cell.f || cell.F);
    let value;
    if ((cell.f || cell.F) && (cell.v == null || cell.v === "" || cell.t === "z")) value = "[Formula result unavailable: recalculate and save]";
    else if (cell.t === "e") value = "[Excel cell error: correct and save]";
    else if (cell.t === "n" && typeof cell.v === "number" && Number.isFinite(cell.v)) value = String(cell.v);
    else if (["s", "str"].includes(cell.t) && typeof cell.v === "string") value = cell.v;
    else if (cell.v == null && !cell.f && !cell.F) value = "";
    else value = "[Unsupported value: use plain text or a number]";
    if (value.length > 4096) fail("A worksheet cell is too long. Import only the GPA table.");
    cells.push({ r, c, value });
    lastRow = Math.max(lastRow, r); lastColumn = Math.max(lastColumn, c);
  }
  if (!cells.some(cell => cell.value.trim())) fail("This worksheet is empty. Choose another worksheet.");
  const rows = Array.from({ length: lastRow + 1 }, () => Array(lastColumn + 1).fill(""));
  for (const { r, c, value } of cells) rows[r][c] = value;
  return { rows, columnCount: lastColumn + 1,
    warnings: hasFormulas ? ["Formula cells use results saved in the file. Recalculate and save in Excel first if the sheet changed."] : [] };
}
