import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, jwtVerify } from "jose";
import {
  fetchRosterSnapshot,
  fetchRosterImportIdentifiers,
  parsePublicRosterCsv,
  parseRosterImportIdentifiers,
  parseRosterValues,
  rosterStatus,
} from "../server/roster.mjs";

const header = ["Portal Member ID", "Active"];

test("roster membership requires explicit IDs and active values, never inferred emails", () => {
  assert.deepEqual(
    parseRosterValues([
      header,
      ["alex", true],
      ["former", false],
      ["new_member", "active"],
    ]),
    ["alex", "new_member"],
  );
  assert.deepEqual(parseRosterValues([header, ["alex", false]]), []);
  for (const rows of [
    [header],
    [header, ["", ""]],
    [header, ["alex", ""]],
    [header, ["alex", true], ["alex", false]],
    [header, ["name@my.fit.edu", true]],
    [
      ["First Name", "Last Name"],
      ["Matas", "Vaitkevicius"],
    ],
    [header, ["alex", true], ["", true]],
    [header, ["alex", "maybe"]],
    [header, ...Array.from({ length: 1001 }, (_, i) => [`member${i}`, true])],
  ])
    assert.throws(() => parseRosterValues(rows));
});

test("partial roster configuration requires sync and cannot silently disable eligibility", () => {
  assert.equal(rosterStatus({}).required, false);
  assert.equal(rosterStatus({}).mode, "service_account_ids");
  for (const env of [
    { ROSTER_REQUIRED: "true" },
    { ROSTER_SHEET_ID: "partial" },
    { ROSTER_SERVICE_ACCOUNT_EMAIL: "incomplete" },
  ]) {
    assert.equal(rosterStatus(env).required, true);
    assert.equal(rosterStatus(env).configured, false);
  }
  assert.notEqual(
    rosterStatus({ ROSTER_SHEET_ID: "first" }).source,
    rosterStatus({ ROSTER_SHEET_ID: "second" }).source,
  );
});

const publicEnv = {
  ROSTER_SOURCE_MODE: "public_email_csv",
  ROSTER_SHEET_ID: "a".repeat(44),
  ROSTER_SHEET_GID: "0",
};
const publicCsv =
  '\ufeffFirst Name,Last Name,Status,Student Email\r\n"Noah, Jr.",Knickerbocker,Active,NOAH@my.fit.edu\r\nFormer,Member,Alumni,former@example.org\r\nMatas,Vaitkevicius,ACTIVE,matas@my.fit.edu\r\nNew,Member,New Mem.,new@my.fit.edu\r\n,,,\r\n';

test("public roster mode needs only a valid sheet ID and numeric GID", () => {
  const status = rosterStatus(publicEnv);
  assert.equal(status.mode, "public_email_csv");
  assert.equal(status.required, true);
  assert.equal(status.configured, true);
  assert.notEqual(
    status.source,
    rosterStatus({ ...publicEnv, ROSTER_SHEET_GID: "1" }).source,
  );
  for (const env of [
    { ...publicEnv, ROSTER_SHEET_ID: "short" },
    { ...publicEnv, ROSTER_SHEET_GID: "-1" },
    { ...publicEnv, ROSTER_SHEET_GID: "1.2" },
    { ...publicEnv, ROSTER_SHEET_GID: "not-a-number" },
    { ...publicEnv, ROSTER_SOURCE_MODE: "unknown" },
  ]) {
    assert.equal(rosterStatus(env).required, true);
    assert.equal(rosterStatus(env).configured, false);
  }
  assert.equal(
    rosterStatus({ ...publicEnv, ROSTER_SHEET_GID: "" }).source,
    status.source,
  );
});

