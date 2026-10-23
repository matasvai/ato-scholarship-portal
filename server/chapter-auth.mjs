import { createClient } from "@supabase/supabase-js";

const authOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
  // Provider calls must finish well before the durable account-mutation lease.
  // A lost/aborted response is still ambiguous; callers keep their safety hold.
  global: {
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
  },
};

export function chapterAuthConfigured(env = process.env) {
  try {
    const url = new URL(env.SUPABASE_URL);
    return (
      url.protocol === "https:" &&
      /^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      /^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(
        env.SUPABASE_PUBLISHABLE_KEY || "",
      ) &&
      /^sb_secret_[A-Za-z0-9_-]{16,}$/.test(env.SUPABASE_SECRET_KEY || "")
    );
  } catch {
    return false;
  }
}

export function chairAccountConfigured(env = process.env) {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(env.CHAIR_AUTH_USER_ID || "") &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.CHAIR_ACCOUNT_EMAIL || "")
  );
}

function clients(env) {
  if (!chapterAuthConfigured(env))
    throw Error("Chapter account authentication is not configured.");
  return {
    publicClient: createClient(
      env.SUPABASE_URL,
      env.SUPABASE_PUBLISHABLE_KEY,
      authOptions,
    ),
    adminClient: createClient(
      env.SUPABASE_URL,
      env.SUPABASE_SECRET_KEY,
      authOptions,
    ),
  };
}

export async function verifyPassword(env, email, password) {
  const { publicClient } = clients(env);
  const { data, error } = await publicClient.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data?.user?.id || !data.user.email_confirmed_at) return null;
  return { id: data.user.id, email: data.user.email?.toLowerCase() };
}

export async function inviteAccount(env, email, redirectTo) {
  const { adminClient } = clients(env);
  const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
    redirectTo,
  });
  if (error || !data?.user?.id)
    throw Error("The invitation could not be sent. Check the email service and account status.");
  return data.user.id;
}

// The Admin REST endpoint supports a server-side email filter; exact matching
// below is still required because the provider filter is a partial search.
// Never return provider records or a broad user listing to the browser.
export async function invitationAccountByEmail(env, email) {
  if (!chapterAuthConfigured(env)) throw Error("Chapter account authentication is not configured.");
  const query = new URLSearchParams({ filter: email, page: "1", per_page: "100" });
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users?${query}`, {
    headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Error("The sign-in account could not be checked.");
  const payload = await response.json();
  if (!Array.isArray(payload.users) || payload.users.length >= 100)
    throw Error("The sign-in account could not be matched safely.");
  const matches = payload.users.filter(user => user.email?.trim().toLowerCase() === email);
  if (matches.length > 1) throw Error("The sign-in account could not be matched safely.");
  return matches[0] ? invitationIdentity(matches[0], email) : null;
}

function invitationIdentity(user, email) {
  if (!/^[0-9a-f-]{36}$/i.test(user?.id || "") || user.email?.trim().toLowerCase() !== email || user.deleted_at)
    throw Error("The sign-in account did not match the intended member.");
  const proof = user.app_metadata?.ato_invitation;
  const invitationProof = proof?.version === 1 && typeof proof.workspace === "string" &&
    /^[a-f0-9]{64}$/.test(proof.nonce || "")
    ? { version: 1, workspace: proof.workspace, nonce: proof.nonce } : null;
  return { id: user.id, email, confirmed: Boolean(user.email_confirmed_at), invitationProof };
}

function invitationClient(env) {
  if (!chapterAuthConfigured(env)) throw Error("Chapter account authentication is not configured.");
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, authOptions);
}

// Create the Auth identity without sending anything. Portal membership must be
// committed before inviteUserByEmail can deliver a usable one-time link.
export async function prepareInvitationAccount(env, email, proof) {
  if (proof?.version !== 1 || typeof proof.workspace !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(proof.workspace) || !/^[a-f0-9]{64}$/.test(proof.nonce || ""))
    throw Error("The account preparation intent is missing.");
  const { data, error } = await invitationClient(env).auth.admin.createUser({
    email, email_confirm: false,
    // app_metadata is writable only by the trusted Auth administrator. A public
    // sign-up's user_metadata must never prove this portal created an identity.
    app_metadata: { ato_invitation: { version: 1, workspace: proof.workspace, nonce: proof.nonce } },
  });
  if (error || !data?.user) throw Error("The sign-in account could not be prepared.");
  return invitationIdentity(data.user, email);
}

export async function sendInvitationAccount(env, account, redirectTo) {
  if (account.confirmed) {
    // Existing confirmed accounts cannot receive another invite; a recovery
    // link leads to the same password-setup form without replacing their user.
    const { error } = await invitationClient(env).auth.resetPasswordForEmail(account.email, { redirectTo });
    if (error) throw Error("The setup email could not be confirmed.");
    return;
  }
  const { data, error } = await invitationClient(env).auth.admin.inviteUserByEmail(account.email, { redirectTo });
  if (error || data?.user?.id !== account.id)
    throw Error("The setup email could not be confirmed.");
}

export async function sendPasswordReset(env, email, redirectTo) {
  const { publicClient } = clients(env);
  const { error } = await publicClient.auth.resetPasswordForEmail(email, {
    redirectTo,
  });
  if (error) throw Error("Password reset email could not be sent.");
}

export async function userForAccountToken(env, accessToken) {
  const { publicClient } = clients(env);
  const { data: verified, error: verifyError } =
    await publicClient.auth.getUser(accessToken);
  if (verifyError || !verified?.user?.id) return null;
  return {
    id: verified.user.id, email: verified.user.email?.toLowerCase(),
    // Internal-only migration information; never expose factors to the browser.
    hasVerifiedFactors: (verified.user.factors || []).some(factor => factor.status === "verified"),
  };
}

export async function setPasswordWithToken(env, accessToken, password, expectedUserId) {
  if (!expectedUserId) return null;
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    method: "PUT",
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (data?.id !== expectedUserId) return null;
  return { id: data.id, email: data.email?.toLowerCase() };
}

export async function setPasswordByAdmin(env, userId, password) {
  const { adminClient } = clients(env);
  const { data, error } = await adminClient.auth.admin.updateUserById(userId, { password });
  if (error || data?.user?.id !== userId)
    throw Error("The password could not be changed. Try again shortly or request an email reset.");
  return data.user.id;
}

export async function createPilotAccount(env, email, password) {
  if (!email.endsWith("@pilot.invalid")) throw Error("Pilot identity required.");
  const { data, error } = await clients(env).adminClient.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { pilot: true },
  });
  if (error || !data?.user?.id) throw Error("Could not create the pilot sign-in. Contact the operator.");
  return data.user.id;
}
export async function deleteNewPilotAccount(env, id) {
  const { error } = await clients(env).adminClient.auth.admin.deleteUser(id);
  if (error) throw Error("Pilot cleanup failed.");
}
