import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as gpaHelpers from '../web/gpa-import.mjs';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function openTierImport()');
const functionSource = source.slice(start, source.indexOf('\nasync function auditPage()', start))
  .replace('import("/gpa-import.mjs")', 'Promise.resolve(gpaHelpers)');

function fixture() {
  const controls = new Map(), dialogs = [], requests = [], closeCallbacks = [];
  const $ = (selector) => {
    if (!controls.has(selector)) controls.set(selector, {
      value: '', textContent: '', innerHTML: '', hidden: false, checked: false,
      disabled: false, replaceChildren() { this.innerHTML = ''; }, focus() {},
    });
    return controls.get(selector);
  };
  const context = {
    user: { id: 'fictional-chair', role: 'chair' }, sessionEpoch: 1, $, gpaHelpers,
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
