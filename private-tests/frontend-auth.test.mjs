import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const passwordSource = extract('function mountPasswordForm(', '\nasync function profilePage(');
const apiSource = extract('async function api(', '\nconst loading =');
const redactSource = extract('const redact =', '\nconst $ =');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};

function passwordFixture() {
  const request = deferred(), controls = [{disabled:false}, {disabled:false}], notices = [], logins = [];
  const feedback = {textContent:'',innerHTML:''}, notice = {textContent:''};
  const form = {querySelectorAll:() => controls, reset:() => {form.resetCalled = true;}};
  const container = {isConnected:true, querySelector:selector => selector === 'form' ? form : feedback};
  const context = {
    user:{id:'fictional-member'}, sessionEpoch:3, rosterAccounts:[{id:'fictional-member'}], rosterCandidates:[{}],
    appConfig:{chapterAuth:{enabled:true}}, isDemo:() => false, loading:() => 'loading',
    FormData:class { constructor() { return [['currentPassword','fictional-old'], ['newPassword','fictional-new'], ['confirmPassword','fictional-new']]; } },
    api:() => {context.requests++; return request.promise;}, requests:0,
    loginPage:() => {logins.push(true); context.user = null; context.sessionEpoch++; container.isConnected = false;},
    toast:message => notices.push(message), $:() => notice,
  };
  const mount = runInNewContext(`(${passwordSource})`, context); mount(container);
  return {context, request, controls, feedback, notice, form, container, logins, notices,
    submit:() => form.onsubmit({preventDefault(){}})};
}

test('password changes are single-flight and clear the whole signed-in interface on success', async () => {
  const f = passwordFixture(), first = f.submit();
  await f.submit();
  assert.equal(f.context.requests,1);
  assert.ok(f.controls.every(control => control.disabled));
  f.request.resolve({message:'Changed'}); await first;
  assert.equal(f.logins.length,1);
  assert.equal(f.context.user,null);
  assert.equal(f.context.rosterAccounts.length,0);
  assert.match(f.notices[0],/Sign in again/);
});

test('ambiguous password updates clear stale account controls and preserve recovery guidance', async () => {
  for (const status of [undefined,503]) {
    const f = passwordFixture(), promise = f.submit();
    f.request.reject(Object.assign(Error('Fictional interrupted update'), {status})); await promise;
    assert.equal(f.logins.length,1);
    assert.match(f.notice.textContent,/Fictional interrupted update/);
    assert.match(f.notice.textContent,/new password first/);
  }
});

test('incorrect current password remains editable and a stale callback cannot clear another account', async () => {
  const incorrect = passwordFixture(), first = incorrect.submit();
  incorrect.request.reject(Object.assign(Error('The current password is incorrect.'), {status:401})); await first;
  assert.equal(incorrect.logins.length,0);
  assert.ok(incorrect.controls.every(control => !control.disabled));
  assert.match(incorrect.feedback.textContent,/incorrect/);
  const stale = passwordFixture(), second = stale.submit();
  stale.context.sessionEpoch++;
  stale.context.user = {id:'different-member'};
  stale.request.resolve({}); await second;
  assert.equal(stale.logins.length,0);
  assert.equal(stale.context.user.id,'different-member');
});

test('sign-in and recovery requests redact entire payloads and retain explicit CSRF headers', async () => {
  const requests = [], context = {
    AbortController, setTimeout, clearTimeout,
    sessionEpoch:1,user:undefined,csrfToken:null,logs:[],performance:{now:() => 1},
    fetch:async (path, options) => {requests.push(options); return {ok:true,status:200,json:async () => ({accessToken:'fictional-private-token', recoveryKey:'fictional-words'})};},
  };
  const api = runInNewContext(`${redactSource}\n(${apiSource})`,context);
  for (const path of ['/api/auth/login','/api/auth/complete','/api/account/recovery-key/confirm']) {
    await api(path,{method:'POST',body:{code:'123456',currentPassword:'fictional-password'},headers:{'X-CSRF-Token':'preauth-csrf'}});
  }
  assert.ok(requests.every(request => request.headers['X-CSRF-Token'] === 'preauth-csrf'));
  assert.ok(context.logs.every(log => log.request === '[redacted]' && log.response === '[redacted]'));
  assert.doesNotMatch(JSON.stringify(context.logs),/fictional-private|fictional-secret|123456|fictional-words|fictional-password/);
});

test('an in-flight API response from a previous session never reaches its view or diagnostics', async () => {
  const pending = deferred(), context = {
    AbortController, setTimeout, clearTimeout,
    sessionEpoch:1,user:{id:'first'},csrfToken:'first-csrf',logs:[],performance:{now:() => 1},fetch:() => pending.promise,
  };
  const api = runInNewContext(`${redactSource}\n(${apiSource})`,context);
  const result = api('/api/roster');
  context.sessionEpoch++; context.user = {id:'second'}; context.csrfToken='second-csrf';
  pending.resolve({ok:true,status:200,json:async () => ({members:[{name:'private-first-account'}]})});
  await assert.rejects(result,/Account changed/);
  assert.equal(context.logs.length,0);
});

