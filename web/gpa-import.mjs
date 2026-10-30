// This module runs in the Chair's browser. GPA and student numbers never enter
// the tier-assignment API; only roster email and the resulting tier do.
import { isSchoolIdHeader, parseSchoolId } from "./school-id.mjs";
const MAX_ROWS = 1000;
const MAX_COLUMNS = 128;
const clean = (value) => String(value ?? "").trim();
const headerKey = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
export const nameKey = (value) => clean(value).normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

function csvRows(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 1_000_000)
    throw Error("Choose a nonempty CSV file under 1 MB.");
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [], field = "", quoted = false, closedQuote = false;
  const finishField = () => { row.push(field); field = ""; closedQuote = false; };
  const finishRow = () => {
    finishField();
    if (row.length > MAX_COLUMNS) throw Error("The CSV exceeds 128 columns.");
    rows.push(row);
    if (rows.length > MAX_ROWS + 100) throw Error("The CSV exceeds 1,100 sheet rows.");
    row = [];
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else field += char;
    } else if (char === '"') {
      if (field || closedQuote) throw Error("The CSV has malformed quotation marks.");
      quoted = true;
    } else if (char === ",") finishField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      finishRow();
    } else {
      if (closedQuote) throw Error("The CSV has malformed quotation marks.");
      field += char;
    }
  }
  if (quoted) throw Error("The CSV has an unclosed quotation mark.");
  if (row.length || field || closedQuote) finishRow();
  return rows;
}

function column(headers, aliases) {
  const found = headers.flatMap((header, index) => aliases.includes(header) ? [index] : []);
  if (found.length > 1) return -1;
  return found[0] ?? -1;
}

export function tierForGpa(raw) {
  const value = clean(raw);
  if (!/^(?:[0-3](?:\.\d{1,4})?|4(?:\.0{1,4})?)$/.test(value)) return null;
  const gpa = Number(value);
  if (gpa >= 3.5) return 1;
  if (gpa >= 3.0) return 2;
  if (gpa >= 2.7) return 3;
  if (gpa >= 2.5) return 4;
  return 5;
}

export function readGpaSheet(text) {
  const rows = csvRows(text);
  if (!rows.some((row) => row.some((cell) => clean(cell)))) throw Error("The CSV is empty.");
  return { rows, columnCount: Math.max(...rows.map((row) => row.length)) };
}

// Labels describe the sheet layout only; source values stay in the local preview.
export function gpaColumnChoices(sheet, headerRow = 1) {
  const headers = headerRow > 0 ? sheet.rows[headerRow - 1] || [] : [];
  return Array.from({ length: sheet.columnCount }, (_, index) => {
    let letter = "";
    for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
      letter = String.fromCharCode(65 + (value - 1) % 26) + letter;
    return { value: index, label: `Column ${letter} · ${clean(headers[index]).slice(0, 80) || "No header"}` };
  });
}

export function detectGpaMapping(sheet, headerRow = 1) {
  const headers = (sheet.rows[headerRow - 1] || []).map(headerKey);
  const columns = {
    first: column(headers, ["firstname", "first"]),
    last: column(headers, ["lastname", "last"]),
    full: column(headers, ["name", "fullname", "membername", "studentname"]),
    gpa: column(headers, ["gpa", "previoussemestergpa", "semestergpa"]),
    schoolId: column(headers, headers.filter(isSchoolIdHeader)),
    email: column(headers, ["email", "studentemail", "schoolemail"]),
  };
  return { headerRow, firstDataRow: headerRow + 1,
    nameMode: columns.full >= 0 && (columns.first < 0 || columns.last < 0) ? "full" : "split", columns };
}

