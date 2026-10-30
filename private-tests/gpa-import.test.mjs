import test from "node:test";
import assert from "node:assert/strict";
import { detectGpaMapping, gpaColumnChoices, mapGpaSheet, parseGpaCsv, readGpaSheet, reviewedTierAssignments, suggestTarget, tierForGpa } from "../web/gpa-import.mjs";
import { validateGpaImportMapping } from "../server/gpa-import-settings.mjs";

test("page-5 GPA boundaries determine tiers without storing a GPA", () => {
  for (const [gpa, tier] of [
    ["4.00", 1], ["3.50", 1], ["3.49", 2], ["3.00", 2],
    ["2.99", 3], ["2.70", 3], ["2.69", 4], ["2.60", 4],
    ["2.50", 4], ["2.49", 5], ["0", 5],
  ]) assert.equal(tierForGpa(gpa), tier, gpa);
  for (const invalid of ["", "4.01", "2,69", "NaN", "-1", "2.7abc"])
    assert.equal(tierForGpa(invalid), null, invalid);
});

test("CSV import parses sheet columns and matches 900 numbers before names", () => {
  const rows = parseGpaCsv('First Name,Last Name,900 Number,GPA\r\n"A, B",Member,900123456,2.60\r\nNew,Member,900999999,3.90\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tier, 4);
  assert.equal(rows[0].schoolId, "900123456");
  const targets = [
    { name: "A, B Member", schoolId: "900123456", email: "a@example.edu" },
    { name: "New Member", schoolId: "900999999", email: "new@example.edu" },
  ];
  assert.equal(suggestTarget(rows[0], targets), "a@example.edu");
  assert.equal(suggestTarget(rows[1], targets), "new@example.edu");
  assert.equal(suggestTarget({ ...rows[0], schoolId: "900000000" }, targets), "");
  assert.equal(suggestTarget({ ...rows[0], name: "Wrong Person" }, targets), "");
  assert.equal(suggestTarget({ ...rows[0], schoolId: "", email: "" }, targets), "a@example.edu");
});

test("CSV import refuses missing columns, malformed quotations, and invalid GPA", () => {
  assert.throws(() => parseGpaCsv("First Name,Last Name,900 Number\nA,B,900123456\n"), /GPA/);
  assert.throws(() => parseGpaCsv('First Name,Last Name,GPA\n"A,B,2.6\n'), /quotation/);
  const rows = parseGpaCsv("Name,GPA\nSample Member,4.5\n");
  assert.equal(rows[0].tier, null);
});

test("GPA rows normalize exact 900 formats and never fall back from invalid supplied IDs", () => {
  const targets = [{ name: "Sample Member", schoolId: "900123456", email: "sample@example.edu" }];
  for (const value of ['"900,123,456"', "900123456.0", "9.00123456E8"]) {
    const [row] = parseGpaCsv(`Name,GPA,University ID\nSample Member,2.60,${value}\n`);
    assert.equal(row.schoolId, "900123456");
    assert.equal(suggestTarget(row, targets), targets[0].email);
  }
  const [invalid] = parseGpaCsv("Name,GPA,900 Number,Email\nSample Member,2.60,9.00123E8,sample@example.edu\n");
  assert.match(invalid.schoolIdIssue, /rounded/);
  assert.equal(suggestTarget(invalid, targets), "");
  assert.equal(suggestTarget({ name: "Sample Member", email: targets[0].email, schoolId: "900123456junk" }, targets), "");
  assert.throws(() => reviewedTierAssignments([{ row: invalid, email: targets[0].email }], targets), /correct the 900/);
  // Defensive normalization also applies when targets are passed directly.
  assert.equal(suggestTarget({ name: "Sample Member", schoolId: "900123456.0" },
    [{ ...targets[0], schoolId: "9.00123456E8" }]), targets[0].email);
  assert.equal(suggestTarget({ name: "Sample Member", schoolId: "900123456" },
    [targets[0], { ...targets[0], schoolId: "900,123,456", email: "other@example.edu" }]), "");
});

test("duplicate source 900 numbers are flagged after normalization before any tier assignment", () => {
  const rows = parseGpaCsv('Name,GPA,900 Number\nSample Member,2.60,900123456\nOther Member,3.50,"900,123,456"\n');
  const targets = [{ name: "Sample Member", schoolId: "900123456", email: "sample@example.edu" },
    { name: "Other Member", schoolId: "900654321", email: "other@example.edu" }];
  assert.ok(rows.every((row) => /Duplicate 900/.test(row.schoolIdIssue)));
  assert.ok(rows.every((row) => suggestTarget(row, targets) === ""));
  assert.throws(() => reviewedTierAssignments(rows.map((row, index) => ({ row, email: targets[index].email })), targets), /correct the 900/);
});

test("malformed or duplicate roster identifiers block only their targets and cannot fall back to names", () => {
  const targets = [{ name: "Sample Member", email: "sample@example.edu", schoolId: "", schoolIdIssue: "Roster row 2: use all 9 digits." },
    { name: "Other Member", email: "other@example.edu", schoolId: "876543210" }];
  const [row, valid] = parseGpaCsv("Name,GPA,900 Number\nSample Member,2.60,\nOther Member,3.50,876543210\n");
  assert.equal(suggestTarget(row, targets), "");
  assert.equal(suggestTarget({ ...row, email: targets[0].email }, targets), "");
  assert.equal(suggestTarget({ ...row, schoolId: "123456789" }, [{ ...targets[0], schoolId: "123456789" }]), "");
  assert.equal(suggestTarget(valid, targets), targets[1].email);
  assert.throws(() => reviewedTierAssignments([{ row, email: targets[0].email }], targets), /connected roster/);
  assert.deepEqual(reviewedTierAssignments([{ row, email: "skip" }, { row: valid, email: targets[1].email }], targets),
    [{ email: targets[1].email, tier: 1 }]);
});

test("Chair-selected rows and reordered columns preserve actual sheet row numbers", () => {
  const sheet = readGpaSheet('Fall GPA sheet\n\nAverage,Family,University ID,Given,Contact\n2.69,Member,900123456,Sample,sample@example.edu\n\n3.50,Person,900999999,Other,other@example.edu\n');
  const mapping = { headerRow: 3, firstDataRow: 4, nameMode: "split",
    columns: { first: 3, last: 1, full: -1, schoolId: 2, gpa: 0, email: 4 } };
  assert.deepEqual(validateGpaImportMapping(mapping), mapping);
  const rows = mapGpaSheet(sheet, mapping);
  assert.deepEqual(rows.map((row) => [row.line, row.name, row.tier]),
    [[4, "Sample Member", 4], [6, "Other Person", 1]]);
  assert.equal(rows[0].email, "sample@example.edu");
  assert.throws(() => mapGpaSheet(sheet, { ...mapping, firstDataRow: 3 }), /after the header/);
  assert.throws(() => mapGpaSheet(sheet, { ...mapping, columns: { ...mapping.columns, gpa: 3 } }), /different column/);
});

test("no-header and full-name sheets can be mapped manually; ambiguous headers need a choice", () => {
  const sheet = readGpaSheet('900123456,"Sample Member",2.60\n');
  const mapping = { headerRow: 0, firstDataRow: 1, nameMode: "full",
    columns: { first: -1, last: -1, full: 1, schoolId: 0, gpa: 2, email: -1 } };
  assert.equal(mapGpaSheet(sheet, mapping)[0].tier, 4);
  assert.deepEqual(validateGpaImportMapping(mapping), mapping);
  assert.equal(detectGpaMapping(readGpaSheet("Name,GPA,GPA\nA,2.6,3.5")).columns.gpa, -1);
  assert.throws(() => validateGpaImportMapping({ ...mapping, gpa: "2.60" }), /valid sheet/);
  assert.throws(() => validateGpaImportMapping({ ...mapping, columns: { ...mapping.columns, schoolId: "900123456" } }), /valid sheet/);
});

test("column choices identify blank and duplicate headers by spreadsheet letter", () => {
  const sheet = readGpaSheet('Report title\nGPA,,GPA,900 Number\n2.69,Sample Member,3.50,900123456\n');
  assert.deepEqual(gpaColumnChoices(sheet, 2), [
    { value: 0, label: "Column A · GPA" },
    { value: 1, label: "Column B · No header" },
    { value: 2, label: "Column C · GPA" },
    { value: 3, label: "Column D · 900 Number" },
  ]);
  const mapping = { headerRow: 2, firstDataRow: 3, nameMode: "full",
    columns: { first: -1, last: -1, full: 1, schoolId: 3, gpa: 0, email: -1 } };
  assert.equal(mapGpaSheet(sheet, mapping)[0].tier, 4);
  assert.equal(mapGpaSheet(sheet, { ...mapping, columns: { ...mapping.columns, gpa: 2 } })[0].tier, 1);
  assert.ok(gpaColumnChoices(sheet, 0).every((choice) => choice.label.endsWith("No header")));
  assert.ok(!JSON.stringify(gpaColumnChoices(sheet, 0)).includes("900123456"), "headerless column labels must not use a member's source values");
  const wideSheet = readGpaSheet(Array.from({ length: 28 }, (_, index) => `Header ${index}`).join(","));
  assert.equal(gpaColumnChoices(wideSheet)[25].label, "Column Z · Header 25");
  assert.equal(gpaColumnChoices(wideSheet)[26].label, "Column AA · Header 26");
  assert.equal(gpaColumnChoices(wideSheet)[27].label, "Column AB · Header 27");
});

test("reviewed payload contains tiers only and blocks unresolved, invalid and duplicate selections", () => {
  const targets = [{ email: "sample@example.edu", membership: "active" },
    { email: "new@example.edu", membership: "new_member" }];
  const rows = [{ email: targets[0].email, row: { name: "Sample", gpa: "2.60", schoolId: "900123456", tier: 4 } },
    { email: targets[1].email, row: { name: "New", gpa: "", schoolId: "900999999", tier: null } }];
  assert.deepEqual(reviewedTierAssignments(rows, targets),
    [{ email: "sample@example.edu", tier: 4 }, { email: "new@example.edu", tier: 1 }]);
  assert.throws(() => reviewedTierAssignments([...rows, rows[0]], targets), /more than once/);
  assert.throws(() => reviewedTierAssignments([{ ...rows[0], email: "" }], targets), /unresolved/);
  assert.throws(() => reviewedTierAssignments([{ ...rows[0], row: { tier: null } }], targets), /invalid GPA/);
  assert.throws(() => reviewedTierAssignments([{ ...rows[0], email: "skip" }], targets), /at least one/);
});
