import { authMutationVersion, assertAuthMutationVersion, beginAuthMutation, finishAuthMutation } from "./auth-mutation.mjs";
import { pilotEligible } from "./pilot-access.mjs";
import { invitationView, invitationList, runInvitation } from "./invitations.mjs";
import { pointAdjustmentView, applyPointAdjustment } from "../web/point-adjustment-data.mjs";
import { categoriesFor, categoryView, applyCategoryChange, categoryForSubmission } from "../web/category-data.mjs";
import { creditSummary } from "../web/credit-data.mjs";
import { profileView } from "../web/profile-data.mjs";
import { classView, classInput, classCredits, creditsManaged, approvedClassCredits, approveClassCredits, refreshPendingCreditEstimates, removalView, syllabusView, assignmentClass, submissionSyllabus } from "../web/syllabus-data.mjs";
import { checkpointQuotaView, validateCheckpointQuotas } from "../web/checkpoint-data.mjs";
import http from "node:http";
import { readFile, writeFile, mkdir, unlink, access } from "node:fs/promises";
import { resolve, extname, basename } from "node:path";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { openDatabase } from "./database.mjs";
import {
  chapterAuthConfigured,
  chairAccountConfigured,
  verifyPassword,
  invitationAccountByEmail,
  prepareInvitationAccount,
  sendInvitationAccount,
  createPilotAccount,
  deleteNewPilotAccount,
  sendPasswordReset,
  userForAccountToken,
  setPasswordWithToken,
  setPasswordByAdmin,
} from "./chapter-auth.mjs";
import {
  issueSemesterRecoveryKey,
  beginRecovery,
  cancelRecovery,
  finishRecovery,
  clearRecoveryKey,
  recoveryKeyStatus,
  confirmRecoveryKey,
} from "./recovery.mjs";
import { rosterStatus, fetchRosterSnapshot, fetchRosterImportIdentifiers } from "./roster.mjs";
import { validateGpaImportMapping } from "./gpa-import-settings.mjs";
import { faqView, validateFaqChange, applyFaqChange } from "../web/faq-data.mjs";
import {
  storageStatus,
  verifyStorageConfiguration,
  createUploadGrant,
  finalizeStoredEvidence,
  createDownloadGrant,
  removeStoredEvidence,
  deleteStoredEvidenceAndVerify,
} from "./storage.mjs";
import {
  assertAcademicWritesAllowed,
  semesterResetStatus,
  previewSemesterReset,
  startSemesterReset,
  resumeSemesterReset,
  UPLOAD_GRANT_DRAIN_MS,
} from "./semester.mjs";
import {
  TODAY,
  members as demoMembers,
  multiplier,
  seed,
  totals,
  validateClaim,
} from "./domain.mjs";
import { canvasAssignments, sampleAssignments } from "./canvas-sample.mjs";
import {
  identityProviders,
  startIdentityFlow,
  completeIdentityFlow,
} from "./identity.mjs";
import {
  canvasStatus,
  startCanvasFlow,
  completeCanvasFlow,
  fetchCanvasAssignments,
  refreshCanvasTokens,
  sealTokens,
  openTokens,
} from "./canvas.mjs";

const env = process.env;
const root = resolve(import.meta.dirname, "..");
const mode = env.APP_MODE || "demo";
if (!["demo", "production"].includes(mode))
  throw Error("APP_MODE must be demo or production.");
const production = mode === "production";
const chapterEmailReady = env.CHAPTER_EMAIL_READY === "true";
const authMode = env.AUTH_MODE || "chapter";
if (!["microsoft", "chapter"].includes(authMode))
  throw Error("AUTH_MODE must be microsoft or chapter.");
const port = Number(env.PORT || 4175);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("PORT must be a valid port.");
if (production && !env.PUBLIC_ORIGIN)
  throw Error("Production requires PUBLIC_ORIGIN with an exact HTTPS origin.");
