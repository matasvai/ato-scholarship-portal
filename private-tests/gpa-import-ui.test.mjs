import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as gpaHelpers from '../web/gpa-import.mjs';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function openTierImport()');
const functionSource = source.slice(start, source.indexOf('\nasync function auditPage()', start))
  .replace('import("/gpa-import.mjs")', 'Promise.resolve(gpaHelpers)')
  .replace('import("/gpa-workbook.mjs")', 'Promise.resolve(workbookHelpers)');

function fixture(workbookHelpers = {}) {
  const controls = new Map(), dialogs = [], requests = [], closeCallbacks = [];
  const $ = (selector) => {
    if (!controls.has(selector)) controls.set(selector, {
      value: '', textContent: '', innerHTML: '', hidden: false, checked: false,
      disabled: false, replaceChildren() { this.innerHTML = ''; }, focus() {},
    });
    return controls.get(selector);
  };
  const context = {
    user: { id: 'fictional-chair', role: 'chair' }, sessionEpoch: 1, $, gpaHelpers, workbookHelpers, AbortController,
    modal: { open: true, classList: { add() {}, remove() {} },
      addEventListener(type, callback) { if (type === 'close') closeCallbacks.push(callback); },
      close() { this.open = false; closeCallbacks.forEach(callback => callback()); } },
    api: async (path, options) => {
      requests.push({ path, options });
      return { targets: [{ email: 'sample@example.edu', schoolId: '900123456', name: 'Sample Member', currentTier: 1 }], snapshot: 'fictional' };
    },
    openModal: (title, subtitle, body) => dialogs.push(body),
    loading: () => 'Loading', esc: String, formError: message => { $('#form-error').textContent = message; },
    toast() {}, rosterPage() {},
  };
  return { $, context, dialogs, requests, open: runInNewContext(`(${functionSource})`, context) };
}

test('Chair can choose GPA and 900 columns, and changing either requires a fresh reviewed preview', async () => {
  const f = fixture();
  await f.open();
  assert.ok(f.dialogs.at(-1).indexOf('id="gpa-column-gpa"') < f.dialogs.at(-1).indexOf('id="gpa-header-row"'));
  assert.match(f.dialogs.at(-1), /<label for="gpa-column-schoolId">900 number column<\/label>/);
  f.$('#gpa-csv').files = [{ size: 100, text: async () => 'Name,GPA,GPA,900 Number\nSample Member,2.60,3.50,900123456\n' }];
  await f.$('#gpa-csv').onchange();
  assert.equal(f.$('#gpa-column-gpa').value, '-1', 'ambiguous GPA columns require an explicit choice');
  assert.match(f.$('#gpa-column-gpa').innerHTML, /Column C · GPA/);
  assert.equal(f.$('#gpa-column-schoolId').value, '3');
  assert.equal(f.$('#gpa-column-schoolId-hint').textContent, 'Row 2: 900123456');
  assert.equal(f.$('#apply-gpa-tiers').disabled, true);
  assert.equal(f.requests.length, 1, 'reading the file does not upload any values');

  f.$('#gpa-column-gpa').value = '0'; // The name column is not a GPA column.
  f.$('#gpa-layout').onchange({ target: { id: 'gpa-column-gpa' } });
  f.$('#preview-gpa-tiers').onclick();
  assert.match(f.$('#form-error').textContent, /different column/);
  assert.equal(f.$('#apply-gpa-tiers').disabled, true);

  f.$('#gpa-column-gpa').value = '1';
  f.$('#gpa-layout').onchange({ target: { id: 'gpa-column-gpa' } });
  assert.equal(f.$('#gpa-column-gpa-hint').textContent, 'Row 2: 2.60');
  f.$('#preview-gpa-tiers').onclick();
  assert.match(f.$('#gpa-import-preview').innerHTML, /Tier 1 → Tier 4/);
  assert.equal(f.$('#apply-gpa-tiers').disabled, true);
  f.$('#gpa-confirm').checked = true;
  f.$('#gpa-confirm').onchange();
  assert.equal(f.$('#apply-gpa-tiers').disabled, false);

  for (const key of ['gpa', 'schoolId']) {
    if (key === 'gpa') f.$('#gpa-column-gpa').value = '2';
    f.$('#gpa-layout').onchange({ target: { id: `gpa-column-${key}` } });
    assert.equal(f.$('#gpa-import-preview').innerHTML, '');
    assert.equal(f.$('#gpa-confirm').checked, false);
    assert.equal(f.$('#apply-gpa-tiers').disabled, true);
    f.$('#preview-gpa-tiers').onclick();
    assert.match(f.$('#gpa-import-preview').innerHTML, /Tier 1 → Tier 1/);
    f.$('#gpa-confirm').checked = true;
    f.$('#gpa-confirm').onchange();
  }
  assert.equal(f.requests.length, 1, 'mapping and preview stay in the Chair browser until explicitly applied');
});