export function mapGpaSheet(sheet, mapping) {
  const { headerRow, firstDataRow, nameMode, columns } = mapping || {};
  if (!Number.isInteger(headerRow) || headerRow < 0 || headerRow > sheet.rows.length ||
    !Number.isInteger(firstDataRow) || firstDataRow < 1 || firstDataRow > sheet.rows.length ||
    (headerRow && firstDataRow <= headerRow) || !["split", "full"].includes(nameMode) || !columns)
    throw Error("Choose the header row and the first member row. Member rows must begin after the header.");
  const required = nameMode === "full" ? ["full", "gpa"] : ["first", "last", "gpa"];
  const used = [...required, ...["schoolId", "email"].filter((key) => columns[key] >= 0)];
  if (used.some((key) => !Number.isInteger(columns[key]) || columns[key] < 0 || columns[key] >= sheet.columnCount))
    throw Error("Choose a column for GPA and each name field. The 900 number and email are optional.");
  if (new Set(used.map((key) => columns[key])).size !== used.length)
    throw Error("Each field must use a different column.");
  const result = sheet.rows.slice(firstDataRow - 1).flatMap((cells, index) => {
    if (!cells.some((cell) => clean(cell))) return [];
    const name = nameMode === "full" ? clean(cells[columns.full]) :
      `${clean(cells[columns.first])} ${clean(cells[columns.last])}`.trim();
    const rawSchoolId = columns.schoolId < 0 ? "" : clean(cells[columns.schoolId]);
    const parsedId = parseSchoolId(rawSchoolId);
    return {
      line: index + firstDataRow,
      name,
      schoolId: parsedId.value,
      ...(parsedId.status === "invalid" ? { schoolIdIssue: parsedId.reason } : {}),
      email: columns.email < 0 ? "" : clean(cells[columns.email]).toLowerCase(),
      gpa: clean(cells[columns.gpa]),
      tier: tierForGpa(cells[columns.gpa]),
    };
  });
  if (!result.length) throw Error("No member rows were found with this layout.");
  if (result.length > MAX_ROWS) throw Error("The import exceeds 1,000 members.");
  const seenNumbers = new Map();
  for (const row of result) {
    if (!row.schoolId) continue;
    if (seenNumbers.has(row.schoolId)) {
      const first = seenNumbers.get(row.schoolId);
      first.schoolIdIssue = row.schoolIdIssue = `Duplicate 900 number in sheet rows ${first.line} and ${row.line}. Correct the sheet or skip the duplicate rows.`;
    } else seenNumbers.set(row.schoolId, row);
  }
  return result;
}

export function parseGpaCsv(text, mapping) {
  const sheet = readGpaSheet(text);
  return mapGpaSheet(sheet, mapping || detectGpaMapping(sheet));
}

export function reviewedTierAssignments(rows, targets) {
  const byEmail = new Map(targets.map((target) => [target.email, target]));
  const seen = new Set(), assignments = [];
  for (const item of rows) {
    if (item.email === "skip") continue;
    if (item.row.schoolIdIssue || parseSchoolId(item.row.schoolId).status === "invalid")
      throw Error(`Row ${item.row.line || ""}: correct the 900 number in the sheet, or skip that row.`);
    const target = byEmail.get(item.email);
    if (!target) throw Error("Choose a member or skip each unresolved row.");
    if (target.schoolIdIssue)
      throw Error("Correct the selected member's student number in the connected roster, or skip that row.");
    if (seen.has(item.email)) throw Error("A member is selected more than once. Skip or correct the duplicate row.");
    seen.add(item.email);
    const tier = target.membership === "new_member" ? 1 : item.row.tier;
    if (!tier) throw Error("Correct the invalid GPA in the sheet, or skip that row.");
    assignments.push({ email: target.email, tier });
  }
  if (!assignments.length) throw Error("Select at least one member to apply tiers.");
  return assignments;
}

export function suggestTarget(row, targets) {
  const eligibleTargets = targets.filter((target) => !target.schoolIdIssue && parseSchoolId(target.schoolId).status !== "invalid");
  const schoolId = parseSchoolId(row.schoolId);
  if (row.schoolIdIssue || schoolId.status === "invalid") return "";
  if (schoolId.status === "valid") {
    const byNumber = eligibleTargets.filter((target) => parseSchoolId(target.schoolId).value === schoolId.value);
    if (byNumber.length === 1 && nameKey(byNumber[0].name) === nameKey(row.name))
      return byNumber[0].email;
    return "";
  }
  if (row.email) {
    const byEmail = eligibleTargets.filter((target) => target.email.toLowerCase() === row.email);
    if (byEmail.length === 1 && nameKey(byEmail[0].name) === nameKey(row.name))
      return byEmail[0].email;
    return "";
  }
  const byName = eligibleTargets.filter((target) => nameKey(target.name) === nameKey(row.name));
  return byName.length === 1 ? byName[0].email : "";
}