const originUrl = new URL(env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`);
if (
  originUrl.username ||
  originUrl.password ||
  originUrl.pathname !== "/" ||
  originUrl.search ||
  originUrl.hash ||
  (production
    ? originUrl.protocol !== "https:"
    : !["http:", "https:"].includes(originUrl.protocol))
)
  throw Error(
    "PUBLIC_ORIGIN must be an exact origin; production requires HTTPS.",
  );
const origin = originUrl.origin;
const dataDir = resolve(
  env.PRIVATE_DATA_DIR || env.APP_DATA_DIR || resolve(root, "data"),
  mode,
);
const filesDir = resolve(dataDir, "evidence");
const db = await openDatabase({ env, directory: dataDir });
const directUploads = db.kind === "postgres";
if (!directUploads) await mkdir(filesDir, { recursive: true, mode: 0o700 });
if (env.VERCEL || env.VERCEL_ENV) {
  if (!storageStatus(env).configured)
    throw Error("Hosted production requires private object storage.");
  await verifyStorageConfiguration({ env });
}

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const now = () => new Date().toISOString();
const policyDay = () =>
  production
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date())
    : TODAY;
function validDate(date) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date
  );
}
const targetDate = env.SEMESTER_TARGET_DATE || "2026-12-04";
const endDate = env.SEMESTER_END_DATE || null;
if (!validDate(targetDate) || (endDate && !validDate(endDate)))
  throw Error("Semester dates must use valid YYYY-MM-DD dates.");
const checkpointDates = ["2026-09-12", "2026-10-10", "2026-11-06"];
function semesterSettings(state = {}) {
  return {
    name: "Fall 2026",
    startDate: null,
    targetDate,
    endDate,
    checkpointDates: [...checkpointDates],
    ...state.semester,
    timeZone: "America/New_York",
  };
}
function semesterCheckpoints(state) {
  const semester = semesterSettings(state);
  return checkpointQuotaView(state, [...semester.checkpointDates, semester.targetDate]).checkpoints;
}
function academicGuard(state, generation) {
  assertAcademicWritesAllowed(state);
  if (
    generation !== undefined &&
    (state.semesterGeneration || null) !== generation
  )
    fail(409, "The semester changed. Refresh before continuing.");
}
async function academicSnapshot(session, expectedGeneration) {
  const state = await stateOf(session.workspace);
  academicGuard(state, expectedGeneration);
  return state.semesterGeneration || null;
}
const sessionCookie = production ? "__Host-ato_session" : "ato_session";
const identityCookie = production ? "__Host-ato_identity" : "ato_identity";
// Clear the retired pre-authentication cookie when a regular login succeeds.
const legacyMfaCookie = production ? "__Host-ato_chair_mfa" : "ato_chair_mfa";
const SESSION_LIFETIME = 8 * 60 * 60 * 1000;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("hex");
const loginAlias = () => `KH-${randomBytes(5).toString("hex").toUpperCase()}`;
function equal(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
function cookie(name, value, maxAge = SESSION_LIFETIME / 1000) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${production || originUrl.protocol === "https:" ? "; Secure" : ""}`;
}
function getCookie(req, name) {
  const found = (req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (found.length !== 1) return null;
  const value = found[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
async function atomic(fn) {
  return db.transaction(fn);
}
async function lockWorkspace(workspace) {
  const row = await db
    .prepare("SELECT workspace FROM chapters WHERE workspace=? FOR UPDATE")
    .get(workspace);
  if (!row) fail(404, "Chapter workspace not found.");
}
async function assertActiveSession(session, user, checkEligibility = true) {
  const fresh = await db
    .prepare("SELECT id FROM sessions WHERE id=? AND expires>?")
    .get(session.id, Date.now());
  const currentMember = await member(session.workspace, user.id);
  if (!fresh || !currentMember?.active || currentMember.role !== user.role)
    fail(401, "Your account session is no longer active.");
  if (checkEligibility && user.role !== "chair")
    assertRosterEligibility(await stateOf(session.workspace), currentMember);
  return currentMember;
}

function rosterView(state) {
  const config = rosterStatus(env);
  const snapshot = state.roster;
  const age = Date.now() - Date.parse(snapshot?.fetchedAt);
  const active = config.mode === "public_email_csv" ? snapshot?.emails : snapshot?.ids;
  const fresh =
    config.configured &&
    !state.rosterSyncError &&
    snapshot?.source === config.source &&
    Array.isArray(active) &&
    (config.mode !== "public_email_csv" || Array.isArray(snapshot?.directory)) &&
    Number.isFinite(age) &&
    age >= 0 &&
    age < config.maxAgeMs;
  return {
    ...config,
    fresh,
    fetchedAt: snapshot?.fetchedAt || null,
    revision: snapshot?.revision || null,
    activeCount: active?.length || 0,
    newMemberCount: config.mode === "public_email_csv"
      ? snapshot?.directory?.filter((entry) => entry.membership === "new_member").length || 0
      : 0,
    refreshing: (state.rosterSyncAttempt?.expiresAt || 0) > Date.now(),
    retryAt: state.rosterSyncError?.retryAt || null,
    lastError: state.rosterSyncError
      ? "Roster synchronization failed. Check the configured sheet and try again."
      : null,
  };
}
function listedOnRoster(state, user) {
  const snapshot = state.roster;
  return rosterStatus(env).mode === "public_email_csv"
    ? snapshot?.emails?.includes(user.email?.trim().toLowerCase()) === true
    : snapshot?.ids?.includes(user.id) === true;
}
function assertRosterEligibility(state, user) {
  const status = rosterView(state);
  if (pilotEligible(state, user)) return;
  if (user.email?.endsWith("@pilot.invalid")) fail(403, "This pilot account has expired or been disabled.");
  if (!status.required || user.role === "chair") return;
  if (!status.fresh)
    fail(
      503,
      "Current roster eligibility is unavailable. Ask the Scholarship Chair to refresh the roster.",
    );
  if (!listedOnRoster(state, user))
    fail(
      403,
      "Your account is not active on the current chapter roster. Contact the Scholarship Chair.",
    );
}
async function refreshRoster(session, user, force = false) {
  const attempt = randomUUID();
  const source = rosterStatus(env).source;
  const existing = await atomic(async () => {
    await lockWorkspace(session.workspace);
    await assertActiveSession(session, user, false);
    const state = await stateOf(session.workspace);
    if (!force && rosterView(state).fresh) return state;
    if (
      state.rosterSyncAttempt?.source === source &&
      state.rosterSyncAttempt.expiresAt > Date.now()
    )
      fail(
        503,
        "Roster refresh is already in progress. Try again in a few seconds.",
      );
    if (
      state.rosterSyncError?.source === source &&
      Date.parse(state.rosterSyncError.retryAt) > Date.now()
    )
      fail(
        503,
        "Roster refresh failed recently. Wait thirty seconds before retrying.",
      );
    state.rosterSyncAttempt = {
      id: attempt,
      source,
      expiresAt: Date.now() + 45_000,
    };
    await db
      .prepare("UPDATE chapters SET data=? WHERE workspace=?")
      .run(JSON.stringify(state), session.workspace);
    return null;
  });
  if (existing) return existing;
  let snapshot;
  try {
    snapshot = await fetchRosterSnapshot({ env });
  } catch (error) {
    await atomic(async () => {
      await lockWorkspace(session.workspace);
      await assertActiveSession(session, user, false);
      const state = await stateOf(session.workspace);
      if (state.rosterSyncAttempt?.id !== attempt) return;
      state.rosterSyncError = {
        at: now(),
        source,
        retryAt: new Date(Date.now() + 30_000).toISOString(),
      };
      delete state.rosterSyncAttempt;
      await db
        .prepare("UPDATE chapters SET data=? WHERE workspace=?")
        .run(JSON.stringify(state), session.workspace);
    });
    throw error;
  }
  return atomic(async () => {
    await lockWorkspace(session.workspace);
    await assertActiveSession(session, user, false);
    const state = await stateOf(session.workspace);
    if (
      state.rosterSyncAttempt?.id !== attempt ||
      state.rosterSyncAttempt.expiresAt <= Date.now()
    )
      return state;
    state.roster = snapshot;
    if (state.tierAssignments) {
      const eligible = new Set(snapshot.emails || []);
      state.tierAssignments = Object.fromEntries(Object.entries(state.tierAssignments)
        .filter(([email]) => eligible.has(email)));
    }
    delete state.rosterSyncError;
    delete state.rosterSyncAttempt;
    await db
      .prepare("UPDATE chapters SET data=? WHERE workspace=?")
      .run(JSON.stringify(state), session.workspace);
    await audit(
      session.workspace,
      user.name,
      "roster.sync",
      "",
      `${rosterView(state).activeCount} eligible roster entries`,
    );
    return state;
  });
}

async function audit(workspace, actor, action, subject = "", detail = "") {
  await db
    .prepare(
      "INSERT INTO audit(workspace,at,actor,action,subject,detail) VALUES (?,?,?,?,?,?)",
    )
    .run(workspace, now(), actor || "system", action, subject, detail);
}
function memberView(row, checkpoint, finalCheckpoint) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    tier: row.tier,
    credits: row.credits,
    active: !!row.active,
    initials: row.name
      .split(/\s+/)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase(),
    ...(row.role === "member"
      ? {
          goal: finalCheckpoint.targets[row.tier - 1],
          checkpoint: checkpoint.targets[row.tier - 1],
          checkpointDate: checkpoint.date,
        }
      : {}),
  };
}
async function member(workspace, id) {
  const row = await db
    .prepare("SELECT * FROM members WHERE workspace=? AND id=?")
    .get(workspace, id);
  if (!row) return null;
  const state = await stateOf(workspace);
  const schedule = semesterCheckpoints(state);
  const checkpoint =
    schedule.find((c) => c.date >= policyDay()) || schedule.at(-1);
  return { ...memberView(row, checkpoint, schedule.at(-1)), creditsManaged: creditsManaged(state, row.id) };
}
async function listMembers(workspace, state) {
  const rows = await db
    .prepare("SELECT * FROM members WHERE workspace=? ORDER BY name")
    .all(workspace);
  if (!rows.length) return [];
  state ??= await stateOf(workspace);
  const schedule = semesterCheckpoints(state);
  const checkpoint =
    schedule.find((c) => c.date >= policyDay()) || schedule.at(-1);
  return rows.map((row) => ({ ...memberView(row, checkpoint, schedule.at(-1)), creditsManaged: creditsManaged(state, row.id) }));
}
async function tierImportView(workspace, state) {
  const existing = (await listMembers(workspace, state)).filter((entry) => entry.role === "member");
  const byEmail = new Map(existing.map((entry) => [entry.email.toLowerCase(), entry]));
  let directory;
  if (production) {
    if (rosterView(state).mode !== "public_email_csv" || !rosterView(state).fresh)
      fail(503, "Refresh the connected name-and-email roster before importing tiers.");
    directory = state.roster.directory;
  } else {
    directory = existing.filter((entry) => entry.active).map((entry) => ({
      name: entry.name, email: entry.email, membership: "active",
    }));
  }
  const targets = directory.map((entry) => {
    const account = byEmail.get(entry.email.toLowerCase());
    return {
      name: entry.name,
      email: entry.email.toLowerCase(),
      membership: entry.membership,
      accountId: account?.active ? account.id : null,
      accountStatus: !account ? "not_invited" : account.active ? "active" : "inactive",
      currentTier: account?.active ? account.tier : null,
      stagedTier: state.tierAssignments?.[entry.email.toLowerCase()] ?? null,
    };
  });
  const snapshot = sha(JSON.stringify({
    roster: production ? state.roster?.revision : "demo",
    generation: state.semesterGeneration || null,
    targets: targets.map(({ email, membership, accountId, accountStatus, currentTier, stagedTier }) =>
      [email, membership, accountId, accountStatus, currentTier, stagedTier]),
  }));
  return { snapshot, targets, mapping: state.gpaImportMapping || null };
}
async function insertMember(workspace, m) {
  await db
    .prepare(
      "INSERT INTO members(workspace,id,name,email,role,tier,credits,active) VALUES (?,?,?,?,?,?,?,1)",
    )
    .run(
      workspace,
      m.id,
      m.name,
      m.email,
      m.role,
      m.tier ?? null,
      m.credits ?? null,
    );
}
async function identityMember(workspace, provider, subject) {
  return db
    .prepare(
      "SELECT member_id FROM identities WHERE workspace=? AND provider=? AND subject=?",
    )
    .get(workspace, provider, subject);
}
async function accountForIdentifier(identifier) {
  const normalized = identifier.trim().toLowerCase();
  if (normalized.includes("@")) {
    const row = await db
      .prepare("SELECT id FROM members WHERE workspace=? AND LOWER(email)=?")
      .get("chapter", normalized);
    return row ? member("chapter", row.id) : null;
  }
  const row = await identityMember("chapter", "login", normalized);
  return row ? member("chapter", row.member_id) : null;
}
async function authAttempt(kind, identifier, maxAttempts) {
  const id = sha(`${kind}:${identifier.trim().toLowerCase()}`);
  await atomic(async () => {
    await db
      .prepare(
        "INSERT INTO transactions(id,kind,session_id,data,expires) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(id, kind, null, "0", Date.now() + 900_000);
    const row = await db
      .prepare("SELECT data,expires FROM transactions WHERE id=? FOR UPDATE")
      .get(id);
    const attempts = row.expires > Date.now() ? Number(row.data) : 0;
    if (attempts >= maxAttempts)
      fail(429, "Too many attempts. Try again later.");
    await db
      .prepare("UPDATE transactions SET data=?,expires=? WHERE id=?")
      .run(
        String(attempts + 1),
        row.expires > Date.now() ? row.expires : Date.now() + 900_000,
        id,
      );
  });
}
async function clearAuthAttempts(kind, identifier) {
  await db.prepare("DELETE FROM transactions WHERE id=?")
    .run(sha(`${kind}:${identifier.trim().toLowerCase()}`));
}
async function stateOf(workspace) {
  return JSON.parse(
    (
      await db
        .prepare("SELECT data FROM chapters WHERE workspace=?")
        .get(workspace)
    ).data,
  );
}
async function currentSession(req) {
  const raw = getCookie(req, sessionCookie);
  if (!raw) return null;
  return (
    (await db
      .prepare("SELECT * FROM sessions WHERE id=? AND expires>?")
      .get(sha(raw), Date.now())) || null
  );
}
async function requireSession(req) {
  const session = await currentSession(req);
  const user = session && (await member(session.workspace, session.member_id));
  if (!session || !user?.active)
    fail(401, "Sign in to an active chapter account.");
  if (user.role !== "chair" && req.url?.split("?")[0] !== "/api/logout") {
    let state = await stateOf(session.workspace);
    const status = rosterView(state);
    if (!pilotEligible(state, user) && status.required && !status.fresh)
      state = await refreshRoster(session, user);
    assertRosterEligibility(state, user);
  }
  return { session, user };
}
function chair(user) {
  if (user.role !== "chair")
    fail(403, "Only the Scholarship Chair can perform this action.");
}
function individual(user) {
  if (user.role !== "member")
    fail(403, "Use a member account for individual submissions.");
}
function requireOrigin(req) {
  if (req.headers.origin !== origin)
    fail(403, "The request origin does not match this portal.");
  if (req.headers["sec-fetch-site"] === "cross-site")
    fail(403, "Cross-site requests are not accepted.");
}
function csrf(req, session) {
  requireOrigin(req);
  if (!equal(req.headers["x-csrf-token"], session.csrf))
    fail(
      403,
      "The security token is missing or expired. Refresh and try again.",
    );
}
async function issueSession(workspace, userId, previousId = null) {
  if (previousId)
    await db.prepare("DELETE FROM sessions WHERE id=?").run(previousId);
  const raw = token();
  const session = {
    id: sha(raw),
    workspace,
    member_id: userId,
    csrf: token(),
    expires: Date.now() + SESSION_LIFETIME,
  };
  await db
    .prepare("INSERT INTO sessions VALUES (?,?,?,?,?)")
    .run(session.id, workspace, userId, session.csrf, session.expires);
  return { session, cookie: cookie(sessionCookie, raw) };
}
async function cleanup() {
  await db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
  await db.prepare("DELETE FROM transactions WHERE expires<=?").run(Date.now());
}
async function mutate(session, user, fn) {
  return await atomic(async () => {
    await lockWorkspace(session.workspace);
    const currentMember = await assertActiveSession(session, user);
    const state = await stateOf(session.workspace);
    const result = await fn(state, currentMember);
    await db
      .prepare("UPDATE chapters SET data=? WHERE workspace=?")
      .run(JSON.stringify(state), session.workspace);
    return result;
  });
}
function canvasConfigured() {
  if (!canvasStatus(env).configured) return false;
  const key = env.APP_ENCRYPTION_KEY;
  return (
    typeof key === "string" &&
    /^[A-Za-z0-9+/]{43}=$/.test(key) &&
    Buffer.from(key, "base64").length === 32 &&
    Buffer.from(key, "base64").toString("base64") === key
  );
}
async function connection(session) {
  return await db
    .prepare("SELECT * FROM integrations WHERE workspace=? AND member_id=?")
    .get(session.workspace, session.member_id);
}
async function advanceCanvasGeneration(workspace, userId) {
  const generation = randomUUID();
  await db
    .prepare(
      "INSERT INTO canvas_generations VALUES (?,?,?) ON CONFLICT(workspace,member_id) DO UPDATE SET generation=excluded.generation",
    )
    .run(workspace, userId, generation);
  await db
    .prepare(
      "DELETE FROM transactions WHERE kind='canvas' AND session_id IN (SELECT id FROM sessions WHERE workspace=? AND member_id=?)",
    )
    .run(workspace, userId);
  return generation;
}
async function sessionPayload(session, user) {
  const state = await stateOf(session.workspace);
  return {
    user,
    csrfToken: session.csrf,
    mode,
    today: policyDay(),
    canvasConnected: !!(await connection(session)),
    semester: semesterSettings(state),
    semesterReset: semesterResetStatus(state),
    recoveryKeyPending: production && authMode === "chapter" && user.role === "member"
      ? (await recoveryKeyStatus(db, session.workspace, user.id, state.semesterGeneration || "initial")).needsKey : false,
    rosterEligibility: {
      required: rosterStatus(env).required,
      eligible:
        user.role === "chair" ||
        pilotEligible(state, user) ||
        !rosterStatus(env).required ||
        (rosterView(state).fresh && listedOnRoster(state, user)),
      fresh: rosterView(state).fresh,
      fetchedAt: state.roster?.fetchedAt || null,
    },
  };
}
function json(res, status, value, headers = {}) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 4 * 1024 * 1024)
    fail(413, "Report is too large; contact the portal administrator.");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(serialized);
}
function redirect(res, url, headers = {}) {
  res.writeHead(302, { Location: url, ...headers });
  res.end();
}
async function readBody(req, limit = 30_000) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
    fail(415, "Send JSON content.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, "Request is too large.");
    chunks.push(chunk);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    fail(400, "Invalid JSON.");
  }
  if (!data || Array.isArray(data) || typeof data !== "object")
    fail(400, "Send a JSON object.");
  return data;
}
function ownSubmission(state, user, id) {
  const item = state.submissions.find((s) => s.id === id);
  if (!item || (user.role !== "chair" && item.owner !== user.id))
    fail(404, "Submission not found.");
  return item;
}
function claim(input, state, user, evidence) {
  const semester = semesterSettings(state);
  if (semester.startDate && input.date < semester.startDate)
    fail(422, "This activity is before the current semester start date.");
  if (production && semester.endDate && policyDay() > semester.endDate)
    fail(422, "This semester submission period has closed.");
  try {
    const course = assignmentClass(state, user.id, categoriesFor(state).find(row => row.id === input.activity), input);
    // The shared demo scorer validates dates, caps and duplicates. Actual evidence
    // authorization has already happened here; its sample sentinel is internal only.
    return {
      ...validateClaim(
        { ...input, ...course, evidence: "sample" },
        state,
        user,
        policyDay(),
      ),
      evidence,
      ...course,
    };
  } catch (error) {
    if (error.status) throw error;
    fail(422, error.message);
  }
}
function newSubmission(value, user, extra = {}) {
  return {
    ...value,
    id: `S-${randomUUID()}`,
    owner: user.id,
    status: "pending",
    awarded: 0,
    submittedAt: now(),
    reviewNote: "",
    history: [{ event: "Submitted for review", at: now() }],
    ...extra,
  };
}
function uploadMeta(upload) {
  return {
    id: upload.id,
    name: upload.name,
    mime: upload.mime,
    size: upload.size,
    url: `/api/uploads/${upload.id}`,
  };
}
async function getUpload(id, session, user, ownerOnly = false) {
  const upload =
    typeof id === "string" &&
    (await db
      .prepare("SELECT * FROM uploads WHERE id=? AND workspace=?")
      .get(id, session.workspace));
  if (
    !upload ||
    upload.status !== "ready" ||
    (upload.owner !== user.id && (ownerOnly || user.role !== "chair"))
  )
    fail(404, "Evidence file not found.");
  return upload;
}
function validUpload(input) {
  const name =
    typeof input.name === "string"
      ? basename(input.name.replaceAll("\\", "/"))
          .replace(/[\u0000-\u001f\u007f]/g, "")
          .trim()
      : "";
  if (!name || name.length > 150)
    fail(422, "Choose a file name of at most 150 characters.");
  if (!["application/pdf", "image/png", "image/jpeg"].includes(input.mime))
    fail(422, "Only PDF, PNG and JPEG evidence files are accepted.");
  if (typeof input.base64 !== "string" || input.base64.length % 4 !== 0)
    fail(422, "The file encoding is invalid.");
  if (input.base64.length > Math.ceil((5 * 1024 * 1024) / 3) * 4)
    fail(413, "Evidence must be no larger than 5 MiB.");
  const bytes = Buffer.from(input.base64, "base64");
  if (bytes.toString("base64") !== input.base64)
    fail(422, "The file encoding is invalid.");
  if (!bytes.length) fail(422, "Choose a nonempty evidence file.");
  if (bytes.length > 5 * 1024 * 1024)
    fail(413, "Evidence must be no larger than 5 MiB.");
  const matches =
    input.mime === "application/pdf"
      ? bytes.subarray(0, 5).toString() === "%PDF-"
      : input.mime === "image/png"
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!matches)
    fail(422, "The file contents do not match its declared PDF or image type.");
  return { name, bytes, mime: input.mime };
}
function validateRoster(input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email =
    typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (
    !name ||
    name.length > 100 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    input.provider !== "microsoft" ||
    !subject ||
    subject.length > 512 ||
    /[\u0000-\u001f]/.test(subject) ||
    !Number.isInteger(input.tier) ||
    input.tier < 1 ||
    input.tier > 5 ||
    !Number.isFinite(input.credits) ||
    input.credits < 0 ||
    input.credits > 30
  )
    fail(
      422,
      "Supply a name, email, provider, stable subject, tier 1–5 and credits 0–30.",
    );
  if (
    input.provider === "microsoft" &&
    !/^[a-f0-9-]{36}:(?:oid|sub):.+$/i.test(subject)
  )
    fail(
      422,
      "Microsoft subject must include the tenant and oid or sub namespace.",
    );
  return {
    name,
    email,
    subject,
    provider: input.provider,
    tier: input.tier,
    credits: input.credits,
  };
}
function validateChapterMember(input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const badge = typeof input.badge === "string" ? input.badge.trim().toLowerCase() : "";
  if (
    !name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
    (badge && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(badge)) ||
    !Number.isInteger(input.tier) || input.tier < 1 || input.tier > 5 ||
    !Number.isFinite(input.credits) || input.credits < 0 || input.credits > 30
  ) fail(422, "Enter a name, valid email, optional badge number, tier and credits.");
  return { name, email, badge, tier: input.tier, credits: input.credits };
}
async function accountSettingsView(workspace, target, state) {
  const aliases = (await db.prepare("SELECT subject FROM identities WHERE workspace=? AND provider='login' AND member_id=? ORDER BY subject")
    .all(workspace, target.id)).map(entry => entry.subject);
  const invitation = state.invitations?.[target.email];
  const alias = invitation?.alias || aliases.find(value => /^kh-[a-f0-9]{10}$/.test(value)) || aliases[0] || "";
  const badge = invitation?.badge ?? aliases.find(value => value !== alias) ?? "";
  const membership = state.roster?.directory?.find(entry => entry.email === target.email)?.membership || "active";
  const managedCredits = creditsManaged(state, target.id);
  const version = sha(JSON.stringify({
    id: target.id, name: target.name, email: target.email, role: target.role,
    active: target.active, tier: target.tier, credits: target.credits, aliases,
    alias, badge, membership, managedCredits, generation: state.semesterGeneration || null,
    invitation: invitation && { updatedAt: invitation.updatedAt, operation: invitation.operation },
  }));
  return { member: target, badge, loginId: alias.toUpperCase() || null, version, membership, creditsManaged: managedCredits };
}
async function processInvitation(session, user, email, action, generation, input) {
  if (!production || authMode !== "chapter" || !chapterAuthConfigured(env))
    fail(422, "Account setup requires real chapter sign-in.");
  if (["create", "resend", "send-initial"].includes(action) && !chapterEmailReady)
    fail(503, "Configure and test chapter email before sending setup emails.");
  if (rosterStatus(env).mode === "public_email_csv" && !rosterView(await stateOf(session.workspace)).fresh)
    await refreshRoster(session, user);
  const result = await runInvitation({
    db, workspace: session.workspace, email, input, action,
    authorize: () => assertActiveSession(session, user),
    guard: state => {
      academicGuard(state, generation);
      if (rosterStatus(env).mode === "public_email_csv" &&
        (!rosterView(state).fresh || !state.roster.emails.includes(email)))
        fail(409, "Refresh the roster and confirm this member is still eligible before continuing.");
    },
    provider: {
      find: address => invitationAccountByEmail(env, address),
      create: (address, proof) => prepareInvitationAccount(env, address, proof),
      send: account => sendInvitationAccount(env, account, `${origin}/account/setup`),
    },
    audit: (actionName, subject, detail) => audit(session.workspace, user.name, actionName, subject, detail),
  });
  return {
    member: result.memberId ? await member(session.workspace, result.memberId) : null,
    loginId: result.invitation.loginId,
    invitation: result.invitation, message: result.invitation.message,
  };
}
async function coordinatedCanvasRefresh(
  session,
  user,
  original,
  expectedRevision,
  signal,
) {
  const leaseOwner = randomUUID();
  let acquired = false;
  const deadline = Date.now() + 65_000;
  try {
    while (!acquired) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline)
        fail(503, "Canvas is busy refreshing. Try again shortly.");
      const lease = await db
        .prepare(
          `INSERT INTO canvas_leases(workspace,member_id,owner,expires) VALUES (?,?,?,?)
        ON CONFLICT(workspace,member_id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires
        WHERE canvas_leases.expires<=? RETURNING owner`,
        )
        .get(
          session.workspace,
          user.id,
          leaseOwner,
          Date.now() + 60_000,
          Date.now(),
        );
      acquired = lease?.owner === leaseOwner;
      if (!acquired) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await assertActiveSession(session, user);
    const current = await connection(session);
    if (!current || current.revision !== expectedRevision)
      fail(409, "Canvas connection changed. Start again.");
    const currentTokens = openTokens(current.data, env);
    if (currentTokens.accessToken !== original.accessToken)
      return currentTokens;
    const refreshed = await refreshCanvasTokens({
      env,
      tokens: currentTokens,
      redirectUri: `${origin}/auth/canvas/callback`,
      signal,
    });
    await atomic(async () => {
      await lockWorkspace(session.workspace);
      await assertActiveSession(session, user);
      const updated = await db
        .prepare(
          `UPDATE integrations SET data=? WHERE workspace=? AND member_id=? AND revision=?
        AND EXISTS (SELECT 1 FROM canvas_leases WHERE workspace=? AND member_id=? AND owner=? AND expires>?)`,
        )
        .run(
          sealTokens(refreshed, env),
          session.workspace,
          user.id,
          expectedRevision,
          session.workspace,
          user.id,
          leaseOwner,
          Date.now(),
        );
      if (updated.changes !== 1)
        fail(409, "Canvas refresh was superseded. Reconnect or try again.");
    });
    return refreshed;
  } finally {
    if (acquired)
      await db
        .prepare(
          "DELETE FROM canvas_leases WHERE workspace=? AND member_id=? AND owner=?",
        )
        .run(session.workspace, user.id, leaseOwner);
  }
}
async function liveAssignments(session, user) {
  if (!canvasConfigured())
    fail(503, "Canvas is not configured. Contact the portal administrator.");
  const stored = await connection(session);
  if (!stored) fail(409, "Connect your Canvas account first.");
  const assignments = await fetchCanvasAssignments({
    env,
    tokens: openTokens(stored.data, env),
    redirectUri: `${origin}/auth/canvas/callback`,
    refreshTokens: (tokens, options) =>
      coordinatedCanvasRefresh(
        session,
        user,
        tokens,
        stored.revision,
        options?.signal,
      ),
  });
  await assertActiveSession(session, user);
  if ((await connection(session))?.revision !== stored.revision)
    fail(409, "Canvas connection changed. Start again.");
  return { assignments, revision: stored.revision };
}

