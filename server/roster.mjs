import { createHash } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { isSchoolIdHeader, parseSchoolId } from "../web/school-id.mjs";

const MAX_ROWS = 1000;
const MAX_BYTES = 256 * 1024;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const PUBLIC_CSV_MODE = "public_email_csv";
const ID_MODE = "service_account_ids";
const PUBLIC_ELIGIBILITY_VERSION = "active-or-new-member-v1";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const rosterError = (message) =>
  Object.assign(new Error(message), { status: 503 });

export function rosterStatus(env = process.env) {
  const requestedMode = String(env.ROSTER_SOURCE_MODE || "").trim();
  const mode = requestedMode || ID_MODE;
  const id = String(env.ROSTER_SHEET_ID || "").trim();
  const gidText = String(env.ROSTER_SHEET_GID ?? "").trim() || "0";
  const gid = Number(gidText);
  const validGid =
    /^\d{1,15}$/.test(gidText) &&
    Number.isSafeInteger(gid) &&
    gid >= 0;
  if (mode === PUBLIC_CSV_MODE) {
    return {
      mode,
      configured: /^[A-Za-z0-9_-]{20,150}$/.test(id) && validGid,
      required: true,
      maxAgeMs: 15 * 60 * 1000,
      source: digest(JSON.stringify([mode, id, validGid ? gid : gidText, PUBLIC_ELIGIBILITY_VERSION])),
    };
  }
  const range = String(env.ROSTER_SHEET_RANGE || "'Roster'!D1:E1002").trim();
  const email = String(env.ROSTER_SERVICE_ACCOUNT_EMAIL || "").trim();
  const key = String(env.ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(
    /\\n/g,
    "\n",
  );
  const required =
    env.ROSTER_REQUIRED === "true" ||
    Boolean(
      id || email || key || env.ROSTER_SHEET_RANGE || requestedMode || env.ROSTER_SHEET_GID,
    );
  const configured =
    mode === ID_MODE &&
    /^[A-Za-z0-9_-]{20,150}$/.test(id) &&
    /^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(email) &&
    key.includes("-----BEGIN PRIVATE KEY-----") &&
    range.length > 0 &&
    range.length <= 200;
  return {
    mode,
    configured,
    required,
    maxAgeMs: 15 * 60 * 1000,
    source: digest(JSON.stringify([id, range])),
  };
}

// The legacy service-account mode authorizes only explicit portal IDs. It
// never infers membership from names, phone numbers, or guessed email addresses.
export function parseRosterValues(values) {
  if (
    !Array.isArray(values) ||
    values.length < 2 ||
    values.length > MAX_ROWS + 1
  )
    throw rosterError("Roster must contain a header and 1–1000 member rows.");
  const headers = values[0].map((value) => String(value).trim().toLowerCase());
  if (
    headers.length !== 2 ||
    headers[0] !== "portal member id" ||
    headers[1] !== "active"
  )
    throw rosterError(
      "Roster range must contain exactly Portal Member ID and Active columns.",
    );
  const seen = new Set();
  const ids = [];
  for (const row of values.slice(1)) {
    if (!Array.isArray(row) || row.length > 2)
      throw rosterError("Roster contains an invalid row.");
    const id = String(row[0] ?? "").trim();
    const active = String(row[1] ?? "")
      .trim()
      .toLowerCase();
    if (!id && !active) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) || seen.has(id))
      throw rosterError(
        "Roster contains a missing, duplicate, or invalid Portal Member ID.",
      );
    if (!["true", "false", "active", "inactive"].includes(active))
      throw rosterError(
        "Every roster member needs an explicit TRUE or FALSE Active value.",
      );
    seen.add(id);
    if (active === "true" || active === "active") ids.push(id);
  }
  if (!seen.size)
    throw rosterError(
      "An empty roster cannot replace the current access list.",
    );
  return ids.sort();
}

function parseCSV(csv) {
  if (!csv) throw rosterError("The public roster export is empty.");
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const rows = [];
  let row = [];
  let field = "";
  let state = "start";
  let lastWasLineBreak = false;
  const finishField = () => {
    row.push(field);
    field = "";
    state = "start";
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    if (rows.length > MAX_ROWS + 1)
      throw rosterError("Roster exceeds the 1,000-member limit.");
    row = [];
    lastWasLineBreak = true;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === "quoted") {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') state = "afterQuote";
      else field += char;
      continue;
    }
    if (char === '"') {
      if (state !== "start") throw rosterError("Public roster CSV is malformed.");
      state = "quoted";
      lastWasLineBreak = false;
      continue;
    }
    if (char === "," || char === "\n" || char === "\r") {
      if (char === ",") {
        finishField();
        lastWasLineBreak = false;
      } else {
        if (char === "\r" && text[i + 1] === "\n") i++;
        finishRow();
      }
      continue;
    }
    if (state === "afterQuote")
      throw rosterError("Public roster CSV is malformed.");
    field += char;
    state = "unquoted";
    lastWasLineBreak = false;
  }
  if (state === "quoted") throw rosterError("Public roster CSV is malformed.");
  if (!lastWasLineBreak) finishRow();
  return rows;
}

