import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const start = source.indexOf("async function editMemberAccount(");
const editSource = source.slice(start, source.indexOf("\nfunction editAcademicSettings(", start));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture({ newMember = false } = {}) {
  const load = deferred(), save = deferred(), closeListeners = [];
  const feedback = { textContent: "", innerHTML: "" };
  const fields = {
    "#account-member-name": { value: "Updated Fictional Name", disabled: false },
    "#account-member-email": { value: "must-not-be-submitted@example.test", disabled: false, readOnly: true },
    "#account-member-badge": { value: "5678", disabled: false },
    "#account-member-tier": { value: newMember ? "1" : "4", disabled: newMember },
    "#account-member-credits": { value: "12", disabled: false, readOnly: true },
  };
  const submit = { disabled: false }, controls = [...Object.values(fields), submit];
  const form = { dataset: {}, isConnected: true, querySelectorAll: () => controls, querySelector: () => feedback };
  const context = {
    user: { id: "chair", role: "chair" }, sessionEpoch: 1,
    appConfig: { chapterAuth: { enabled: true } }, isDemo: () => false,
    esc: value => String(value ?? ""), loading: () => "loading", rules: { checkpoints: [{ targets: [30, 50, 70, 90, 110] }] },
    modal: { open: true, addEventListener: (event, callback) => closeListeners.push(callback), close() {
      this.open = false; context.closes++; closeListeners.forEach(callback => callback());
    } },
    openModal: (title, subtitle, body) => context.views.push({ title, subtitle, body }),
    $: selector => selector === "#member-account-form" ? form : fields[selector],
    api: (path, options) => { context.requests.push({ path, options }); return options?.method === "POST" ? save.promise : load.promise; },
    editAcademicSettings: () => { context.legacyEdits++; },
    refresh: async () => { context.refreshes++; }, rosterPage: async () => { context.rosterRenders++; },
    render: () => { context.renders++; }, toast: message => context.messages.push(message),
    formError: message => context.errors.push(message), location: { hash: "#roster" },
    requests: [], views: [], messages: [], errors: [], refreshes: 0, rosterRenders: 0, renders: 0, closes: 0, legacyEdits: 0,
  };
  const details = { member: { id: "fictional-member", name: "Fictional Name", email: "member@example.test", tier: newMember ? 1 : 4, credits: 12 },
    badge: "1234", loginId: "KH-ABCDEF1234", version: "a".repeat(64), membership: newMember ? "new_member" : "active", creditsManaged: true };
  const opened = runInNewContext(`(${editSource})`, context)(details.member);
  return { context, load, save, details, opened, form, feedback, controls, fields, submit,
    mount: async () => { load.resolve(details); await opened; },
    send: () => form.onsubmit({ preventDefault() {} }) };
}

test("Chair account editing submits a versioned settings request without email or any mail endpoint", async () => {
  const f = fixture(); await f.mount();
  assert.equal(f.context.requests[0].path, "/api/roster/fictional-member/account-settings");
  assert.match(f.context.views.at(-1).body, /id="account-member-email" type="email" readonly/);
  const saving = f.send(); await f.send();
  assert.equal(f.context.requests.length, 2, "repeated clicks cannot submit twice");
  const update = f.context.requests[1];
  assert.equal(update.path, "/api/roster/fictional-member/account-settings");
  assert.equal(update.options.method, "POST");
  assert.equal(Object.keys(update.options.body).sort().join(","), "badge,credits,name,tier,version");
  assert.equal(update.options.body.name, "Updated Fictional Name");
  assert.equal(update.options.body.badge, "5678");
  assert.equal(update.options.body.tier, 4);
  assert.equal(update.options.body.credits, 12);
  assert.equal(update.options.body.version, f.details.version);
  assert.equal(update.options.body.email, undefined);
  f.save.resolve({ member: f.details.member }); await saving;
  assert.equal(f.context.closes, 1);
  assert.equal(f.context.refreshes, 1);
  assert.equal(f.context.rosterRenders, 1);
  assert.match(f.context.messages[0], /No email sent/);
});

test("validation and stale-save errors restore controls without enabling the locked new-member tier", async () => {
  const f = fixture({ newMember: true }); await f.mount();
  const saving = f.send();
  assert.ok(f.controls.every(control => control.disabled));
  f.save.reject(Object.assign(Error("This account changed. Reopen its settings before saving."), { status: 409 })); await saving;
  assert.match(f.feedback.textContent, /Reopen/);
  assert.equal(f.fields["#account-member-tier"].disabled, true);
  assert.equal(f.fields["#account-member-credits"].readOnly, true);
  assert.equal(f.fields["#account-member-name"].disabled, false);
  assert.equal(f.submit.disabled, false);
  assert.equal(f.form.dataset.pending, undefined);
  assert.equal(f.context.closes, 0);
});

test("account-detail responses cannot replace a view after sign-out or dialog closure", async () => {
  for (const changed of ["session", "closed"]) {
    const f = fixture();
    if (changed === "session") { f.context.user = { id: "different", role: "member" }; f.context.sessionEpoch++; }
    else f.context.modal.close();
    f.load.resolve(f.details); await f.opened;
    assert.equal(f.context.views.length, 1, "only the initial loading view was rendered");
    assert.equal(f.form.onsubmit, undefined);
  }
});

test("late account saves do not close another dialog or refresh a different signed-in account", async () => {
  for (const changed of ["session", "replaced"]) {
    const f = fixture(); await f.mount(); const saving = f.send();
    if (changed === "session") { f.context.user = { id: "different", role: "member" }; f.context.sessionEpoch++; }
    else f.form.isConnected = false;
    f.save.resolve({}); await saving;
    assert.equal(f.context.closes, 0);
    assert.equal(f.context.refreshes, 0);
    assert.equal(f.context.messages.length, 0);
  }
});
