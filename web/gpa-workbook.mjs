import { MAX_WORKBOOK_BYTES } from "./gpa-workbook-data.mjs";

export async function openGpaWorkbook(file, { signal } = {}) {
  if (!file || !/\.(xlsx|xls|xlx)$/i.test(file.name || ""))
    throw Error("Choose an Excel .xlsx or .xls file, or a CSV export.");
  if (!file.size || file.size > MAX_WORKBOOK_BYTES) throw Error("Choose a nonempty Excel file under 5 MB.");
  const aborted = () => new DOMException("Import closed.", "AbortError");
  if (signal?.aborted) throw aborted();
  const buffer = await file.arrayBuffer();
  if (signal?.aborted) throw aborted();
  if (typeof Worker === "undefined") throw Error("This browser cannot read Excel files locally. Export the worksheet as CSV and try again.");
  const worker = new Worker(new URL("./gpa-workbook-worker.js", import.meta.url));
  const pending = new Map();
  let nextId = 0, closed = false;
  const close = (reason = aborted()) => {
    if (closed) return;
    closed = true;
    worker.terminate();
    signal?.removeEventListener("abort", onAbort);
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(reason); }
    pending.clear();
  };
  const onAbort = () => close();
  signal?.addEventListener("abort", onAbort, { once: true });
  worker.onmessage = event => {
    const item = pending.get(event.data?.id);
    if (!item) return;
    pending.delete(event.data.id); clearTimeout(item.timer);
    if (event.data.error) item.reject(Error(event.data.error)); else item.resolve(event.data.value);
  };
  worker.onerror = event => {
    event.preventDefault();
    close(Error("The Excel reader could not start. Reload the portal, or export the worksheet as CSV."));
  };
  worker.onmessageerror = () => close(Error("The Excel result could not be read. Export the worksheet as CSV."));
  function request(message, transfer = []) {
    if (closed) return Promise.reject(aborted());
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => close(Error("Reading Excel took too long. Save a smaller workbook or export CSV.")), 15_000);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, ...message }, transfer); }
      catch { close(Error("The workbook could not be opened. Export the worksheet as CSV.")); }
    });
  }
  try {
    const { sheets } = await request({ action: "open", buffer, filename: file.name }, [buffer]);
    return { sheets, readSheet: index => request({ action: "sheet", index }), close: () => close() };
  } catch (error) { close(); throw error; }
}