async function deleteEvidenceObject({ backend, path }) {
  if (backend === "supabase")
    return deleteStoredEvidenceAndVerify({ path, env });
  if (backend !== "local" || !/^[a-f0-9-]{36}\.bin$/i.test(path))
    fail(503, "Evidence cleanup requires administrator review.");
  const file = resolve(filesDir, path);
  await unlink(file).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  try {
    await access(file);
  } catch (error) {
    if (error.code === "ENOENT") return { deleted: true };
    throw error;
  }
  fail(503, "Evidence deletion could not yet be verified.");
}

// Failed/terminated finalization keeps both object references until a bounded,
// retryable deletion proves they are absent after the replayable grant expires.
async function cleanupExpiredUpload(session, user) {
  const stale = await atomic(async () => {
    await lockWorkspace(session.workspace);
    await assertActiveSession(session, user);
    const row = await db
      .prepare(
        "SELECT * FROM uploads WHERE workspace=? AND backend='supabase' AND status IN ('pending','verifying','failed','purging') AND created_at<=? ORDER BY created_at LIMIT 1 FOR UPDATE",
      )
      .get(
        session.workspace,
        new Date(Date.now() - UPLOAD_GRANT_DRAIN_MS).toISOString(),
      );
    if (!row) return null;
    await db
      .prepare("UPDATE uploads SET status='purging' WHERE id=?")
      .run(row.id);
    return row;
  });
  if (!stale) return { cleaned: 0 };
  for (const path of new Set(
    [stale.filename, stale.final_path].filter(Boolean),
  ))
    await deleteEvidenceObject({ backend: "supabase", path });
  await atomic(async () => {
    await lockWorkspace(session.workspace);
    await assertActiveSession(session, user);
    await db
      .prepare("DELETE FROM uploads WHERE id=? AND status='purging'")
      .run(stale.id);
  });
  return { cleaned: 1 };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${directUploads ? storageStatus(env).origin || "" : ""}; frame-src 'self' blob: ${directUploads ? storageStatus(env).origin || "" : ""}; connect-src 'self' ${directUploads ? storageStatus(env).origin || "" : ""}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  );
  if (production)
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  try {
    const url = new URL(req.url, origin);
    const path = url.pathname;
    if (!["GET", "POST"].includes(req.method)) fail(405, "Method not allowed.");
    if (path === "/api/config" && req.method === "GET") {
      const current = await currentSession(req);
      const state = production
        ? await stateOf("chapter")
        : current
          ? await stateOf(current.workspace)
          : {};
      return json(res, 200, {
        mode,
        providers: authMode === "chapter" ? [] : identityProviders(env),
        chapterAuth: {
          enabled: authMode === "chapter",
          configured: chapterAuthConfigured(env) && chairAccountConfigured(env),
          emailReady: chapterEmailReady,
        },
        canvasConfigured: canvasConfigured(),
        uploadMode: directUploads ? "direct" : "local",
        semester: semesterSettings(state),
      });
    }
    if (production && path.startsWith("/api/demo/")) fail(404, "Not found.");
    if (production && authMode === "chapter" && path === "/api/auth/login" && req.method === "POST") {
      requireOrigin(req);
      if (!chapterAuthConfigured(env) || !chairAccountConfigured(env)) fail(503, "Chapter sign-in is not ready.");
      const input = await readBody(req);
      const identifier = typeof input.identifier === "string" ? input.identifier.trim() : "";
      const password = typeof input.password === "string" ? input.password : "";
      if (!identifier || identifier.length > 254 || !password || password.length > 1024)
        fail(422, "Enter your email or member ID and password.");
      const candidate = await accountForIdentifier(identifier);
      const attemptKey = candidate?.id || identifier.toLowerCase();
      await authAttempt("login_attempt", attemptKey, 10);
      const bootstrapEmail = env.CHAIR_ACCOUNT_EMAIL?.trim().toLowerCase();
      const email = candidate?.email ||
        (identifier.toLowerCase() === bootstrapEmail ? bootstrapEmail :
          `${sha(identifier).slice(0, 24)}@invalid.example`);
      const authVersion = candidate ? await authMutationVersion(db, "chapter", candidate.id) : null;
      const isChairLogin = candidate?.role === "chair" || email === bootstrapEmail;
      const bootstrapFenceId = `supabase:${env.CHAIR_AUTH_USER_ID}`;
      const bootstrapVersion = isChairLogin ? await authMutationVersion(db, "chapter", bootstrapFenceId) : null;
      const verified = await verifyPassword(env, email, password);
      if (!verified || verified.email !== email)
        fail(401, "Invalid sign-in details.");
      const issued = await atomic(async () => {
        await lockWorkspace("chapter");
        let binding = await identityMember("chapter", "supabase", verified.id);
        // A first-login lookup cannot skip the account's mutation epoch after
        // another request bootstraps it. Retry against the now-existing member.
        if (!candidate && binding) fail(401, "Account setup changed during sign-in. Sign in again.");
        if (
          !binding && !candidate &&
          equal(env.CHAIR_AUTH_USER_ID, verified.id) &&
          equal(env.CHAIR_ACCOUNT_EMAIL?.trim().toLowerCase(), verified.email) &&
          !(await db.prepare("SELECT id FROM members WHERE workspace='chapter' AND role='chair'").get())
        ) {
          const id = randomUUID();
          await insertMember("chapter", {
            id,
            name: "Scholarship Chair Office",
            email: verified.email,
            role: "chair",
          });
          await db.prepare("INSERT INTO identities VALUES (?,?,?,?)")
            .run("chapter", "supabase", verified.id, id);
          await audit("chapter", "system", "chair.bootstrap", id, "Dedicated office account bound to exact Supabase Auth user ID.");
          binding = { member_id: id };
        }
        const user = binding && await member("chapter", binding.member_id);
        if (!user?.active || (candidate && candidate.id !== user.id) || user.email !== verified.email)
          fail(401, "Invalid sign-in details.");
        if (candidate) await assertAuthMutationVersion(db, "chapter", user.id, authVersion);
        if (isChairLogin) await assertAuthMutationVersion(db, "chapter", bootstrapFenceId, bootstrapVersion);
        // A prior deployment may have left a short-lived pending enrollment.
        // Retire it locally; existing provider factors are left unchanged.
        await db.prepare("DELETE FROM transactions WHERE kind='chair_mfa_pending' AND session_id=?").run(user.id);
        await audit("chapter", user.name, "session.login", user.id, "chapter");
        return { ...await issueSession("chapter", user.id, (await currentSession(req))?.id), user };
      });
      if (issued.user.role === "member") {
        try {
          let state = await stateOf("chapter");
          if (!pilotEligible(state, issued.user) && rosterView(state).required && !rosterView(state).fresh)
            state = await refreshRoster(issued.session, issued.user);
          assertRosterEligibility(state, issued.user);
          issued.recoveryKey = await atomic(async () => {
            await lockWorkspace("chapter");
            await assertActiveSession(issued.session, issued.user);
            return issueSemesterRecoveryKey(db, "chapter", issued.user.id,
              (await stateOf("chapter")).semesterGeneration || "initial");
          });
        } catch (error) {
          await db.prepare("DELETE FROM sessions WHERE id=?").run(issued.session.id);
          throw error;
        }
      }
      await clearAuthAttempts("login_attempt", attemptKey);
      return json(res, 200,
        { ...await sessionPayload(issued.session, await member("chapter", issued.session.member_id)),
          ...(issued.recoveryKey ? { recoveryKey: issued.recoveryKey } : {}) },
        { "Set-Cookie": [issued.cookie, cookie(legacyMfaCookie, "", 0)] });
    }
    if (path === "/api/auth/mfa" || path.startsWith("/api/auth/mfa/"))
      fail(404, "Endpoint not found.");
    if (production && authMode === "chapter" && path === "/api/auth/request-reset" && req.method === "POST") {
      requireOrigin(req);
      if (!chapterAuthConfigured(env) || !chairAccountConfigured(env)) fail(503, "Chapter sign-in is not ready.");
      if (!chapterEmailReady) fail(503, "Email resets are not available yet. Members can use their recovery key; the Chair must contact the portal administrator.");
      const input = await readBody(req);
      const identifier = typeof input.identifier === "string" ? input.identifier.trim() : "";
      if (!identifier || identifier.length > 254) fail(422, "Enter your email or member ID.");
      const candidate = await accountForIdentifier(identifier);
      await authAttempt("reset_attempt", candidate?.id || identifier.toLowerCase(), 3);
      const linked = candidate && await db
        .prepare("SELECT subject FROM identities WHERE workspace=? AND provider=? AND member_id=?")
        .get("chapter", "supabase", candidate.id);
      if (candidate?.active && linked && !candidate.email.endsWith("@pilot.invalid")) {
        try {
          await sendPasswordReset(env, candidate.email, `${origin}/account/reset`);
        } catch {
          // Public reset requests never reveal account presence or mail status.
        }
      }
      return json(res, 200, { message: "If the account is active, a reset link will be sent." });
    }
    if (production && authMode === "chapter" && path === "/api/auth/recover-key" && req.method === "POST") {
      requireOrigin(req);
      if (!chapterAuthConfigured(env) || !chairAccountConfigured(env)) fail(503, "Chapter sign-in is not ready.");
      const input = await readBody(req);
      const identifier = typeof input.identifier === "string" ? input.identifier.trim() : "";
      const recoveryKey = typeof input.recoveryKey === "string" ? input.recoveryKey : "";
      const password = typeof input.password === "string" ? input.password : "";
      if (!identifier || identifier.length > 254 || recoveryKey.length > 256 ||
          password.length < 12 || password.length > 1024)
        fail(422, "Enter your member ID, 16-word recovery key, and a new password of at least 12 characters.");
      const candidate = await accountForIdentifier(identifier);
      await authAttempt("recovery_attempt", candidate?.id || identifier.toLowerCase(), 5);
      const linked = candidate?.active && candidate.role === "member" && await db
        .prepare("SELECT subject FROM identities WHERE workspace=? AND provider=? AND member_id=?")
        .get("chapter", "supabase", candidate.id);
      if (!linked) fail(401, "The account or recovery key was not recognized.");
      const reservation = await atomic(async () => {
        await lockWorkspace("chapter");
        const current = await member("chapter", candidate.id);
        if (!current?.active || current.role !== "member")
          fail(401, "The account or recovery key was not recognized.");
        const generation = (await stateOf("chapter")).semesterGeneration || "initial";
        const mutationEpoch = await beginAuthMutation(db, "chapter", current.id);
        const result = await beginRecovery(db, "chapter", current.id, generation, recoveryKey);
        if (!result) fail(401, "The account or recovery key was not recognized.");
        await audit("chapter", current.name, "account.recovery.started", current.id);
        return {token:result, mutationEpoch};
      });
      try {
        await setPasswordByAdmin(env, linked.subject, password);
      } catch {
        await atomic(async () => {
          await lockWorkspace("chapter");
          await cancelRecovery(db, "chapter", candidate.id, reservation.token);
          // Keep the mutation fence while an ambiguous provider request settles.
        });
        fail(503, "The password update could not be confirmed. This recovery key has been retired. Wait two minutes, then try signing in with your new password, then your previous password, or request an email reset.");
      }
      await atomic(async () => {
        await lockWorkspace("chapter");
        const generation = (await stateOf("chapter")).semesterGeneration || "initial";
        await finishRecovery(db, "chapter", candidate.id, generation, reservation.token);
        await finishAuthMutation(db, "chapter", candidate.id, reservation.mutationEpoch);
        await audit("chapter", candidate.name, "account.recovery.complete", candidate.id,
          "Password changed; portal sessions revoked; recovery key consumed.");
      });
      await clearAuthAttempts("recovery_attempt", candidate.id);
      return json(res, 200, {
        message: "Password changed. Sign in with your new password to save a new recovery key.",
      }, { "Set-Cookie": cookie(sessionCookie, "", 0) });
    }
    if (production && authMode === "chapter" && path === "/api/auth/complete" && req.method === "POST") {
      requireOrigin(req);
      if (!chapterAuthConfigured(env) || !chairAccountConfigured(env)) fail(503, "Chapter sign-in is not ready.");
      const input = await readBody(req);
      if (typeof input.accessToken !== "string" || input.accessToken.length > 8192 ||
          typeof input.password !== "string" || input.password.length < 12 || input.password.length > 1024)
        fail(422, "Choose a password of at least 12 characters.");
      const account = await userForAccountToken(env, input.accessToken);
      if (!account) fail(401, "This account link has expired. Request a new one.");
      const binding = await identityMember("chapter", "supabase", account.id);
      const user = binding && await member("chapter", binding.member_id);
      if ((!user?.active || user.email !== account.email) &&
          !(equal(env.CHAIR_AUTH_USER_ID, account.id) &&
            equal(env.CHAIR_ACCOUNT_EMAIL?.trim().toLowerCase(), account.email)))
        fail(403, "This account is not approved for the portal.");
      const isConfiguredChair = equal(env.CHAIR_AUTH_USER_ID, account.id) &&
        equal(env.CHAIR_ACCOUNT_EMAIL?.trim().toLowerCase(), account.email);
      const bootstrapFenceId = `supabase:${env.CHAIR_AUTH_USER_ID}`;
      const mutation = await atomic(async () => {
        await lockWorkspace("chapter");
        // Bootstrap login may have bound the office account while the token was
        // being verified. Re-read the binding under the same lock as sign-in.
        const currentBinding = await identityMember("chapter", "supabase", account.id);
        const currentUser = currentBinding && await member("chapter", currentBinding.member_id);
        if (currentUser ? (!currentUser.active || currentUser.email !== account.email) : !isConfiguredChair)
          fail(403, "This account is not approved for the portal.");
        const bootstrapEpoch = isConfiguredChair ? await beginAuthMutation(db, "chapter", bootstrapFenceId) : null;
        const epoch = currentUser ? await beginAuthMutation(db, "chapter", currentUser.id) : null;
        if (currentUser) {
          await audit("chapter", currentUser.name, "account.password_change", currentUser.id,
            "Existing portal sessions and recovery key revoked before password update.");
          if (currentUser.role === "member") await clearRecoveryKey(db, "chapter", currentUser.id);
        }
        return { userId: currentUser?.id, epoch, bootstrapEpoch };
      });
      try {
        // A legacy provider factor can prevent an AAL1 recovery token from
        // updating its own password. The token and exact active portal identity
        // have already been verified above; update only that identity without
        // changing its provider factors or granting a portal session.
        if (account.hasVerifiedFactors) await setPasswordByAdmin(env, account.id, input.password);
        else if (!(await setPasswordWithToken(env, input.accessToken, input.password, account.id))) throw Error('Unconfirmed password update');
      } catch {
        fail(503, "Password update could not be confirmed. Wait two minutes, then try signing in with your new password or request a new reset link.");
      }
      await atomic(async () => {
        await lockWorkspace("chapter");
        if (mutation.epoch) await finishAuthMutation(db, "chapter", mutation.userId, mutation.epoch);
        if (mutation.bootstrapEpoch) await finishAuthMutation(db, "chapter", bootstrapFenceId, mutation.bootstrapEpoch);
      });
      return json(res, 200, { message: "Password set. Sign in to continue." });
    }
    if (path === "/api/demo/session" && req.method === "POST" && !production) {
      requireOrigin(req);
      if (req.headers["x-ato-demo"] !== "1")
        fail(403, "The demo request header is required.");
      const input = await readBody(req);
      let session = await currentSession(req);
      if (session) csrf(req, session);
      const persona = input.persona || session?.member_id || "alex";
      if (!demoMembers.some((m) => m.id === persona))
        fail(422, "Unknown demo persona.");
      await cleanup();
      let workspace = session?.workspace;
      const issued = await atomic(async () => {
        if (!workspace) {
          workspace = `demo-${randomUUID()}`;
          await db
            .prepare("INSERT INTO chapters VALUES (?,?)")
            .run(workspace, JSON.stringify(seed()));
          for (const m of demoMembers) await insertMember(workspace, m);
        }
        return await issueSession(workspace, persona, session?.id);
      });
      return json(
        res,
        200,
        await sessionPayload(issued.session, await member(workspace, persona)),
        { "Set-Cookie": issued.cookie },
      );
    }

    const identityRoute = path.match(
      /^\/auth\/(microsoft|google)(\/callback)?$/,
    );
    if (identityRoute && req.method === "GET") {
      if (identityRoute[1] !== "microsoft" || authMode !== "microsoft") fail(404, "Not found.");
      if (!production)
        fail(
          403,
          "Organization sign-in is disabled in the isolated demonstration.",
        );
      const provider = identityRoute[1];
      const redirectUri = `${origin}/auth/${provider}/callback`;
      if (!identityRoute[2]) {
        await cleanup();
        const flow = startIdentityFlow(provider, { env, redirectUri });
        const browserToken = token();
        await db
          .prepare("INSERT INTO transactions VALUES (?,?,?,?,?)")
          .run(
            sha(browserToken),
            "identity",
            null,
            JSON.stringify(flow.transaction),
            Date.now() + 600_000,
          );
        return redirect(res, flow.url, {
          "Set-Cookie": cookie(identityCookie, browserToken, 600),
        });
      }
      const browserToken = getCookie(req, identityCookie);
      const txn =
        browserToken &&
        (await db
          .prepare(
            "DELETE FROM transactions WHERE id=? AND kind=? AND expires>? RETURNING *",
          )
          .get(sha(browserToken), "identity", Date.now()));
      res.setHeader("Set-Cookie", cookie(identityCookie, "", 0));
      if (!txn || JSON.parse(txn.data).provider !== provider)
        fail(400, "Sign-in expired. Please start again.");
      const identity = await completeIdentityFlow({
        transaction: JSON.parse(txn.data),
        callbackUrl: url.href,
        env,
        redirectUri,
      });
      const issued = await atomic(async () => {
        await lockWorkspace("chapter");
        let binding = await db
          .prepare(
            "SELECT member_id FROM identities WHERE workspace=? AND provider=? AND subject=?",
          )
          .get("chapter", identity.provider, identity.subject);
        if (
          !binding &&
          env.BOOTSTRAP_PROVIDER === identity.provider &&
          equal(env.BOOTSTRAP_SUBJECT, identity.subject) &&
          !(await db
            .prepare(
              "SELECT id FROM members WHERE workspace='chapter' AND role='chair'",
            )
            .get())
        ) {
          const id = randomUUID();
          await insertMember("chapter", {
            id,
            name: env.BOOTSTRAP_NAME?.trim().slice(0, 100) || identity.name,
            email: env.BOOTSTRAP_EMAIL?.trim().slice(0, 254) || identity.email,
            role: "chair",
          });
          await db
            .prepare("INSERT INTO identities VALUES (?,?,?,?)")
            .run("chapter", identity.provider, identity.subject, id);
          await audit(
            "chapter",
            identity.name,
            "chair.bootstrap",
            id,
            "Created from explicitly configured provider and stable subject.",
          );
          binding = { member_id: id };
        }
        const user = binding && (await member("chapter", binding.member_id));
        if (!user?.active)
          fail(
            403,
            "Your verified account is not on the active chapter roster. Ask the Scholarship Chair to add its stable identity.",
          );
        await audit(
          "chapter",
          user.name,
          "session.login",
          user.id,
          identity.provider,
        );
        return await issueSession(
          "chapter",
          user.id,
          (await currentSession(req))?.id,
        );
      });
      return redirect(res, "/", {
        "Set-Cookie": [cookie(identityCookie, "", 0), issued.cookie],
      });
    }

    if (path.startsWith("/auth/canvas") || path.startsWith("/api/")) {
      let { session, user } = await requireSession(req);
      const requestGeneration =
        (await stateOf(session.workspace)).semesterGeneration || null;
      if (req.method === "POST") csrf(req, session);
      const input =
        req.method === "POST"
          ? await readBody(
              req,
              !directUploads && path === "/api/uploads" ? 7_100_000 : 262_144,
            )
          : null;
      // Re-read after request-body or network waits so deactivation and session rotation win.
      ({ session, user } = await requireSession(req));
      if (
        req.headers["x-ato-expected-user"] &&
        req.headers["x-ato-expected-user"] !== user.id
      )
        fail(
          409,
          "The account changed in another tab. Refresh before continuing.",
        );
      if (path === "/api/account/password" && req.method === "POST") {
        if (!production || authMode !== "chapter") fail(422, "Password changes require a real chapter account.");
        if (typeof input.currentPassword !== "string" || !input.currentPassword || input.currentPassword.length > 1024 ||
            typeof input.newPassword !== "string" || input.newPassword.length < 12 || input.newPassword.length > 1024 ||
            input.newPassword !== input.confirmPassword)
          fail(422, "Enter your current password and matching new passwords of at least 12 characters.");
        if (input.currentPassword === input.newPassword) fail(422, "Choose a different new password.");
        await authAttempt("password_change", user.id, 5);
        const identity = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const linked = await identityMember(session.workspace, "supabase",
            (await verifyPassword(env, user.email, input.currentPassword))?.id || "");
          if (linked?.member_id !== user.id) fail(401, "The current password is incorrect.");
          const identity = await db.prepare("SELECT subject FROM identities WHERE workspace=? AND provider='supabase' AND member_id=?")
            .get(session.workspace, user.id);
          const mutationEpoch = await beginAuthMutation(db, session.workspace, user.id);
          if (user.role === "member") await clearRecoveryKey(db, session.workspace, user.id);
          await audit(session.workspace, user.name, "account.password_change", user.id, "Current password verified; sessions and recovery key revoked before provider update.");
          return {...identity, mutationEpoch};
        });
        try { await setPasswordByAdmin(env, identity.subject, input.newPassword); }
        catch {
          fail(503, "The password update could not be confirmed. You have been signed out. Wait two minutes, then try signing in with your new password, then your previous password.");
        }
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await finishAuthMutation(db, session.workspace, user.id, identity.mutationEpoch);
        });
        await clearAuthAttempts("password_change", user.id);
        return json(res, 200, { message: "Password changed. Sign in with your new password." }, { "Set-Cookie": cookie(sessionCookie, "", 0) });
      }
      if (path === "/api/account/recovery-key/confirm" && req.method === "POST") {
        individual(user);
        if (!production || authMode !== "chapter") fail(422, "Recovery keys require a real chapter account.");
        const result = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const generation = (await stateOf(session.workspace)).semesterGeneration || "initial";
          return confirmRecoveryKey(db, session.workspace, user.id, generation, input.recoveryKey);
        });
        return json(res, 200, result);
      }
      if (path === "/api/account/recovery-key" && req.method === "POST") {
        individual(user);
        if (!production || authMode !== "chapter") fail(422, "Recovery keys require a real chapter account.");
        await authAttempt("recovery_issue", user.id, 5);
        const key = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const generation = (await stateOf(session.workspace)).semesterGeneration || "initial";
          if (!(await recoveryKeyStatus(db, session.workspace, user.id, generation)).needsKey) {
            if (typeof input.currentPassword !== "string" || input.currentPassword.length > 1024)
              fail(422, "Enter your current password to replace your saved recovery key.");
            const linked = await identityMember(session.workspace, "supabase",
              (await verifyPassword(env, user.email, input.currentPassword))?.id || "");
            if (linked?.member_id !== user.id) fail(401, "The current password is incorrect.");
          }
          const replacement = await issueSemesterRecoveryKey(db, session.workspace, user.id, generation, { replace: true });
          await audit(session.workspace, user.name, "account.recovery.reissued", user.id, "New key awaiting member confirmation.");
          return replacement;
        });
        return json(res, 200, { recoveryKey: key });
      }
      if (path === "/api/session" && req.method === "GET")
        return json(res, 200, await sessionPayload(session, user));
      if (path === "/api/me" && req.method === "GET")
        return json(res, 200, { user, mode, today: policyDay() });
      if (path === "/api/admin/roster-sync") {
        chair(user);
        const state =
          req.method === "POST"
            ? await refreshRoster(session, user, true)
            : await stateOf(session.workspace);
        const view = rosterView(state);
        if (view.mode === "public_email_csv" && view.fresh) {
          const enrolled = new Map((await listMembers(session.workspace))
            .filter((entry) => entry.role === "member")
            .map((entry) => [entry.email.toLowerCase(), entry]));
          const linked = new Set((await db.prepare(
            "SELECT member_id FROM identities WHERE workspace=? AND provider='supabase'",
          ).all(session.workspace)).map((entry) => entry.member_id));
          view.candidates = state.roster.directory.map((entry) => {
            const account = enrolled.get(entry.email);
            const invitation = invitationView(state.invitations?.[entry.email]);
            return {
              ...entry,
              accountId: account?.id || null,
              assignedTier: entry.membership === "new_member" ? 1 :
                account?.tier ?? state.tierAssignments?.[entry.email] ?? null,
              accountStatus: !account ? "not_invited" : !account.active ? "inactive" :
                !linked.has(account.id) ? "missing_sign_in" : invitation?.status === "ready" ? "account_ready" : "invited",
              invitation,
            };
          });
        }
        return json(res, 200, view);
      }
      if (path === "/api/semester" && req.method === "GET") {
        const state = await stateOf(session.workspace);
        return json(res, 200, {
          semester: semesterSettings(state),
          reset: semesterResetStatus(state),
        });
      }
      if (path === "/api/semester/preview" && req.method === "GET") {
        chair(user);
        return json(
          res,
          200,
          await previewSemesterReset({
            db,
            workspace: session.workspace,
            authorize: () => assertActiveSession(session, user),
          }),
        );
      }
      if (path === "/api/semester/reset" && req.method === "POST") {
        chair(user);
        const reset = await startSemesterReset({
          db,
          workspace: session.workspace,
          actor: user.name,
          confirm: input.confirm,
          semester: input.semester,
          previewToken: input.previewToken,
          authorize: () => assertActiveSession(session, user),
        });
        return json(res, 200, {
          reset,
          semester: semesterSettings(await stateOf(session.workspace)),
        });
      }
      if (path === "/api/semester/reset/resume" && req.method === "POST") {
        chair(user);
        const reset = await resumeSemesterReset({
          db,
          workspace: session.workspace,
          deleteObject: deleteEvidenceObject,
          authorize: () => assertActiveSession(session, user),
        });
        return json(res, 200, {
          reset,
          semester: semesterSettings(await stateOf(session.workspace)),
        });
      }
      if (path === "/api/uploads/cleanup" && req.method === "POST") {
        chair(user);
        return json(res, 200, await cleanupExpiredUpload(session, user));
      }
      if (path === "/api/logout" && req.method === "POST") {
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user, false);
          await db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
          await db
            .prepare("DELETE FROM transactions WHERE session_id=?")
            .run(session.id);
          await audit(session.workspace, user.name, "session.logout", user.id);
        });
        return json(
          res,
          200,
          { loggedOut: true },
          { "Set-Cookie": cookie(sessionCookie, "", 0) },
        );
      }
      if (path === "/api/rules" && req.method === "GET") {
        const state = await stateOf(session.workspace);
        return json(res, 200, {
          categoryVersion: categoryView(state).version,
          activities: categoriesFor(state).map((a) => ({
            ...a,
            proof: production ? a.proof.replaceAll("sample ", "") : a.proof,
          })),
          today: policyDay(),
          submissionWindowDays: 14,
          weeklyStudyHours: 5,
          weeklyMinorAssignments: categoriesFor(state).find(category => category.id === "minor")?.weeklyLimit ?? null,
          weekConvention:
            "Monday–Sunday, America/New_York (portal convention; policy must confirm)",
          rounding: "Chair must enter whole points and explain any difference.",
          tierSource:
            "Page 5 GPA ranges; Chair assigns tiers. New members use Tier 1.",
          checkpoints: semesterCheckpoints(state),
          semester: semesterSettings(state),
        });
      }
      if (path === "/api/credit-requests" && req.method === "GET") {
        const state = await stateOf(session.workspace);
        return json(res, 200, { credits: user.credits, requests: (state.creditRequests || []).filter(item => user.role === "chair" || item.owner === user.id).map(creditSummary) });
      }
      if (path === "/api/credit-requests" && req.method === "POST") {
        individual(user);
        fail(410, "Add credit hours to each class in My profile. The Scholarship Chair approves the class and its hours together.");
      }
      const creditRoute = path.match(/^\/api\/credit-requests\/([a-f0-9-]{36})\/(evidence|review)$/);
      if (creditRoute && req.method === "GET" && creditRoute[2] === "evidence") {
        const item = (await stateOf(session.workspace)).creditRequests?.find(item => item.id === creditRoute[1]);
        if (!item || (user.role !== "chair" && item.owner !== user.id)) fail(404, "Request not found.");
        const upload = await getUpload(item.evidenceId, session, user);
        return json(res, 200, { image: `/api/uploads/${upload.id}/preview` });
      }
      if (creditRoute && req.method === "POST" && creditRoute[2] === "review") {
        chair(user);
        fail(410, "Credit hours are now reviewed with each class. Use Classes to approve enrolled hours.");
      }
      if (path === "/api/profile/picture" && ["GET", "POST"].includes(req.method)) {
        individual(user);
        if (req.method === "GET") {
          const id = (await stateOf(session.workspace)).profilePictures?.[user.id];
          return json(res, 200, { image: id ? `/api/uploads/${id}/preview` : null });
        }
        const image = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const state = await stateOf(session.workspace);
          academicGuard(state, requestGeneration);
          let id = null;
          if (input.evidenceId !== null) {
            const upload = await getUpload(input.evidenceId, session, user, true);
            if (!["image/png", "image/jpeg"].includes(upload.mime)) fail(422, "Choose a PNG or JPEG profile picture.");
            id = upload.id;
          }
          state.profilePictures ||= {};
          if (id) state.profilePictures[user.id] = id;
          else delete state.profilePictures[user.id];
          await db.prepare("UPDATE chapters SET data=? WHERE workspace=?").run(JSON.stringify(state), session.workspace);
          return id ? `/api/uploads/${id}/preview` : null;
        });
        return json(res, 200, { image });
      }
      if (path === "/api/point-categories" && ["GET", "POST"].includes(req.method)) {
        chair(user);
        if (req.method === "GET") return json(res, 200, categoryView(await stateOf(session.workspace)));
        const updated = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const state = await stateOf(session.workspace);
          academicGuard(state, requestGeneration);
          const result = applyCategoryChange(state, input, () => `activity-${randomUUID()}`);
          await db.prepare("UPDATE chapters SET data=? WHERE workspace=?").run(JSON.stringify(state), session.workspace);
          const category = input.category.id ? result.categories.find(item => item.id === input.category.id) : result.categories.at(-1);
          await audit(session.workspace, user.name, "categories.update", category.id, JSON.stringify({ name: category.name, enabled: category.enabled, mode: category.mode }));
          return result;
        });
        return json(res, 200, updated);
      }
      if (path === "/api/checkpoint-quotas" && ["GET", "POST"].includes(req.method)) {
        chair(user);
        const view = (state) => ({ ...checkpointQuotaView(state), checkpoints: semesterCheckpoints(state) });
        if (req.method === "GET") return json(res, 200, view(await stateOf(session.workspace)));
        if (!input || Object.keys(input).sort().join(",") !== "targets,version" || typeof input.version !== "string")
          fail(422, "Submit the checkpoint quotas and their current version.");
        const targets = validateCheckpointQuotas(input.targets);
        const updated = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const state = await stateOf(session.workspace);
          academicGuard(state, requestGeneration);
          if (input.version !== checkpointQuotaView(state).version)
            fail(409, "The checkpoint quotas or semester changed. Reload them before saving.");
          state.checkpointQuotas = targets;
          state.checkpointQuotaRevision = (state.checkpointQuotaRevision || 0) + 1;
          await db.prepare("UPDATE chapters SET data=? WHERE workspace=?").run(JSON.stringify(state), session.workspace);
          await audit(session.workspace, user.name, "checkpoints.update", "", JSON.stringify({ targets }));
          return view(state);
        });
        return json(res, 200, updated);
      }
      if (path === "/api/classes" && req.method === "GET") {
        individual(user);
        return json(res, 200, classView(await stateOf(session.workspace), user.id, user.credits));
      }
      if (path === "/api/classes" && req.method === "POST") {
        individual(user);
        const name = classInput(input), credits = classCredits(input);
        const generation = await academicSnapshot(session, requestGeneration);
        const updated = await mutate(session, user, async state => {
          academicGuard(state, generation);
          const upload = await getUpload(input.evidenceId, session, user, true);
          if (!["application/pdf", "image/png", "image/jpeg"].includes(upload.mime)) fail(422, "Upload a PDF, PNG or JPEG syllabus.");
          state.classRecords ||= [];
          state.syllabi ||= [];
          let course = input.classId && state.classRecords.find(row => row.id === input.classId && row.owner === user.id && !row.archived);
          if (input.classId && !course) fail(404, "Class not found.");
          if (course?.pendingRemoval) fail(409, "This class has a removal request awaiting Chair review.");
          if (course && course.version !== input.version) fail(409, "This class changed. Reload it before replacing the syllabus.");
          if (state.classRecords.some(row => row.owner === user.id && !row.archived && row.id !== course?.id && row.name.toLowerCase() === name.toLowerCase()))
            fail(422, "This class already exists. Replace its syllabus instead.");
          const visibleClasses = classView(state, user.id).classes;
          const legacy = visibleClasses.find(row => row.id === null && row.name.toLowerCase() === name.toLowerCase());
          const upgradingLegacy = !!legacy;
          if (legacy && input.version !== undefined && input.version !== legacy.version) fail(409, "Your classes changed. Reload before uploading.");
          if (!course && !upgradingLegacy && visibleClasses.length >= 20) fail(422, "You can have up to 20 active classes.");
          if (!course) {
            course = { id: randomUUID(), owner: user.id, name, archived: false, createdAt: now() };
            state.classRecords.push(course);
          }
          const syllabus = { id: randomUUID(), classId: course.id, className: name, owner: user.id, evidenceId: upload.id,
            credits, fileName: upload.name, mime: upload.mime, status: "pending", version: randomUUID(), reviewNote: "", createdAt: now(), reviewedAt: null, reviewer: null };
          state.syllabi.push(syllabus);
          Object.assign(course, { name, syllabusId: syllabus.id, version: randomUUID(), updatedAt: now() });
          state.memberProfiles ||= {};
          const profile = state.memberProfiles[user.id] ||= { courses: [] };
          profile.version = randomUUID();
          // Remove an upgraded legacy string; the stable class record is authoritative.
          profile.courses = (profile.courses || []).filter(value => value.toLowerCase() !== name.toLowerCase());
          await audit(session.workspace, user.name, "syllabus.upload", syllabus.id, course.id);
          const view = classView(state, user.id, (await member(session.workspace, user.id)).credits);
          return { class: view.classes.find(row => row.id === course.id), ...view };
        });
        return json(res, 201, updated);
      }
      const archiveClass = path.match(/^\/api\/classes\/([^/]+)\/archive$/);
      if (archiveClass && req.method === "POST") {
        individual(user);
        const result = await mutate(session, user, async state => {
          academicGuard(state, requestGeneration);
          if (archiveClass[1] === "legacy") {
            const name = classInput(input);
            const legacy = classView(state, user.id).classes.find(row => row.id === null && row.name === name);
            if (!legacy) fail(404, "Legacy class not found. Reload your classes.");
            if (input.version !== legacy.version) fail(409, "Your classes changed. Reload them before removing this class.");
            const profile = state.memberProfiles[user.id];
            profile.courses = profile.courses.filter(value => value !== name);
            profile.version = randomUUID();
            await audit(session.workspace, user.name, "class.archive", "legacy");
            return classView(state, user.id, (await member(session.workspace, user.id)).credits);
          }
          const course = (state.classRecords || []).find(row => row.id === archiveClass[1] && row.owner === user.id && !row.archived);
          if (!course) fail(404, "Class not found.");
          if (input.version !== course.version) fail(409, "This class changed. Reload it before archiving.");
          if (course.pendingRemoval) fail(409, "This class already has a removal request awaiting Chair review.");
          if (course.approvedCredits !== undefined && course.approvedCredits !== null)
            course.pendingRemoval = { version: randomUUID(), createdAt: now() };
          else course.archived = true;
          Object.assign(course, { version: randomUUID(), updatedAt: now() });
          state.memberProfiles ||= {};
          (state.memberProfiles[user.id] ||= { courses: [] }).version = randomUUID();
          await audit(session.workspace, user.name, course.pendingRemoval ? "class.removal_request" : "class.archive", course.id);
          return classView(state, user.id, (await member(session.workspace, user.id)).credits);
        });
        return json(res, 200, result);
      }
      const removalReview = path.match(/^\/api\/classes\/([^/]+)\/removal-review$/);
      if (removalReview && req.method === "POST") {
        chair(user);
        const note = typeof input.note === "string" ? input.note.trim() : "";
        if (!["approved", "denied"].includes(input.decision) || note.length > 1000 || (input.decision === "denied" && note.length < 5))
          fail(422, "Approve the removal or deny it with a reason of at least 5 characters.");
        const result = await mutate(session, user, async state => {
          academicGuard(state, requestGeneration);
          const course = (state.classRecords || []).find(row => row.id === removalReview[1] && !row.archived);
          if (!course?.pendingRemoval || course.pendingRemoval.version !== input.version)
            fail(409, "This removal changed or was already reviewed. Reload the list.");
          const target = await member(session.workspace, course.owner);
          if (!target?.active || target.role !== "member") fail(404, "Active member not found.");
          if (input.decision === "approved") {
            course.archived = true;
            const total = approvedClassCredits(state, course.owner);
            await db.prepare("UPDATE members SET credits=? WHERE workspace=? AND id=? AND role='member' AND active=1").run(total, session.workspace, course.owner);
            refreshPendingCreditEstimates(state, course.owner, multiplier({ credits: total }));
          }
          delete course.pendingRemoval;
          Object.assign(course, { version: randomUUID(), updatedAt: now(), removalReview: { decision: input.decision, note, reviewer: user.name, reviewedAt: now() } });
          state.memberProfiles ||= {};
          (state.memberProfiles[course.owner] ||= { courses: [] }).version = randomUUID();
          await audit(session.workspace, user.name, "class.removal_review", course.id, `${input.decision}; ${note}`);
          return { classId: course.id, decision: input.decision, ...classView(state, course.owner, (await member(session.workspace, course.owner)).credits) };
        });
        return json(res, 200, result);
      }
      if (path === "/api/syllabi" && req.method === "GET") {
        chair(user);
        const state = await stateOf(session.workspace);
        const owners = new Map((await listMembers(session.workspace, state)).map(row => [row.id, row]));
        return json(res, 200, { syllabi: (state.syllabi || [])
          .filter(row => syllabusView(state, row).current)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(row => ({ ...syllabusView(state, row, owners.get(row.owner)?.credits ?? null), memberName: owners.get(row.owner)?.name || "Former member" })),
          removals: (state.classRecords || []).filter(row => !row.archived && row.pendingRemoval)
            .map(row => ({ ...removalView(state, row, owners.get(row.owner)?.credits ?? null), memberName: owners.get(row.owner)?.name || "Former member" })) });
      }
      const syllabusRoute = path.match(/^\/api\/syllabi\/([^/]+)\/(evidence|review)$/);
      if (syllabusRoute) {
        const state = await stateOf(session.workspace);
        const item = (state.syllabi || []).find(row => row.id === syllabusRoute[1] && (user.role === "chair" || row.owner === user.id));
        if (!item) fail(404, "Syllabus not found.");
        if (syllabusRoute[2] === "evidence" && req.method === "GET") {
          const upload = await getUpload(item.evidenceId, session, user);
          await audit(session.workspace, user.name, "syllabus.view", item.id, user.role);
          return json(res, 200, { name: upload.name, mime: upload.mime, previewUrl: `/api/uploads/${upload.id}/preview`, downloadUrl: `/api/uploads/${upload.id}` });
        }
        if (syllabusRoute[2] === "review" && req.method === "POST") {
          chair(user);
          const note = typeof input.note === "string" ? input.note.trim() : "";
          if (!["approved", "denied"].includes(input.decision) || note.length > 1000 || (input.decision === "denied" && note.length < 5))
            fail(422, "Approve the syllabus or deny it with a reason of at least 5 characters.");
          const result = await mutate(session, user, async current => {
            academicGuard(current, requestGeneration);
            const syllabus = (current.syllabi || []).find(row => row.id === item.id);
            const course = (current.classRecords || []).find(row => row.id === syllabus?.classId && row.owner === syllabus.owner && !row.archived && row.syllabusId === syllabus.id);
            if (!syllabus || !course || course.pendingRemoval || syllabus.status !== "pending" || syllabus.version !== input.version)
              fail(409, "This syllabus changed or was already reviewed. Reload the list.");
            const target = await member(session.workspace, course.owner);
            if (!target?.active || target.role !== "member") fail(404, "Active member not found.");
            if (input.decision === "approved") {
              const total = approveClassCredits(current, course, syllabus.credits);
              await db.prepare("UPDATE members SET credits=? WHERE workspace=? AND id=? AND role='member' AND active=1").run(total, session.workspace, course.owner);
              refreshPendingCreditEstimates(current, course.owner, multiplier({ credits: total }));
            }
            Object.assign(syllabus, { status: input.decision, reviewNote: note, reviewedAt: now(), reviewer: user.name, version: randomUUID() });
            course.version = randomUUID();
            current.memberProfiles ||= {};
            (current.memberProfiles[course.owner] ||= { courses: [] }).version = randomUUID();
            await audit(session.workspace, user.name, "syllabus.review", syllabus.id, input.decision);
            return { syllabus: syllabusView(current, syllabus, input.decision === "approved" ? approvedClassCredits(current, course.owner) : target.credits) };
          });
          return json(res, 200, result);
        }
      }
      if (path === "/api/profile" && ["GET", "POST"].includes(req.method)) {
        individual(user);
        if (req.method === "POST") fail(422, "Add classes with a syllabus in My profile.");
        return json(res, 200, profileView(await stateOf(session.workspace), user.id));
      }
      if (path === "/api/faq" && req.method === "GET")
        return json(res, 200, faqView(await stateOf(session.workspace)));
      if (path === "/api/faq" && req.method === "POST") {
        chair(user);
        const change = validateFaqChange(input);
        const updated = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const state = await stateOf(session.workspace);
          const view = faqView(state);
          if (input.version !== view.version) fail(409, "The FAQ changed. Reload the page before saving.");
          state.faqEntries = applyFaqChange(view.entries, change, randomUUID);
          state.faqRevision = randomUUID();
          await db.prepare("UPDATE chapters SET data=? WHERE workspace=?").run(JSON.stringify(state), session.workspace);
          await audit(session.workspace, user.name, change.operation === "delete" ? "faq.delete" : change.entry.id ? "faq.update" : "faq.create", "", "Shared FAQ updated");
          return faqView(state);
        });
        return json(res, 200, updated);
      }
      if (path === "/api/integrations" && req.method === "GET")
        return json(res, 200, {
          providers: identityProviders(env),
          canvas: {
            configured: canvasConfigured(),
            connected: !!(await connection(session)),
          },
        });
      if (
        (path === "/auth/canvas" ||
          path === "/api/integrations/canvas/connect") &&
        req.method === "POST"
      ) {
        individual(user);
        if (!production)
          fail(
            403,
            "Real Canvas connections are disabled in the isolated demonstration.",
          );
        if (!canvasConfigured())
          fail(
            503,
            "Canvas is not configured. Contact the portal administrator.",
          );
        const flow = startCanvasFlow({
          env,
          redirectUri: `${origin}/auth/canvas/callback`,
        });
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const generation = await advanceCanvasGeneration(
            session.workspace,
            user.id,
          );
          await db
            .prepare(
              "INSERT INTO transactions VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,session_id=excluded.session_id,data=excluded.data,expires=excluded.expires",
            )
            .run(
              `canvas:${session.id}`,
              "canvas",
              session.id,
              JSON.stringify({ ...flow.transaction, generation }),
              Date.now() + 600_000,
            );
        });
        return json(res, 200, { url: flow.url });
      }
      if (path === "/auth/canvas/callback" && req.method === "GET") {
        individual(user);
        if (!production)
          fail(
            403,
            "Real Canvas connections are disabled in the isolated demonstration.",
          );
        const txn = await db
          .prepare(
            "DELETE FROM transactions WHERE id=? AND kind=? AND session_id=? AND expires>? RETURNING *",
          )
          .get(`canvas:${session.id}`, "canvas", session.id, Date.now());
        if (!txn) fail(400, "Canvas connection expired. Please start again.");
        const tokens = await completeCanvasFlow({
          transaction: JSON.parse(txn.data),
          callbackUrl: url.href,
          env,
          redirectUri: `${origin}/auth/canvas/callback`,
        });
        const fresh = await requireSession(req);
        if (fresh.session.id !== session.id)
          fail(401, "Your account session changed. Reconnect Canvas.");
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const current = await db
            .prepare(
              "SELECT generation FROM canvas_generations WHERE workspace=? AND member_id=? FOR UPDATE",
            )
            .get(session.workspace, user.id);
          if (current?.generation !== JSON.parse(txn.data).generation)
            fail(409, "Canvas connection changed. Start again.");
          await db
            .prepare(
              "INSERT INTO integrations VALUES (?,?,?,?) ON CONFLICT(workspace,member_id) DO UPDATE SET data=excluded.data,revision=excluded.revision",
            )
            .run(
              session.workspace,
              user.id,
              sealTokens(tokens, env),
              randomUUID(),
            );
          await audit(
            session.workspace,
            user.name,
            "canvas.connect",
            user.id,
            canvasStatus(env).origin,
          );
        });
        return redirect(res, "/?canvas=connected");
      }
      if (
        path === "/api/integrations/canvas/disconnect" &&
        req.method === "POST"
      ) {
        individual(user);
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          await db
            .prepare(
              "DELETE FROM integrations WHERE workspace=? AND member_id=?",
            )
            .run(session.workspace, user.id);
          await advanceCanvasGeneration(session.workspace, user.id);
          await audit(
            session.workspace,
            user.name,
            "canvas.disconnect",
            user.id,
            "Removed locally stored authorization.",
          );
        });
        return json(res, 200, {
          disconnected: true,
          note: "Stored credentials removed. You can also revoke the app in Canvas account settings.",
        });
      }
      if (
        path === "/api/integrations/canvas/assignments" &&
        req.method === "GET"
      ) {
        individual(user);
        const assignments = production
          ? (await liveAssignments(session, user)).assignments
          : sampleAssignments(await stateOf(session.workspace), user.id);
        await requireSession(req);
        const state = await stateOf(session.workspace);
        return json(res, 200, {
          mode: production ? "live" : "sample",
          providerConnected: production,
          assignments: assignments.map((a) => ({
            ...a,
            imported: state.submissions.some(
              (s) =>
                s.owner === user.id &&
                String(s.canvasCourseId) === String(a.course_id) &&
                String(s.canvasAssignmentId) === String(a.id) &&
                s.status !== "denied",
            ),
          })),
          note: production
            ? "Current posted grades fetched from your connected Canvas account. The Chair verifies category and policy eligibility."
            : "Fictional Canvas-shaped data. No university API has been contacted.",
        });
      }
      if (path === "/api/integrations/canvas/import" && req.method === "POST") {
        individual(user);
        if (
          input.confirm !== true ||
          !Array.isArray(input.items) ||
          input.items.length < 1 ||
          input.items.length > 10
        )
          fail(422, "Select up to ten assignments and confirm the categories.");
        const generation = await academicSnapshot(session, requestGeneration);
        const fetched = production
          ? await liveAssignments(session, user)
          : { assignments: canvasAssignments };
        const assignments = fetched.assignments;
        const result = await mutate(session, user, async (state, user) => {
          academicGuard(state, generation);
          if (
            production &&
            (await connection(session))?.revision !== fetched.revision
          )
            fail(
              409,
              "Canvas connection changed. Fetch current assignments again.",
            );
          const imported = [],
            skipped = [];
          for (const selected of input.items) {
            if (
              !selected ||
              !["major", "minor", "lab"].includes(selected.activity)
            )
              fail(
                422,
                "Choose major assignment, minor assignment or lab report.",
              );
            if (production && selected.courseId === undefined)
              fail(422, "A Canvas course ID is required.");
            const a = assignments.find(
              (a) =>
                String(a.id) === String(selected.assignmentId) &&
                (!production ||
                  String(a.course_id) === String(selected.courseId)),
            );
            if (!a)
              fail(
                422,
                "The selected assignment is not a posted grade in your connected account.",
              );
            if (
              state.submissions.some(
                (s) =>
                  s.owner === user.id &&
                  String(s.canvasCourseId) === String(a.course_id) &&
                  String(s.canvasAssignmentId) === String(a.id) &&
                  s.status !== "denied",
              )
            ) {
              skipped.push(a.id);
              continue;
            }
            const gradeDate = production
              ? new Intl.DateTimeFormat("en-CA", {
                  timeZone: "America/New_York",
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                }).format(new Date(a.submission.posted_at))
              : a.submission.graded_at.slice(0, 10);
            const value = claim(
              {
                title: a.name.slice(0, 120),
                classId: selected.classId,
                course: a.course.slice(0, 80),
                activity: selected.activity,
                date: gradeDate,
                grade: Math.min(
                  100,
                  (a.submission.score / a.points_possible) * 100,
                ),
                confirm: true,
                note: production
                  ? "Canvas grade release date used for the submission window; Chair must confirm the policy interpretation and category."
                  : "Imported from fictional Canvas sample.",
              },
              state,
              user,
              production ? "canvas" : "sample",
            );
            const item = newSubmission(value, user, {
              source: production ? "canvas" : "canvas-sample",
              canvasCourseId: a.course_id,
              canvasAssignmentId: a.id,
              provenance: {
                provider: "canvas",
                sourceMode: production ? "live" : "sample",
                origin: production ? canvasStatus(env).origin : null,
                owner: user.id,
                courseId: a.course_id,
                assignmentId: a.id,
                score: a.submission.score,
                pointsPossible: a.points_possible,
                rawGradePercent: (a.submission.score / a.points_possible) * 100,
                gradedAt: a.submission.graded_at,
                postedAt: a.submission.posted_at,
                fetchedAt: now(),
                dateBasis: "grade-release",
                categoryConfirmedByMember: selected.activity,
              },
            });
            state.submissions.push(item);
            imported.push(item);
            await audit(
              session.workspace,
              user.name,
              "canvas.import",
              item.id,
              `${a.course_id}:${a.id}`,
            );
          }
          return {
            imported,
            skippedDuplicateAssignmentIds: skipped,
            points: totals(state, user, policyDay()),
          };
        });
        return json(res, 201, {
          mode: production ? "live" : "sample",
          ...result,
        });
      }
      if (path === "/api/uploads/init" && req.method === "POST") {
        individual(user);
        const generation = await academicSnapshot(session, requestGeneration);
        if (!directUploads || !storageStatus(env).configured)
          fail(503, "Direct evidence storage is not configured.");
        await cleanupExpiredUpload(session, user);
        const name =
          typeof input.name === "string"
            ? basename(input.name.replaceAll("\\", "/"))
                .replace(/[\u0000-\u001f\u007f]/g, "")
                .trim()
            : "";
        if (
          !name ||
          name.length > 150 ||
          !["application/pdf", "image/png", "image/jpeg"].includes(
            input.mime,
          ) ||
          !Number.isInteger(input.size) ||
          input.size < 1 ||
          input.size > 5 * 1024 * 1024
        )
          fail(
            422,
            "Choose a PDF, PNG or JPEG evidence file of at most 5 MiB.",
          );
        const id = randomUUID();
        const path = `quarantine/${session.workspace}/${user.id}/${id}`;
        const finalPath = `evidence/${session.workspace}/${user.id}/${randomUUID()}`;
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          academicGuard(await stateOf(session.workspace), generation);
          await db
            .prepare(
              "INSERT INTO uploads(id,workspace,owner,name,mime,size,filename,created_at,status,backend,final_path) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              id,
              session.workspace,
              user.id,
              name,
              input.mime,
              input.size,
              path,
              now(),
              "pending",
              "supabase",
              finalPath,
            );
        });
        try {
          const grant = await createUploadGrant({ path, env });
          await assertActiveSession(session, user);
          academicGuard(await stateOf(session.workspace), generation);
          return json(res, 201, {
            id,
            upload: { id, name, mime: input.mime, size: input.size },
            uploadUrl: grant.url,
            method: grant.method,
            headers: grant.headers,
            expiresIn: grant.expiresIn,
          });
        } catch (error) {
          await db
            .prepare(
              "UPDATE uploads SET status='failed' WHERE id=? AND status='pending'",
            )
            .run(id);
          throw error;
        }
      }
      const completeUploadRoute = path.match(
        /^\/api\/uploads\/([a-f0-9-]{36})\/complete$/,
      );
      if (completeUploadRoute && req.method === "POST") {
        individual(user);
        const generation = await academicSnapshot(session, requestGeneration);
        if (!directUploads) fail(404, "Not found.");
        const intent = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          academicGuard(await stateOf(session.workspace), generation);
          const found = await db
            .prepare(
              "SELECT * FROM uploads WHERE id=? AND workspace=? AND owner=? FOR UPDATE",
            )
            .get(completeUploadRoute[1], session.workspace, user.id);
          if (!found || found.backend !== "supabase")
            fail(404, "Evidence upload not found.");
          if (found.status === "ready") return found;
          if (
            found.status !== "pending" ||
            Date.now() - Date.parse(found.created_at) > 2 * 60 * 60 * 1000
          )
            fail(
              409,
              "This upload expired or has already been completed. Upload a new file.",
            );
          await db
            .prepare(
              "UPDATE uploads SET status='verifying' WHERE id=? AND status='pending'",
            )
            .run(found.id);
          return found;
        });
        if (intent.status === "ready")
          return json(res, 200, { upload: uploadMeta(intent) });
        try {
          const verified = await finalizeStoredEvidence({
            path: intent.filename,
            finalPath: intent.final_path,
            expectedMime: intent.mime,
            expectedSize: intent.size,
            env,
          });
          await atomic(async () => {
            await lockWorkspace(session.workspace);
            await assertActiveSession(session, user);
            academicGuard(await stateOf(session.workspace), generation);
            const changed = await db
              .prepare(
                "UPDATE uploads SET status='ready',size=?,mime=? WHERE id=? AND workspace=? AND owner=? AND status='verifying'",
              )
              .run(
                verified.size,
                verified.mime,
                intent.id,
                session.workspace,
                user.id,
              );
            if (changed.changes !== 1)
              fail(409, "Evidence upload changed. Upload a new file.");
            await audit(
              session.workspace,
              user.name,
              "evidence.upload",
              intent.id,
              `${verified.mime}; ${verified.size} bytes; sha256 ${verified.sha256}`,
            );
          });
          return json(res, 201, {
            upload: uploadMeta({
              ...intent,
              size: verified.size,
              mime: verified.mime,
            }),
          });
        } catch (error) {
          const failed = await db
            .prepare(
              "UPDATE uploads SET status='failed' WHERE id=? AND status='verifying'",
            )
            .run(intent.id);
          const remaining = await db
            .prepare("SELECT status FROM uploads WHERE id=?")
            .get(intent.id);
          if (
            failed.changes === 1 ||
            !remaining ||
            remaining.status === "purging"
          )
            await Promise.allSettled([
              removeStoredEvidence({ path: intent.filename, env }),
              removeStoredEvidence({ path: intent.final_path, env }),
            ]);
          throw error;
        }
      }
      if (path === "/api/uploads" && req.method === "POST") {
        individual(user);
        const generation = await academicSnapshot(session, requestGeneration);
        if (directUploads)
          fail(422, "Use the direct evidence upload workflow.");
        const file = validUpload(input);
        const id = randomUUID();
        const filename = `${id}.bin`;
        await writeFile(resolve(filesDir, filename), file.bytes, {
          flag: "wx",
          mode: 0o600,
        });
        try {
          await requireSession(req);
          await atomic(async () => {
            await lockWorkspace(session.workspace);
            await assertActiveSession(session, user);
            academicGuard(await stateOf(session.workspace), generation);
            await db
              .prepare(
                "INSERT INTO uploads(id,workspace,owner,name,mime,size,filename,created_at) VALUES (?,?,?,?,?,?,?,?)",
              )
              .run(
                id,
                session.workspace,
                user.id,
                file.name,
                file.mime,
                file.bytes.length,
                filename,
                now(),
              );
            await audit(
              session.workspace,
              user.name,
              "evidence.upload",
              id,
              `${file.mime}; ${file.bytes.length} bytes`,
            );
          });
        } catch (error) {
          await unlink(resolve(filesDir, filename)).catch(() => {});
          throw error;
        }
        return json(res, 201, {
          upload: uploadMeta({
            id,
            name: file.name,
            mime: file.mime,
            size: file.bytes.length,
          }),
        });
      }
      const uploadRoute = path.match(/^\/api\/uploads\/([a-f0-9-]{36})(\/preview)?$/);
      if (uploadRoute && req.method === "GET") {
        const upload = await getUpload(uploadRoute[1], session, user);
        const inline = uploadRoute[2] === "/preview";
        if (upload.backend === "supabase") {
          const grant = await createDownloadGrant({
            path: upload.final_path,
            downloadName: upload.name,
            inline,
            expiresIn: 60,
            env,
          });
          await assertActiveSession(session, user);
          await getUpload(upload.id, session, user);
          await audit(
            session.workspace,
            user.name,
            "evidence.download",
            upload.id,
            user.role,
          );
          return redirect(res, grant.url);
        }
        if (directUploads)
          fail(404, "Evidence record is not available in hosted storage.");
        const bytes = await readFile(resolve(filesDir, upload.filename));
        await requireSession(req);
        await audit(
          session.workspace,
          user.name,
          "evidence.download",
          upload.id,
          user.role,
        );
        if (inline) {
          res.setHeader("X-Frame-Options", "SAMEORIGIN");
          // Native PDF viewers need their own resources. Uploaded PDFs are
          // signature-checked and served with application/pdf + nosniff.
          res.setHeader("Content-Security-Policy", upload.mime === "application/pdf"
            ? "frame-ancestors 'self'"
            : "default-src 'none'; frame-ancestors 'self'");
        }
        res.writeHead(200, {
          "Content-Type": upload.mime,
          "Content-Length": bytes.length,
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="evidence${extname(upload.name).replace(/[^.a-z0-9]/gi, "")}"; filename*=UTF-8''${encodeURIComponent(upload.name)}`,
        });
        return res.end(bytes);
      }
      const adjustmentRoute = path.match(/^\/api\/members\/([^/]+)\/point-adjustments$/);
      if (adjustmentRoute && ["GET", "POST"].includes(req.method)) {
        if (req.method === "POST") chair(user);
        const targetId = adjustmentRoute[1];
        const target = await member(session.workspace, targetId);
        if (!target || target.role !== "member" || (user.role !== "chair" && user.id !== targetId))
          fail(404, "Member not found.");
        if (req.method === "GET") return json(res, 200,
          pointAdjustmentView(await stateOf(session.workspace), target));
        const result = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const currentUser = await member(session.workspace, user.id);
          chair(currentUser);
          const currentTarget = await member(session.workspace, targetId);
          if (!currentTarget?.active || currentTarget.role !== "member") fail(404, "Active member not found.");
          const state = await stateOf(session.workspace);
          academicGuard(state, requestGeneration);
          const result = applyPointAdjustment(state, currentTarget, input, currentUser,
            randomUUID(), new Date().toISOString());
          await db.prepare("UPDATE chapters SET data=? WHERE workspace=?")
            .run(JSON.stringify(state), session.workspace);
          const entry = result.history[0];
          await audit(session.workspace, currentUser.name, "points.adjustment", targetId,
            `${entry.previousTotal} -> ${entry.total}; ${entry.reason}`);
          return result;
        });
        return json(res, 200, result);
      }
      if (path === "/api/points" && req.method === "GET") {
        individual(user);
        return json(res, 200, {
          member: user.id,
          checkpointDate: user.checkpointDate,
          ...totals(await stateOf(session.workspace), user, policyDay()),
        });
      }
      if (path === "/api/members" && req.method === "GET") {
        chair(user);
        const state = await stateOf(session.workspace);
        return json(res, 200, {
          members: (await listMembers(session.workspace, state))
            .filter((m) => m.role === "member")
            .map((m) => ({ ...m, ...totals(state, m, policyDay()) })),
        });
      }
      if (path === "/api/admin/pilot-accounts" && req.method === "POST") {
        chair(user);
        if (!production || authMode !== "chapter") fail(404, "Real pilot accounts are available only in the live chapter portal.");
        if (input?.confirm !== "CREATE THREE PILOT ACCOUNTS") fail(422, "Confirm the creation of three real pilot accounts.");
        const createdAuthIds = [];
        let accounts;
        try {
          accounts = await atomic(async () => {
            await lockWorkspace(session.workspace);
            await assertActiveSession(session, user);
            const state = await stateOf(session.workspace);
            if (state.pilotAccounts?.length) fail(409, "Pilot accounts already exist. Manage them in the roster; passwords cannot be displayed again.");
            const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
            const definitions = [
              ["glazebrook", "Otis Allan Glazebrook (Pilot)", 1],
              ["marshall", "Alfred Marshall (Pilot)", 3],
              ["ross", "Erskine Mayo Ross (Pilot)", 4],
            ];
            const output = [];
            for (const [username, name, tier] of definitions) {
              if (await accountForIdentifier(username)) fail(409, "A pilot username is already in use. Contact the operator.");
              const id = randomUUID(), email = `${id}@pilot.invalid`, password = randomBytes(18).toString("base64url");
              const authId = await createPilotAccount(env, email, password);
              createdAuthIds.push(authId);
              await insertMember(session.workspace, { id, name, email, role: "member", tier, credits: 15 });
              for (const [provider, subject] of [["supabase", authId], ["login", username]])
                await db.prepare("INSERT INTO identities VALUES (?,?,?,?)").run(session.workspace, provider, subject, id);
              output.push({ id, username, name, password, tier, expiresAt });
            }
            state.pilotAccounts = output.map(({id, expiresAt}) => ({id, expiresAt}));
            await db.prepare("UPDATE chapters SET data=? WHERE workspace=?").run(JSON.stringify(state), session.workspace);
            await audit(session.workspace, user.name, "pilot.created", "founder-pilots", "Three member-only pilot accounts; 30-day access; no email.");
            return output;
          });
        } catch (error) {
          for (const id of createdAuthIds) await deleteNewPilotAccount(env, id).catch(() => {});
          throw error;
        }
        return json(res, 201, { accounts });
      }
      if (path === "/api/roster" && req.method === "GET") {
        chair(user);
        const members = await listMembers(session.workspace);
        const identities = await db
          .prepare(
            "SELECT member_id,provider,subject FROM identities WHERE workspace=? AND provider<>?",
          )
          .all(session.workspace, "supabase");
        const identitiesByMember = new Map();
        for (const { member_id, provider, subject } of identities) {
          if (!identitiesByMember.has(member_id))
            identitiesByMember.set(member_id, []);
          identitiesByMember.get(member_id).push({ provider, subject });
        }
        return json(res, 200, {
          members: members.map((m) => ({
            ...m,
            identities: identitiesByMember.get(m.id) || [],
          })),
        });
      }
      if (path === "/api/admin/tier-import" && req.method === "GET") {
        chair(user);
        const view = await tierImportView(session.workspace, await stateOf(session.workspace));
        if (production) {
          const identifiers = await fetchRosterImportIdentifiers({ env });
          const byEmail = new Map(identifiers.map((entry) => [entry.email, entry]));
          if (identifiers.length !== view.targets.length || view.targets.some((target) => {
            const entry = byEmail.get(target.email);
            return !entry || entry.name !== target.name || entry.membership !== target.membership;
          })) fail(409, "The roster changed. Refresh it before importing tiers.");
          view.targets = view.targets.map((target) => ({
            ...target, schoolId: byEmail.get(target.email).schoolId,
              ...(byEmail.get(target.email).schoolIdIssue ? { schoolIdIssue: byEmail.get(target.email).schoolIdIssue } : {}),
          }));
        }
        await assertActiveSession(session, user);
        if ((await tierImportView(session.workspace, await stateOf(session.workspace))).snapshot !== view.snapshot)
          fail(409, "The roster or tiers changed. Open the import again.");
        return json(res, 200, view);
      }
      if (path === "/api/admin/tier-import/settings" && req.method === "POST") {
        chair(user);
        if (Object.keys(input).join(",") !== "mapping")
          fail(422, "Only sheet layout settings can be saved here.");
        const mapping = validateGpaImportMapping(input.mapping);
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const state = await stateOf(session.workspace);
          state.gpaImportMapping = mapping;
          await db.prepare("UPDATE chapters SET data=? WHERE workspace=?")
            .run(JSON.stringify(state), session.workspace);
          await audit(session.workspace, user.name, "roster.import_columns", "", "GPA import layout updated");
        });
        return json(res, 200, { mapping });
      }
      if (path === "/api/admin/tier-import" && req.method === "POST") {
        chair(user);
        if (Object.keys(input).sort().join(",") !== "assignments,snapshot" ||
          typeof input.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(input.snapshot) ||
          !Array.isArray(input.assignments) || !input.assignments.length ||
          input.assignments.length > 1000)
          fail(422, "Submit a reviewed list of member emails and tiers only.");
        const seen = new Set();
        for (const assignment of input.assignments) {
          if (!assignment || Array.isArray(assignment) ||
            Object.keys(assignment).sort().join(",") !== "email,tier" ||
            typeof assignment.email !== "string" ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(assignment.email) ||
            !Number.isInteger(assignment.tier) || assignment.tier < 1 || assignment.tier > 5 ||
            seen.has(assignment.email.toLowerCase()))
            fail(422, "Every tier assignment needs one unique roster email and a tier from 1–5.");
          seen.add(assignment.email.toLowerCase());
        }
        const result = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const state = await stateOf(session.workspace);
          academicGuard(state, requestGeneration);
          const view = await tierImportView(session.workspace, state);
          if (view.snapshot !== input.snapshot)
            fail(409, "The roster or tiers changed. Review the import again before applying it.");
          const targets = new Map(view.targets.map((target) => [target.email, target]));
          for (const assignment of input.assignments) {
            const target = targets.get(assignment.email.toLowerCase());
            if (!target || target.accountStatus === "inactive")
              fail(422, "Every selected row must match an eligible, active roster entry.");
            if (target.membership === "new_member" && assignment.tier !== 1)
              fail(422, "New members must be assigned Tier 1.");
          }
          state.tierAssignments ||= {};
          let updated = 0, staged = 0;
          for (const assignment of input.assignments) {
            const target = targets.get(assignment.email.toLowerCase());
            if (target.accountId) {
              if (target.currentTier !== assignment.tier) {
                await db.prepare("UPDATE members SET tier=? WHERE workspace=? AND id=? AND role='member' AND active=1")
                  .run(assignment.tier, session.workspace, target.accountId);
                await audit(session.workspace, user.name, "roster.tier_import", target.accountId,
                  `tier ${target.currentTier} to ${assignment.tier}`);
                updated++;
              }
              delete state.tierAssignments[target.email];
            } else if (state.tierAssignments[target.email] !== assignment.tier) {
              state.tierAssignments[target.email] = assignment.tier;
              await audit(session.workspace, user.name, "roster.tier_staged", target.email,
                `tier ${assignment.tier}`);
              staged++;
            }
          }
          await db.prepare("UPDATE chapters SET data=? WHERE workspace=?")
            .run(JSON.stringify(state), session.workspace);
          return { updated, staged };
        });
        return json(res, 200, result);
      }
      if (path === "/api/admin/invitations" && req.method === "GET") {
        chair(user);
        const state = await stateOf(session.workspace);
        const invitations = invitationList(state);
        const members = await listMembers(session.workspace, state);
        const eligibleMembers = new Map(members.filter(member => member.role === "member" && member.active)
          .map(member => [member.email, member.id]));
        const emailRoster = rosterStatus(env).mode === "public_email_csv";
        for (const invitation of invitations) {
          invitation.canSendInitial = invitation.canSendInitial && eligibleMembers.get(invitation.email) === invitation.memberId &&
            (!emailRoster || rosterView(state).fresh && state.roster.emails.includes(invitation.email));
        }
        for (const existing of members) {
          if (existing.role !== "member" || !existing.active || existing.email.endsWith("@pilot.invalid") || state.invitations?.[existing.email]) continue;
          invitations.push({
            email: existing.email, name: existing.name, status: "untracked", memberId: existing.id,
            loginId: null, lastSentAt: null, retryAt: null, canReconcile: true, canResend: false, canSendInitial: false,
            message: "This account predates invitation tracking. Check its setup before sending another setup email.",
          });
        }
        invitations.sort((a, b) => a.name.localeCompare(b.name));
        return json(res, 200, { invitations, emailReady: chapterEmailReady });
      }
      if (path === "/api/admin/invitations/prepare" && req.method === "POST") {
        chair(user);
        if (Object.keys(input).sort().join(",") !== "badge,credits,email,name,tier")
          fail(422, "Supply only member name, email, badge, tier and credits.");
        const prepared = validateChapterMember(input);
        const result = await processInvitation(session, user, prepared.email, "prepare", requestGeneration, prepared);
        return json(res, 201, result);
      }
      const invitationAction = path.match(/^\/api\/admin\/invitations\/([^/]+)\/(reconcile|resend|send-initial)$/);
      if (invitationAction && req.method === "POST") {
        chair(user);
        let email;
        try { email = decodeURIComponent(invitationAction[1]).trim().toLowerCase(); }
        catch { fail(422, "Invalid member email."); }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
          fail(422, "Invalid member email.");
        if (Object.keys(input).length) fail(422, "This action does not accept account changes.");
        const result = await processInvitation(session, user, email, invitationAction[2], requestGeneration);
        return json(res, 200, result);
      }
      if (path === "/api/roster" && req.method === "POST") {
        chair(user);
        if (production && authMode === "chapter") {
          if (!chapterAuthConfigured(env)) fail(503, "Chapter invitations are not ready.");
          if (!chapterEmailReady) fail(503, "Member invitations require email delivery. The Chair must configure and test chapter email first.");
          const invited = validateChapterMember(input);
          if (rosterStatus(env).mode === "public_email_csv") {
            let state = await stateOf(session.workspace);
            if (!rosterView(state).fresh) state = await refreshRoster(session, user);
            if (!rosterView(state).fresh)
              fail(503, "Current roster eligibility is unavailable. Refresh the roster before inviting members.");
            if (!state.roster.emails.includes(invited.email))
              fail(422, "This email is not eligible on the connected chapter roster.");
            const listed = state.roster.directory.find((entry) => entry.email === invited.email);
            invited.tier = listed?.membership === "new_member" ? 1 :
              state.tierAssignments?.[invited.email] ?? invited.tier;
          }
          const result = await processInvitation(session, user, invited.email, "create", requestGeneration, invited);
          return json(res, 201, result);
        }
        const invited = validateRoster(input);
        const created = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          if (
            await db
              .prepare(
                "SELECT member_id FROM identities WHERE workspace=? AND provider=? AND subject=?",
              )
              .get(session.workspace, invited.provider, invited.subject)
          )
            fail(
              409,
              "This stable identity is already bound to a roster member.",
            );
          const id = randomUUID();
          await insertMember(session.workspace, {
            ...invited,
            id,
            role: "member",
          });
          await db
            .prepare("INSERT INTO identities VALUES (?,?,?,?)")
            .run(session.workspace, invited.provider, invited.subject, id);
          await audit(
            session.workspace,
            user.name,
            "roster.invite",
            id,
            `${invited.provider}; tier ${invited.tier}; credits ${invited.credits}`,
          );
          return await member(session.workspace, id);
        });
        return json(res, 201, { member: created });
      }
      const accountSettings = path.match(/^\/api\/roster\/([^/]+)\/account-settings$/);
      if (accountSettings && ["GET", "POST"].includes(req.method)) {
        chair(user);
        if (req.method === "POST" && (Object.keys(input).sort().join(",") !== "badge,credits,name,tier,version" ||
          typeof input.version !== "string" || !/^[a-f0-9]{64}$/.test(input.version)))
          fail(422, "Submit the reviewed account details and version. The sign-in email cannot be changed here.");
        if (production && rosterStatus(env).mode === "public_email_csv" && !rosterView(await stateOf(session.workspace)).fresh)
          await refreshRoster(session, user);
        const result = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const state = await stateOf(session.workspace);
          const target = await member(session.workspace, accountSettings[1]);
          if (!target?.active || target.role !== "member") fail(404, "Active member not found.");
          const current = await accountSettingsView(session.workspace, target, state);
          if (req.method === "GET") return current;
          academicGuard(state, requestGeneration);
          if (current.version !== input.version) fail(409, "This account changed. Reopen its settings before saving.");
          if (production && rosterStatus(env).mode === "public_email_csv" && !target.email.endsWith("@pilot.invalid") &&
            (!rosterView(state).fresh || !state.roster.emails.includes(target.email)))
            fail(409, "Refresh the roster and confirm this member is still eligible before saving.");
          const details = validateChapterMember({ ...input, email: target.email });
          if (current.membership === "new_member" && details.tier !== 1)
            fail(422, "New members must be assigned Tier 1.");
          if (current.creditsManaged && target.credits !== details.credits)
            fail(409, "This member’s credit hours come from approved classes. Review their classes to change the total.");
          const record = state.invitations?.[target.email];
          if ((record?.operation?.until || 0) > Date.now())
            fail(409, "Account setup is in progress. Refresh its status before editing.");
          let alias = current.loginId?.toLowerCase();
          if (!alias) {
            do { alias = loginAlias().toLowerCase(); }
            while (await db.prepare("SELECT member_id FROM identities WHERE workspace=? AND provider='login' AND subject=?").get(session.workspace, alias) ||
              Object.values(state.invitations || {}).some(entry => entry.alias === alias || entry.badge === alias));
          }
          const permanentLogin = await db.prepare("SELECT member_id FROM identities WHERE workspace=? AND provider='login' AND subject=?")
            .get(session.workspace, alias);
          if (permanentLogin && permanentLogin.member_id !== target.id)
            fail(409, "The permanent login is linked to another account. Ask the portal operator to check it.");
          if (!permanentLogin) await db.prepare("INSERT INTO identities VALUES (?,?,?,?)").run(session.workspace, "login", alias, target.id);
          if (details.badge && details.badge === alias)
            fail(422, "The badge must be different from the permanent login ID.");
          if (details.badge) {
            const existing = await db.prepare("SELECT member_id FROM identities WHERE workspace=? AND provider='login' AND subject=?")
              .get(session.workspace, details.badge);
            if (existing && existing.member_id !== target.id || Object.values(state.invitations || {})
              .some(entry => entry.email !== target.email && (entry.badge === details.badge || entry.alias === details.badge)))
              fail(409, "Another member already uses or has reserved this badge number.");
          }
          if (current.badge && current.badge !== alias && current.badge !== details.badge)
            await db.prepare("DELETE FROM identities WHERE workspace=? AND provider='login' AND subject=? AND member_id=?")
              .run(session.workspace, current.badge, target.id);
          if (details.badge && !(await db.prepare("SELECT member_id FROM identities WHERE workspace=? AND provider='login' AND subject=?")
            .get(session.workspace, details.badge)))
            await db.prepare("INSERT INTO identities VALUES (?,?,?,?)").run(session.workspace, "login", details.badge, target.id);
          await db.prepare("UPDATE members SET name=?,tier=?,credits=? WHERE workspace=? AND id=? AND role='member' AND active=1")
            .run(details.name, details.tier, details.credits, session.workspace, target.id);
          if (record) Object.assign(record, { name: details.name, badge: details.badge, alias, tier: details.tier, credits: details.credits, updatedAt: now() });
          if (state.tierAssignments) delete state.tierAssignments[target.email];
          if (target.credits !== details.credits) refreshPendingCreditEstimates(state, target.id, multiplier({ credits: details.credits }));
          await db.prepare("UPDATE chapters SET data=? WHERE workspace=?").run(JSON.stringify(state), session.workspace);
          await audit(session.workspace, user.name, "roster.account_settings", target.id,
            `Account details updated without email; tier ${target.tier} to ${details.tier}; credits ${target.credits} to ${details.credits}`);
          return await accountSettingsView(session.workspace, await member(session.workspace, target.id), state);
        });
        return json(res, 200, result);
      }
      const academicSettings = path.match(/^\/api\/roster\/([^/]+)\/academic-settings$/);
      if (academicSettings && req.method === "POST") {
        chair(user);
        if (
          Object.keys(input).sort().join(",") !== "credits,tier" ||
          !Number.isInteger(input.tier) || input.tier < 1 || input.tier > 5 ||
          !Number.isFinite(input.credits) || input.credits < 0 || input.credits > 30
        ) fail(422, "Choose a tier from 1–5 and enrolled credits from 0–30.");
        const updated = await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          const state = await stateOf(session.workspace);
          academicGuard(state, requestGeneration);
          const target = await member(session.workspace, academicSettings[1]);
          if (!target?.active || target.role !== "member")
            fail(404, "Active member not found.");
          if (state.roster?.directory?.find((entry) => entry.email === target.email)?.membership === "new_member" && input.tier !== 1)
            fail(422, "New members must be assigned Tier 1.");
          if (creditsManaged(state, target.id) && target.credits !== input.credits)
            fail(409, "This member’s credit hours come from approved classes. Review their classes to change the total.");
          if (target.tier === input.tier && target.credits === input.credits)
            return target;
          await db.prepare(
            "UPDATE members SET tier=?, credits=? WHERE workspace=? AND id=? AND role='member' AND active=1",
          ).run(input.tier, input.credits, session.workspace, target.id);
          refreshPendingCreditEstimates(state, target.id, multiplier({ credits: input.credits }));
          await db.prepare("UPDATE chapters SET data=? WHERE workspace=?").run(JSON.stringify(state), session.workspace);
          await audit(session.workspace, user.name, "roster.academic_settings", target.id,
            `tier ${target.tier} to ${input.tier}; credits ${target.credits} to ${input.credits}`);
          return await member(session.workspace, target.id);
        });
        return json(res, 200, { member: updated });
      }
      const resetMember = path.match(/^\/api\/roster\/([^/]+)\/reset-password$/);
      if (resetMember && req.method === "POST" && production && authMode === "chapter") {
        chair(user);
        if (!chapterEmailReady) fail(503, "Email resets are not available yet. Members can use their recovery key.");
        const target = await member(session.workspace, resetMember[1]);
        if (!target?.active || target.role !== "member") fail(404, "Active member not found.");
        const linked = await db.prepare("SELECT subject FROM identities WHERE workspace=? AND provider=? AND member_id=?")
          .get(session.workspace, "supabase", target.id);
        if (!linked) fail(409, "This member has no chapter login yet.");
        if (target.email.endsWith("@pilot.invalid")) fail(422, "Pilot accounts have no email inbox. Use the recovery key or contact the operator.");
        await sendPasswordReset(env, target.email, `${origin}/account/reset`);
        await audit(session.workspace, user.name, "account.reset_requested", target.id);
        return json(res, 200, { message: "Password reset email requested." });
      }
      const deactivate = path.match(/^\/api\/roster\/([^/]+)\/deactivate$/);
      if (deactivate && req.method === "POST") {
        chair(user);
        const target = await member(session.workspace, deactivate[1]);
        if (!target) fail(404, "Roster member not found.");
        if (target.id === user.id || target.role === "chair")
          fail(
            422,
            "The Scholarship Chair cannot be deactivated through this action.",
          );
        await atomic(async () => {
          await lockWorkspace(session.workspace);
          await assertActiveSession(session, user);
          await db
            .prepare("UPDATE members SET active=0 WHERE workspace=? AND id=?")
            .run(session.workspace, target.id);
          await advanceCanvasGeneration(session.workspace, target.id);
          await db
            .prepare(
              "DELETE FROM transactions WHERE session_id IN (SELECT id FROM sessions WHERE workspace=? AND member_id=?)",
            )
            .run(session.workspace, target.id);
          await db
            .prepare("DELETE FROM sessions WHERE workspace=? AND member_id=?")
            .run(session.workspace, target.id);
          await db
            .prepare(
              "DELETE FROM integrations WHERE workspace=? AND member_id=?",
            )
            .run(session.workspace, target.id);
          await audit(
            session.workspace,
            user.name,
            "roster.deactivate",
            target.id,
          );
        });
        return json(res, 200, {
          member: await member(session.workspace, target.id),
        });
      }
      if (path === "/api/audit" && req.method === "GET") {
        chair(user);
        return json(res, 200, {
          events: await db
            .prepare(
              "SELECT id,at,actor,action,subject,detail FROM audit WHERE workspace=? ORDER BY id DESC LIMIT 200",
            )
            .all(session.workspace),
        });
      }
      if (path === "/api/submissions" && req.method === "GET") {
        const state = await stateOf(session.workspace);
        return json(res, 200, {
          submissions: await Promise.all(
            state.submissions
              .filter((s) => user.role === "chair" || s.owner === user.id)
              .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
              .map(async (s) => ({
                ...s,
                syllabus: submissionSyllabus(state, s),
                memberName:
                  (await member(session.workspace, s.owner))?.name ||
                  "Former member",
              })),
          ),
        });
      }
      if (path === "/api/submissions" && req.method === "POST") {
        individual(user);
        const generation = await academicSnapshot(session, requestGeneration);
        const evidenceId = input.evidenceId || input.evidence;
        let evidence;
        if (!production && evidenceId === "sample") evidence = "sample";
        else if (
          !evidenceId ||
          evidenceId === "sample" ||
          evidenceId === "canvas"
        )
          fail(
            422,
            "Upload your evidence file or import a verified Canvas assignment first.",
          );
        else evidence = (await getUpload(evidenceId, session, user, true)).id;
        const result = await mutate(session, user, async (state, user) => {
          academicGuard(state, generation);
          if (evidence !== "sample")
            await getUpload(evidence, session, user, true);
          const item = newSubmission(
            claim(input, state, user, evidence),
            user,
            {
              source: evidence === "sample" ? "manual-sample" : "upload",
              ...(evidence === "sample" ? {} : { evidenceId: evidence }),
            },
          );
          state.submissions.push(item);
          await audit(
            session.workspace,
            user.name,
            "submission.create",
            item.id,
          );
          return { submission: item, points: totals(state, user, policyDay()) };
        });
        return json(res, 201, result);
      }
      const submissionRoute = path.match(
        /^\/api\/submissions\/([^/]+)(?:\/(review|evidence))?$/,
      );
      if (submissionRoute) {
        const state = await stateOf(session.workspace);
        const item = ownSubmission(state, user, submissionRoute[1]);
        if (!submissionRoute[2] && req.method === "GET")
          return json(res, 200, {
            submission: {
              ...item,
              syllabus: submissionSyllabus(state, item),
              memberName:
                (await member(session.workspace, item.owner))?.name ||
                "Former member",
            },
          });
        if (submissionRoute[2] === "evidence" && req.method === "GET") {
          await audit(
            session.workspace,
            user.name,
            "evidence.view",
            item.id,
            user.role,
          );
          if (item.evidenceId) {
            const upload = await getUpload(item.evidenceId, session, user);
            return json(res, 200, {
              evidence: {
                sample: false,
                submission: item.id,
                ...uploadMeta(upload),
                downloadUrl: `/api/uploads/${upload.id}`,
                previewUrl: `/api/uploads/${upload.id}/preview`,
                verification:
                  "Uploaded documentation requires Scholarship Chair review.",
              },
            });
          }
          if (item.source === "canvas")
            return json(res, 200, {
              evidence: {
                sample: false,
                source: "canvas",
                submission: item.id,
                title: item.title,
                course: item.course,
                date: item.date,
                grade: item.provenance.rawGradePercent ?? item.grade,
                ...item.provenance,
                verification:
                  "Retrieved server-side from the member’s connected Canvas account. Category and eligibility require Chair review.",
              },
            });
          if (production) fail(404, "Evidence record not found.");
          return json(res, 200, {
            evidence: {
              sample: true,
              submission: item.id,
              title: item.title,
              activity: categoryForSubmission(state, item)?.name,
              course: item.course,
              date: item.date,
              grade: item.grade,
              hours: item.quantity,
              note: item.note,
              verification:
                "Fictional sample record; no academic documentation has been uploaded.",
            },
          });
        }
        if (submissionRoute[2] === "review" && req.method === "POST") {
          chair(user);
          const generation = await academicSnapshot(session, requestGeneration);
          const result = await mutate(session, user, async (state) => {
            academicGuard(state, generation);
            const item = ownSubmission(state, user, submissionRoute[1]);
            if (item.status !== "pending")
              fail(409, "This submission has already been reviewed.");
            if (!["approved", "denied"].includes(input.decision))
              fail(422, "Choose approve or deny.");
            const note =
              typeof input.note === "string" ? input.note.trim() : "";
            if (note.length > 1000)
              fail(422, "Keep the review note under 1,000 characters.");
            if (
              input.decision === "approved" &&
              (!Number.isInteger(input.points) ||
                input.points < 0 ||
                input.points > 10000)
            )
              fail(422, "Award a whole number of points from 0 to 10,000.");
            if (
              (input.decision === "denied" || input.points !== item.estimate) &&
              note.length < 5
            )
              fail(
                422,
                "Explain the denial or point adjustment in a review note.",
              );
            item.status = input.decision;
            item.awarded = input.decision === "approved" ? input.points : 0;
            item.reviewNote = note;
            item.reviewedAt = now();
            item.reviewer = user.name;
            item.history.push({
              event:
                item.status === "approved"
                  ? `Approved · ${item.awarded} points`
                  : "Denied",
              by: user.name,
              at: item.reviewedAt,
              note,
            });
            await audit(
              session.workspace,
              user.name,
              `submission.${input.decision}`,
              item.id,
              `${item.awarded} points; ${note}`,
            );
            return {
              submission: item,
              points: totals(
                state,
                await member(session.workspace, item.owner),
                policyDay(),
              ),
            };
          });
          return json(res, 200, result);
        }
      }
      if (path === "/api/demo/reset" && req.method === "POST" && !production) {
        await mutate(session, user, async (state) => {
          academicGuard(state);
          state.submissions = seed().submissions;
          await audit(session.workspace, user.name, "demo.reset");
        });
        return json(res, 200, { reset: true });
      }
      if (path === "/api/export" && req.method === "GET") {
        chair(user);
        const state = await stateOf(session.workspace);
        const quote = (v) => {
          const s = String(v ?? "");
          return `"${(/^\s*[=+@\-]|^[\t\r\n]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`;
        };
        const rows = [
          [
            "Submission",
            "Member",
            "Activity",
            "Title",
            "Date",
            "Status",
            "Approved points",
            "Review note",
          ],
          ...(await Promise.all(
            state.submissions.map(async (s) => [
              s.id,
              (await member(session.workspace, s.owner))?.name ||
                "Former member",
              s.activity,
              s.title,
              s.date,
              s.status,
              s.awarded,
              s.reviewNote,
            ]),
          )),
        ];
        await audit(
          session.workspace,
          user.name,
          "submissions.export",
          "",
          `${state.submissions.length} records`,
        );
        const csv = rows.map((row) => row.map(quote).join(",")).join("\r\n");
        if (Buffer.byteLength(csv) > 4 * 1024 * 1024)
          fail(413, "Report is too large; contact the portal administrator.");
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="scholarship-submissions.csv"',
        });
        return res.end(csv);
      }
      fail(404, "API endpoint not found.");
    }
    if (path === "/demo" && req.method === "GET") {
      res.writeHead(302, { Location: "/demo/" });
      return res.end();
    }
    if (["/demo/login", "/demo/login.html"].includes(path) && req.method === "GET") {
      const account = url.searchParams.get("account") === "demo-chair" ? "chair" : "member";
      res.writeHead(302, { Location: `/demo/?account=${account}` });
      return res.end();
    }
    const mapping = {
      "/": "index.html",
      "/index.html": "index.html",
      "/account/setup": "index.html",
      "/account/reset": "index.html",
      "/style.css": "style.css",
      "/theme.css": "theme.css",
      "/theme.js": "theme.js",
      "/ato-logo.png": "ato-logo.png",
      "/app.js": "app.js",
      "/gpa-import.mjs": "gpa-import.mjs",
      "/school-id.mjs": "school-id.mjs",
      "/gpa-workbook.mjs": "gpa-workbook.mjs",
      "/gpa-workbook-data.mjs": "gpa-workbook-data.mjs",
      "/gpa-workbook-worker.js": "gpa-workbook-worker.js",
      "/vendor/xlsx-0.20.3.full.min.js": "vendor/xlsx-0.20.3.full.min.js",
      "/vendor/SheetJS-LICENSE.txt": "vendor/SheetJS-LICENSE.txt",
      "/faq-data.mjs": "faq-data.mjs",
      "/faq-ui.mjs": "faq-ui.mjs",
      "/profile-data.mjs": "profile-data.mjs",
      "/syllabus-data.mjs": "syllabus-data.mjs",
      "/syllabus-ui.mjs": "syllabus-ui.mjs",
      "/file-preview-ui.mjs": "file-preview-ui.mjs",
      "/profile-ui.mjs": "profile-ui.mjs",
      "/credit-data.mjs": "credit-data.mjs",
      "/credit-ui.mjs": "credit-ui.mjs",
      "/picture-ui.mjs": "picture-ui.mjs",
      "/checkpoint-calendar.js": "checkpoint-calendar.js",
      "/member-calendar.mjs": "member-calendar.mjs",
      "/celebrations.js": "celebrations.js",
      "/checkpoint-data.mjs": "checkpoint-data.mjs",
      "/category-data.mjs": "category-data.mjs",
      "/category-ui.mjs": "category-ui.mjs",
      "/point-adjustment-ui.mjs": "point-adjustment-ui.mjs",
      "/point-adjustment-data.mjs": "point-adjustment-data.mjs",
      "/checkpoint-ui.mjs": "checkpoint-ui.mjs",
      "/loading-ui.js": "loading-ui.js",
      "/portal-components.css": "portal-components.css",
      "/loading-cross.js": "loading-cross.js",
      "/demo/": "demo/index.html",
      "/demo/demo-service.mjs": "demo/demo-service.mjs",
      "/demo/index.html": "demo/index.html",
      "/demo/style.css": "demo/style.css",
      "/demo/app.js": "demo/app.js",
      "/demo/demo-worker.js": "demo/demo-worker.js",
      "/demo/demo-domain.mjs": "demo/demo-domain.mjs",
      "/demo/demo-canvas.mjs": "demo/demo-canvas.mjs",
    };
    if (req.method !== "GET" || !mapping[path]) fail(404, "Not found.");
    const file = mapping[path];
    const contents = await readFile(resolve(root, "web", file));
    res.writeHead(200, {
      "Content-Type": {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".png": "image/png",
      }[extname(file)],
    });
    res.end(contents);
  } catch (error) {
    const canvasError =
      typeof error.code === "string" && error.code.startsWith("CANVAS_");
    const status =
      error.status ||
      (canvasError ? (error.code.includes("CONFIG") ? 503 : 502) : 500);
    if (!res.headersSent)
      json(res, status, {
        error:
          error.status || canvasError
            ? error.message
            : "The portal could not complete this request.",
      });
    else res.end();
    // Do not log request URLs, credentials, submitted records or provider error bodies.
    if (status >= 500) console.error(`Portal request failed (${status}).`);
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(port, env.HOST || "127.0.0.1", () =>
  console.log(`ATO scholarship private: ${origin} (${mode})`),
);
function shutdown() {
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