const cleanCell = (value) => String(value ?? "").trim();

export function parsePublicRosterCsv(csv) {
  const rows = parseCSV(csv);
  const expectedHeaders = ["first name", "last name", "status", "student email"];
  if (
    rows.length < 2 ||
    rows[0].length !== expectedHeaders.length ||
    expectedHeaders.some(
      (header, index) => cleanCell(rows[0][index]).toLowerCase() !== header,
    )
  )
    throw rosterError("Public roster columns do not match.");

  const emails = new Set();
  const directory = [];
  let populatedRows = 0;
  for (const columns of rows.slice(1)) {
    if (columns.length > 4)
      throw rosterError("Public roster contains an invalid row.");
    const [first = "", last = "", status = "", email = ""] =
      columns.map(cleanCell);
    if (first || last || status || email) populatedRows++;
    const membership = status.toLowerCase().replace(/\s+/g, " ");
    if (!["active", "new mem.", "new member"].includes(membership)) continue;
    const normalizedEmail = email.toLowerCase();
    if (
      !first ||
      !last ||
      !/^[^\s@,<>"()]+@[^\s@,<>"()]+\.[^\s@,<>"()]+$/.test(normalizedEmail) ||
      normalizedEmail.length > 254 ||
      /[\u0000-\u001f\u007f]/.test(`${first}${last}`) ||
      first.length > 100 ||
      last.length > 100
    )
      throw rosterError(
        "An eligible roster member is missing a valid name or email.",
      );
    if (emails.has(normalizedEmail))
      throw rosterError("Public roster contains a duplicate eligible email.");
    emails.add(normalizedEmail);
    directory.push({
      name: `${first.replace(/\s+/g, " ")} ${last.replace(/\s+/g, " ")}`,
      email: normalizedEmail,
      membership: membership === "active" ? "active" : "new_member",
    });
  }
  if (!populatedRows)
    throw rosterError(
      "An empty roster cannot replace the current access list.",
    );
  directory.sort((a, b) => a.email.localeCompare(b.email));
  return { emails: [...emails].sort(), directory };
}

// Only the Chair's import preview requests column E. These identifiers are
// returned transiently and are never included in the stored roster snapshot.
export function parseRosterImportIdentifiers(csv) {
  const rows = parseCSV(csv);
  if (rows.length < 2 || rows[0].length !== 5 ||
    ["first name", "last name", "status", "student email"].some((header, index) =>
      cleanCell(rows[0][index < 3 ? index : 4]).toLowerCase() !== header))
    throw rosterError("Roster import columns do not match the connected sheet.");
  if (!isSchoolIdHeader(rows[0][3]))
    throw rosterError("Roster column E must be labeled 900 Number or Student ID. Check the connected sheet before importing tiers.");
  const seenEmails = new Set(), seenNumbers = new Map(), directory = [];
  for (const [index, cells] of rows.slice(1).entries()) {
    if (cells.length > 5) throw rosterError("Roster import contains an invalid row.");
    const [first = "", last = "", status = "", rawSchoolId = "", email = ""] = cells.map(cleanCell);
    const membership = status.toLowerCase().replace(/\s+/g, " ");
    if (!["active", "new mem.", "new member"].includes(membership)) continue;
    const normalizedEmail = email.toLowerCase();
    const parsedId = parseSchoolId(rawSchoolId);
    const schoolId = parsedId.value;
    if (!first || !last || !/^[^\s@,<>"()]+@[^\s@,<>"()]+\.[^\s@,<>"()]+$/.test(normalizedEmail) ||
      normalizedEmail.length > 254 || first.length > 100 || last.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(`${first}${last}`) ||
      seenEmails.has(normalizedEmail))
      throw rosterError("Roster import has a missing or duplicate eligible identity.");
    seenEmails.add(normalizedEmail);
    const entry = { name: `${first.replace(/\s+/g, " ")} ${last.replace(/\s+/g, " ")}`,
      email: normalizedEmail,
      membership: membership === "active" ? "active" : "new_member",
      schoolId,
      ...(parsedId.status === "invalid" ? { schoolIdIssue: `Roster row ${index + 2}, column E: ${parsedId.reason}` } : {}),
    };
    if (schoolId && seenNumbers.has(schoolId)) {
      const first = seenNumbers.get(schoolId);
      const issue = `Roster rows ${first.row} and ${index + 2}, column E have a duplicate student number. Correct those roster rows before importing their tiers.`;
      first.entry.schoolId = entry.schoolId = "";
      first.entry.schoolIdIssue = entry.schoolIdIssue = issue;
    } else if (schoolId) seenNumbers.set(schoolId, { row: index + 2, entry });
    directory.push(entry);
  }
  return directory.sort((a, b) => a.email.localeCompare(b.email));
}

async function readPublicCSV(response, budget) {
  if (!response.ok || !response.body)
    throw rosterError("The public Google roster could not be read.");
  const reader = response.body.getReader();
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.remaining -= value.byteLength;
      if (budget.remaining < 0)
        throw rosterError("Roster response is too large.");
      chunks.push(Buffer.from(value));
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function fetchPublicCSV(id, gid, fetchImpl, signal) {
  // This projection reads A, B, C, and I from one consistent sheet response.
  // The unselected D–H columns are never downloaded by the portal.
  const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?gid=${gid}&tqx=out%3Acsv&tq=select%20A%2CB%2CC%2CI`;
  return readPublicCSV(
    await fetchImpl(url, { redirect: "error", signal }),
    { remaining: MAX_BYTES },
  );
}

export async function fetchRosterImportIdentifiers({ env = process.env, fetchImpl = fetch } = {}) {
  const status = rosterStatus(env);
  if (!status.configured || status.mode !== PUBLIC_CSV_MODE)
    throw rosterError("A connected name-and-email roster is required for tier import.");
  const id = String(env.ROSTER_SHEET_ID).trim();
  const gid = Number(String(env.ROSTER_SHEET_GID ?? "").trim() || "0");
  const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?gid=${gid}&tqx=out%3Acsv&tq=select%20A%2CB%2CC%2CE%2CI`;
  const csv = await readPublicCSV(await fetchImpl(url, {
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }), { remaining: MAX_BYTES });
  return parseRosterImportIdentifiers(csv);
}

async function readJSON(response) {
  if (!response.ok || !response.body)
    throw rosterError(
      "Google Sheets could not be read. Check the service account and sheet sharing.",
    );
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES)
        throw rosterError(
          "Roster response is too large. Narrow the configured range.",
        );
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function fetchRosterSnapshot({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const status = rosterStatus(env);
  if (!status.configured)
    throw rosterError(
      "Roster sync is required but its Google Sheets settings are incomplete.",
    );
  const startedAt = now();
  const signal = AbortSignal.timeout(15_000);
  try {
    if (status.mode === PUBLIC_CSV_MODE) {
      const id = String(env.ROSTER_SHEET_ID).trim();
      const gid = Number(String(env.ROSTER_SHEET_GID ?? "").trim() || "0");
      const csv = await fetchPublicCSV(id, gid, fetchImpl, signal);
      return {
        ...parsePublicRosterCsv(csv),
        fetchedAt: new Date(startedAt).toISOString(),
        revision: digest(csv),
        source: status.source,
      };
    }
    const seconds = Math.floor(startedAt / 1000);
    const key = await importPKCS8(
      env.ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n"),
      "RS256",
    );
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(env.ROSTER_SERVICE_ACCOUNT_EMAIL.trim())
      .setAudience(TOKEN_URL)
      .setIssuedAt(seconds)
      .setExpirationTime(seconds + 300)
      .sign(key);
    const token = await readJSON(
      await fetchImpl(TOKEN_URL, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      }),
    );
    if (
      typeof token.access_token !== "string" ||
      !token.access_token ||
      token.access_token.length > 8192
    )
      throw rosterError("Google did not return a usable roster access token.");
    const range = String(env.ROSTER_SHEET_RANGE || "'Roster'!D1:E1002").trim();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.ROSTER_SHEET_ID.trim())}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
    const data = await readJSON(
      await fetchImpl(url, {
        redirect: "error",
        signal,
        headers: { Authorization: `Bearer ${token.access_token}` },
      }),
    );
    const ids = parseRosterValues(data.values);
    return {
      ids,
      fetchedAt: new Date(startedAt).toISOString(),
      revision: digest(JSON.stringify(data.values)),
      source: status.source,
    };
  } catch (error) {
    if (error.status === 503) throw error;
    throw rosterError(
      "Roster sync failed. Access stays restricted until a successful refresh.",
    );
  }
}