const inviteSource = extract('function addMember(', '\nasync function editMemberAccount(');
function invitationFixture() {
  const request = deferred(), feedback = {textContent:'',innerHTML:''};
  const back = {disabled:false}, submit = {disabled:false}, name = {disabled:false};
  const entryForm = {isConnected:true,dataset:{},
    querySelectorAll:() => [back,submit,name], querySelector:selector => selector === '#form-error' ? feedback : back};
  const modal = {open:true, close(){this.open=false; context.closes++;}};
  const context = {
    appConfig:{chapterAuth:{enabled:true,emailReady:false}}, user:{id:'chair'},sessionEpoch:1,
    esc:value => value ?? '', loading:() => 'loading', modal,
    FormData:class { constructor(){return [['name','Fictional Member'],['email','fictional@example.test'],['badge',''],['tier','1'],['credits','15']];} },
    openModal:() => {}, $:selector => ({'#roster-form':entryForm,'#form-error':feedback})[selector],
    api:(path,options) => {context.requests.push({path,options});return request.promise;}, loadInvitationStatus:async () => {context.refreshes++;}, rosterPage:async () => {context.rosterRenders++;},
    toast:() => {}, closes:0,refreshes:0,rosterRenders:0,requests:[],
  };
  runInNewContext(`(${inviteSource})`,context)();
  return {context,request,entryForm,modal,feedback,submit,back,
    send:() => entryForm.onsubmit({preventDefault(){},target:entryForm})};
}

test('account preparation works with email disabled and is single-flight through the no-mail endpoint', async () => {
  const f = invitationFixture(), sent = f.send();
  await f.send();
  assert.equal(f.context.requests.length,1);
  assert.equal(f.context.requests[0].path,'/api/admin/invitations/prepare');
  assert.equal(f.context.requests[0].options.method,'POST');
  assert.equal(f.context.requests[0].options.body.email,'fictional@example.test');
  assert.equal(f.context.requests[0].options.body.tier,1);
  assert.equal(f.submit.disabled,true);
  f.request.resolve({message:'Account prepared. No email sent.'}); await sent;
  assert.equal(f.context.closes,1);
  assert.equal(f.context.rosterRenders,1);
});

test('late account preparation cannot close a replacement dialog or replace its content', async () => {
  const f = invitationFixture(), sent = f.send();
  f.entryForm.isConnected = false;
  f.request.resolve({message:'Prepared'}); await sent;
  assert.equal(f.context.closes,0);
  assert.equal(f.context.rosterRenders,0);
});

test('preparation failures refresh durable status and stale callbacks do not alter another account', async () => {
  const f = invitationFixture(), sent = f.send();
  f.request.reject(Error('Preparation interrupted')); await sent;
  assert.equal(f.submit.disabled,false,'preparation retries cannot send mail');
  assert.equal(f.back.disabled,false);
  assert.match(f.feedback.textContent,/Preparation interrupted/);
  assert.equal(f.context.refreshes,1);
  const stale = invitationFixture(), staleSend = stale.send();
  stale.context.user = {id:'member'}; stale.context.sessionEpoch++;
  stale.request.reject(Error('Preparation interrupted')); await staleSend;
  assert.equal(stale.context.refreshes,0);
  assert.equal(stale.feedback.textContent,'');
});

function timedApiFixture(fetch) {
  const timers = [], cleared = [], requests = [];
  const context = {
    AbortController, sessionEpoch:1,user:{id:'fictional'},csrfToken:'csrf',logs:[],performance:{now:() => 1},
    setTimeout:(callback, delay) => {const timer={callback,delay};timers.push(timer);return timer;},
    clearTimeout:timer => cleared.push(timer),
    fetch:(path, options) => {requests.push({path,options});return fetch(path,options);},
  };
  return {api:runInNewContext(`${redactSource}\n(${apiSource})`,context),timers,cleared,requests,context};
}

test('API timeouts stop stalled requests with no automatic retry and use separate security and work limits', async () => {
  for (const [path,limit] of [['/api/auth/login',45000],['/api/account/password',45000],['/api/semester/reset',135000],['/api/uploads',135000]]) {
    const f = timedApiFixture((path,{signal}) => new Promise((resolve,reject) => {
      signal.addEventListener('abort',() => reject(signal.reason),{once:true});
    }));
    const pending = f.api(path,{method:'POST',body:{password:'fictional-secret'}});
    assert.equal(f.timers[0].delay,limit);
    f.timers[0].callback();
    await assert.rejects(pending,/result was not confirmed.*Check the current status/);
    assert.equal(f.requests[0].options.signal.aborted,true);
    assert.equal(f.requests.length,1,'timeouts must never automatically replay a mutation');
    assert.equal(f.cleared[0],f.timers[0]);
    assert.equal(f.context.logs[0].status,'Request timed out');
    assert.doesNotMatch(JSON.stringify(f.context.logs),/fictional-secret/);
  }
});

test('API timers are released after success, HTTP errors and malformed bodies', async () => {
  for (const mode of ['success','http-error','malformed']) {
    const f = timedApiFixture(async () => ({ok:mode !== 'http-error',status:mode === 'http-error' ? 422 : 200,
      json:async () => {if(mode === 'malformed') throw Error('Malformed response'); return {error:'Validation failed'};}}));
    if (mode === 'success') await f.api('/api/roster');
    else await assert.rejects(f.api('/api/roster'),mode === 'http-error' ? /Validation failed/ : /Malformed response/);
    assert.equal(f.cleared.length,1);
    assert.equal(f.cleared[0],f.timers[0]);
    assert.equal(f.requests[0].options.signal.aborted,false);
  }
});

test('API timeout also covers a stalled response body and clears its timer', async () => {
  const bodyStarted = deferred();
  const f = timedApiFixture(async (path,{signal}) => ({ok:true,status:200,json:() => {
    bodyStarted.resolve();
    return new Promise((resolve,reject) => signal.addEventListener('abort',() => reject(signal.reason),{once:true}));
  }}));
  const pending = f.api('/api/session');
  await bodyStarted.promise;
  f.timers[0].callback();
  await assert.rejects(pending,/request timed out/);
  assert.equal(f.context.logs[0].status,'Request timed out');
  assert.equal(f.cleared.length,1);
});
