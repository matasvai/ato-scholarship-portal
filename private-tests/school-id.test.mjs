import test from "node:test";
import assert from "node:assert/strict";
import { isSchoolIdHeader, parseSchoolId } from "../web/school-id.mjs";

test("student identifiers preserve all nine digits across exact spreadsheet formats", () => {
  for (const value of [900123456, "900123456", " 900123456\u00a0", "'900123456",
    "900123456.0", "900123456.000", "900,123,456", "900-123-456", "900 123 456",
    "900\u00a0123\u00a0456", "900\u202f123\u202f456", "9.00123456E+8", "9.00123456000e8",
    "900123456e0", "900123456000E-3"]) {
    assert.deepEqual(parseSchoolId(value), { value: "900123456", status: "valid" }, String(value));
  }
  for (const value of [undefined, null, "", " \t\n"]) {
    assert.deepEqual(parseSchoolId(value), { value: "", status: "missing" });
  }
});

test("student numbers called 900 numbers need not begin with 900", () => {
  for (const [input, expected] of [["901123456", "901123456"], ["876,543,210", "876543210"],
    ["123456789.0", "123456789"], ["1.23456789E8", "123456789"], ["012345678", "012345678"],
    ["012 345 678", "012345678"]]) {
    assert.deepEqual(parseSchoolId(input), { value: expected, status: "valid" });
  }
});

test("900 identifiers reject shortened scientific notation and malformed digits without rounding", () => {
  for (const value of ["9E8", "9.00123E8", "9.0012345E8", "90012345e1", "900123456.1",
    "9.001234561e8", "9001234567", "90012345", "0900123456", "-900123456",
    "+900123456", "90012 3456", "900,123 456", "900123456junk", "ID: 900123456",
    "900123456\u200b", "900\t123\t456", "=900123456", "NaN", Infinity, {}, "9e999999"]) {
    const parsed = parseSchoolId(value);
    assert.equal(parsed.status, "invalid", String(value));
    assert.equal(parsed.value, "", String(value));
  }
  assert.match(parseSchoolId("9.00123E8").reason, /rounded/);
});

test("900 roster headers accept student-ID wording but reject unrelated columns", () => {
  for (const header of ["900 Number", "900 #", "Student ID", "Student ID Number", "University ID", "School ID"])
    assert.equal(isSchoolIdHeader(header), true, header);
  for (const header of ["Badge Number", "Phone", "GPA", "Email", ""])
    assert.equal(isSchoolIdHeader(header), false, header);
});
