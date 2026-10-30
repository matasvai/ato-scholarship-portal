// This worker is created only when the Chair chooses an Excel file. Vendor code
// is same-origin and receives no credentials. Terminating it releases the file.
importScripts("/vendor/xlsx-0.20.3.full.min.js");
const helpers = import("./gpa-workbook-data.mjs");
let workbook;
self.onmessage = async event => {
  const { id, action, buffer, filename, index } = event.data || {};
  try {
    const { openWorkbookData } = await helpers;
    if (action === "open") {
      workbook = openWorkbookData(buffer, filename, self.XLSX);
      self.postMessage({ id, value: { sheets: workbook.sheets } });
    } else if (action === "sheet" && workbook) {
      self.postMessage({ id, value: workbook.readSheet(index) });
    } else throw Error("Choose an Excel workbook before selecting a worksheet.");
  } catch (error) {
    self.postMessage({ id, error: error.message || "The Excel workbook could not be read." });
  }
};
