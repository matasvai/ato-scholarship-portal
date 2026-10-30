// Shared by the roster reader and the Chair's local GPA preview. Do not strip
// arbitrary non-digits or round a number: either operation can identify someone
// else. In particular, a shortened scientific display has already lost digits.
export function parseSchoolId(input) {
  let text = String(input ?? "").trim();
  if (!text) return { value: "", status: "missing" };
  const invalid = (reason = "Use all 9 digits of the student number.") =>
    ({ value: "", status: "invalid", reason });
  if (text.length > 80) return invalid();
  if (text.startsWith("'")) text = text.slice(1);

  // Spreadsheet text cells, exact integers, .0 numeric exports, and correctly
  // grouped display numbers preserve every digit without guessing.
  if (/^\d{9}(?:\.0+)?$/.test(text))
    return { value: text.split(".")[0], status: "valid" };
  if (/^\d{3}([,\- \u00a0\u2009\u202f])\d{3}\1\d{3}$/.test(text))
    return { value: text.replace(/[,\- \u00a0\u2009\u202f]/g, ""), status: "valid" };

  const scientific = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d{1,3})$/.exec(text);
  if (scientific) {
    const integer = scientific[1], fraction = scientific[2] || "";
    const digits = integer + fraction;
    const decimalAt = integer.length + Number(scientific[3]);
    if (decimalAt !== 9 || digits.length < 9)
      return invalid("Scientific notation may have rounded the student number. Export all 9 digits as plain text.");
    if (!/^0*$/.test(digits.slice(9))) return invalid();
    const value = digits.slice(0, 9);
    if (/^\d{9}$/.test(value)) return { value, status: "valid" };
  }
  return invalid();
}

export function isSchoolIdHeader(value) {
  const header = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return ["900", "900number", "900id", "student900number", "studentid", "studentnumber",
    "studentidnumber", "schoolid", "universityid", "universityidnumber", "idnumber"].includes(header);
}