test('member cannot open the GPA import or fetch its private roster', async () => {
  const f = fixture();
  f.context.user.role = 'member';
  await f.open();
  assert.equal(f.requests.length, 0);
  assert.equal(f.dialogs.length, 0);
});

test('Excel worksheet changes rebuild column mapping and require a new review without uploading the workbook', async () => {
  const sheets = [
    gpaHelpers.readGpaSheet('Name,GPA,Student ID\nSample Member,2.60,900123456\n'),
    gpaHelpers.readGpaSheet('Student ID,Name,GPA\n900123456,Sample Member,3.50\n'),
  ];
  let closed = false, signal;
  const f = fixture({ openGpaWorkbook: async (file, options) => {
    assert.equal(file.name, 'fictional.xlsx');
    signal = options.signal;
    return { sheets: [{ name: 'Prior term' }, { name: 'Current term' }],
      readSheet: async index => sheets[index], close() { closed = true; } };
  } });
  await f.open();
  assert.match(f.dialogs.at(-1), /accept="\.xlsx,\.xls,\.xlx,\.csv/);
  f.$('#gpa-csv').files = [{ name: 'fictional.xlsx', size: 500 }];
  await f.$('#gpa-csv').onchange();
  assert.equal(f.$('#gpa-worksheet-field').hidden, false);
  assert.equal(f.$('#gpa-column-gpa').value, '1');
  assert.equal(f.$('#gpa-column-schoolId').value, '2');
  f.$('#preview-gpa-tiers').onclick();
  assert.match(f.$('#gpa-import-preview').innerHTML, /Tier 1 → Tier 4/);
  f.$('#gpa-confirm').checked = true;
  f.$('#gpa-confirm').onchange();
  assert.equal(f.$('#apply-gpa-tiers').disabled, false);

  f.$('#gpa-worksheet').value = '1';
  await f.$('#gpa-worksheet').onchange();
  assert.equal(f.$('#gpa-column-gpa').value, '2');
  assert.equal(f.$('#gpa-column-schoolId').value, '0');
  assert.equal(f.$('#gpa-confirm').checked, false);
  assert.equal(f.$('#apply-gpa-tiers').disabled, true);
  assert.equal(f.$('#gpa-import-preview').innerHTML, '');
  f.$('#preview-gpa-tiers').onclick();
  assert.match(f.$('#gpa-import-preview').innerHTML, /Tier 1 → Tier 1/);
  assert.equal(f.requests.length, 1, 'Excel values never cross the tier API boundary');
  f.context.modal.close();
  assert.equal(closed, true);
  assert.equal(signal.aborted, true);
});

test('closing the import while an Excel file opens discards the late workbook', async () => {
  let finish, closed = 0;
  const f = fixture({ openGpaWorkbook: () => new Promise(resolve => { finish = resolve; }) });
  await f.open();
  f.$('#gpa-csv').files = [{ name: 'fictional.xls', size: 500 }];
  const loading = f.$('#gpa-csv').onchange();
  await Promise.resolve();
  f.context.modal.close();
  finish({ sheets: [{ name: 'Private grades' }], close() { closed++; } });
  await loading;
  assert.equal(closed, 1);
  assert.equal(f.$('#gpa-layout').hidden, true);
  assert.equal(f.$('#apply-gpa-tiers').disabled, true);
  assert.equal(f.requests.length, 1);
});