test("projected public CSV includes active and new members only", () => {
  const parsed = parsePublicRosterCsv(publicCsv);
  assert.deepEqual(parsed, {
    emails: ["matas@my.fit.edu", "new@my.fit.edu", "noah@my.fit.edu"],
    directory: [
      { name: "Matas Vaitkevicius", email: "matas@my.fit.edu", membership: "active" },
      { name: "New Member", email: "new@my.fit.edu", membership: "new_member" },
      { name: "Noah, Jr. Knickerbocker", email: "noah@my.fit.edu", membership: "active" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(parsed), /Former|former@example/);
  assert.equal(
    parsePublicRosterCsv("First Name,Last Name,Status,Student Email\nNew,Member,NEW MEMBER,new@my.fit.edu\n").directory[0].membership,
    "new_member",
  );
  assert.deepEqual(
    parsePublicRosterCsv(
      "First Name,Last Name,Status,Student Email\nFormer,Member,Alumni,former@example.org\n",
    ),
    { emails: [], directory: [] },
  );
});

test("Chair-only identifier projection reads column E transiently", async () => {
  const csv = "First Name,Last Name,Status,900 Number,Student Email\n" +
    "A,Member,Active,900123456,a@example.edu\n" +
    "New,Member,New Mem.,900654321,new@example.edu\n" +
    "Former,Member,Alumni,900111111,former@example.edu\n";
  const rows = parseRosterImportIdentifiers(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].schoolId, "900123456");
  assert.doesNotMatch(JSON.stringify(rows), /former|900111111/i);
  let calls = 0;
  const fetched = await fetchRosterImportIdentifiers({
    env: publicEnv,
    fetchImpl: async (url, options) => {
      calls++;
      assert.match(url, /tq=select%20A%2CB%2CC%2CE%2CI$/);
      assert.equal(options.redirect, "error");
      return new Response(csv);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(fetched, rows);
  const duplicate = parseRosterImportIdentifiers(csv.replace("900654321", "900123456"));
  assert.ok(duplicate.every((entry) => entry.schoolId === "" && /duplicate/.test(entry.schoolIdIssue)));
});

test("public CSV rejects ambiguous active rows, malformed exports, and excess rows", () => {
  const csvHeader = "First Name,Last Name,Status,Student Email\n";
  const invalid = [
    csvHeader + "A,B,Active,a@example.org\nA,B,Active,A@example.org\n",
    csvHeader + "A,B,Active,a@example.org\nC,D,New Mem.,A@example.org\n",
    csvHeader + "A,B,Active,\n",
    csvHeader + "A,B,New Mem.,\n",
    csvHeader + ",B,Active,a@example.org\n",
    csvHeader + "A,B,Active,not-an-email\n",
    csvHeader + "A,B,Active,a@example.org,unexpected\n",
    csvHeader + '"unterminated,B,Active,a@example.org\n',
    csvHeader + 'A"bad,B,Active,a@example.org\n',
    "Wrong,Last Name,Status,Student Email\nA,B,Active,a@example.org\n",
    csvHeader,
    csvHeader + "A,B,Inactive,\n".repeat(1001),
  ];
  for (const csv of invalid)
    assert.throws(() => parsePublicRosterCsv(csv), (error) => error.status === 503);
});

test("roster 900 projection validates its source column and compares canonical identifiers", () => {
  const header = "First Name,Last Name,Status,900 Number,Student Email\n";
  const csv = header + 'Sample,Member,Active,"900,123,456",sample@example.edu\n' +
    "New,Member,New Mem.,,new@example.edu\n";
  const result = parseRosterImportIdentifiers(csv);
  assert.equal(result.find((row) => row.email === "sample@example.edu").schoolId, "900123456");
  assert.equal(result.find((row) => row.email === "new@example.edu").schoolId, "");
  assert.throws(() => parseRosterImportIdentifiers(csv.replace("900 Number", "Phone")), /column E must be labeled/);
  const invalid = parseRosterImportIdentifiers(header + "Sample,Member,Active,9.00123E8,sample@example.edu\n");
  assert.equal(invalid[0].schoolId, "");
  assert.match(invalid[0].schoolIdIssue, /row 2, column E.*rounded/);
  assert.ok(!invalid[0].schoolIdIssue.includes("9.00123"));
  const duplicate = parseRosterImportIdentifiers(csv + "Other,Member,Active,9.00123456E8,other@example.edu\n");
  for (const entry of duplicate.filter((entry) => entry.email !== "new@example.edu")) {
    assert.equal(entry.schoolId, "");
    assert.match(entry.schoolIdIssue, /rows 2 and 4, column E.*duplicate student/);
  }
  assert.equal(duplicate.find((entry) => entry.email === "new@example.edu").schoolIdIssue, undefined);
});

test("one incomplete roster student number does not prevent valid members from being imported", () => {
  const csv = "First Name,Last Name,Status,Student Id,Student Email\n" +
    "Valid,Member,Active,876543210,valid@example.edu\n" +
    "Incomplete,Member,Active,87654321,incomplete@example.edu\n" +
    "Formatted,Member,New Mem.,1.23456789E8,formatted@example.edu\n";
  const rows = parseRosterImportIdentifiers(csv);
  assert.equal(rows.find((row) => row.email === "valid@example.edu").schoolId, "876543210");
  assert.equal(rows.find((row) => row.email === "formatted@example.edu").schoolId, "123456789");
  const incomplete = rows.find((row) => row.email === "incomplete@example.edu");
  assert.equal(incomplete.schoolId, "");
  assert.match(incomplete.schoolIdIssue, /row 3, column E.*9 digits/);
  assert.ok(!JSON.stringify(rows).includes("87654321\""));
});

test("public reader fetches only one A,B,C,I projection without credentials", async () => {
  const expected =
    "https://docs.google.com/spreadsheets/d/" +
    publicEnv.ROSTER_SHEET_ID +
    "/gviz/tq?gid=0&tqx=out%3Acsv&tq=select%20A%2CB%2CC%2CI";
  const now = Date.now();
  let calls = 0;
  const snapshot = await fetchRosterSnapshot({
    env: publicEnv,
    now: () => now,
    fetchImpl: async (url, options) => {
      assert.equal(url, expected);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers, undefined);
      calls++;
      return new Response(publicCsv, {
        headers: { "Content-Type": "text/csv" },
      });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(snapshot.emails, ["matas@my.fit.edu", "new@my.fit.edu", "noah@my.fit.edu"]);
  assert.equal(snapshot.fetchedAt, new Date(now).toISOString());
  assert.equal(snapshot.source, rosterStatus(publicEnv).source);
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(snapshot), /former@example|Former/);
});

test("public reader rejects provider errors, redirects, and oversized downloads", async () => {
  await assert.rejects(
    fetchRosterSnapshot({
      env: publicEnv,
      fetchImpl: async () => new Response(null, { status: 307, headers: { Location: "https://example.com" } }),
    }),
    (error) => error.status === 503,
  );
  await assert.rejects(
    fetchRosterSnapshot({
      env: publicEnv,
      fetchImpl: async () => new Response("private-provider-text", { status: 403 }),
    }),
    (error) => error.status === 503 && !error.message.includes("private-provider-text"),
  );
  await assert.rejects(
    fetchRosterSnapshot({
      env: publicEnv,
      fetchImpl: async () => new Response(
        "First Name,Last Name,Status,Student Email\n" + "x".repeat(256 * 1024),
      ),
    }),
    /too large/,
  );
});

test("Sheets reader uses a scoped service-account JWT and returns no credentials or contacts", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const env = {
    ROSTER_SHEET_ID: "a".repeat(44),
    ROSTER_SERVICE_ACCOUNT_EMAIL: "portal@chapter.iam.gserviceaccount.com",
    ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY: await exportPKCS8(privateKey),
  };
  let calls = 0;
  const now = Date.now();
  const snapshot = await fetchRosterSnapshot({
    env,
    now: () => now,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      if (calls === 1) {
        assert.equal(url, "https://oauth2.googleapis.com/token");
        const { payload } = await jwtVerify(
          options.body.get("assertion"),
          publicKey,
          { audience: url, issuer: env.ROSTER_SERVICE_ACCOUNT_EMAIL },
        );
        assert.equal(
          payload.scope,
          "https://www.googleapis.com/auth/spreadsheets.readonly",
        );
        assert.equal(payload.sub, undefined);
        return Response.json({ access_token: "fixture-token" });
      }
      assert.equal(new URL(url).origin, "https://sheets.googleapis.com");
      assert.equal(options.headers.Authorization, "Bearer fixture-token");
      return Response.json({
        values: [header, ["alex", true], ["former", false]],
      });
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(snapshot.ids, ["alex"]);
  assert.equal(snapshot.fetchedAt, new Date(now).toISOString());
  assert.equal(snapshot.source, rosterStatus(env).source);
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /fixture-token|PRIVATE KEY|former/,
  );
  await assert.rejects(
    fetchRosterSnapshot({
      env,
      fetchImpl: async () => new Response("provider-secret", { status: 403 }),
    }),
    (error) =>
      error.status === 503 && !error.message.includes("provider-secret"),
  );
  await assert.rejects(
    fetchRosterSnapshot({
      env,
      fetchImpl: async () => new Response("a".repeat(256 * 1024 + 1)),
    }),
    /too large/,
  );
});
