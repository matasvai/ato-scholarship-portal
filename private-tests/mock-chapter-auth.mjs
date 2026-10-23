import { appendFile, writeFile } from "node:fs/promises";
const originalFetch = globalThis.fetch;
const chairId = "aab93409-383f-4d8a-b443-3d940a277153";
const memberId = "d4dc3984-9c89-4ff7-8075-cbe5b2cd18c4";
const invitationUsers = new Map();
const passwords = new Map([
  [chairId, "correct-test-password"],
  [memberId, "correct-test-password"],
]);
const respond = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (process.env.TEST_PUBLIC_ROSTER === "true" && url.origin === "https://docs.google.com") {
    const withNumber = url.searchParams.get("tq") === "select A,B,C,E,I";
    const csv = withNumber
      ? "First Name,Last Name,Status,900 Number,Student Email\nSample,Member,Active,900123456,member@example.edu\nNew,Member,New Mem.,900999999,new@example.edu\n"
      : "First Name,Last Name,Status,Student Email\nSample,Member,Active,member@example.edu\nNew,Member,New Mem.,new@example.edu\n";
    return new Response(csv, { headers: { "Content-Type": "text/csv" } });
  }
  if (url.origin !== "https://chapter-test.supabase.co")
    return originalFetch(input, options);
  if (process.env.TEST_AUTH_PROVIDER_LOG) await appendFile(process.env.TEST_AUTH_PROVIDER_LOG, `${options.method || 'GET'} ${url.pathname}\n`);
  // No production route may create, delete, challenge, or verify a factor now.
  if (url.pathname.startsWith('/auth/v1/factors')) throw Error('Retired authenticator route was called.');
  if (url.pathname === "/auth/v1/token") {
    const body = JSON.parse(options.body);
    const id = body.email === "chair@example.edu" ? chairId :
      body.email === "member@example.edu" ? memberId : null;
    if (!id || body.password !== passwords.get(id))
      return respond({ error: "invalid_grant" }, 400);
    if (id === chairId && process.env.TEST_AUTH_TOKEN_SIGNAL) {
      await writeFile(process.env.TEST_AUTH_TOKEN_SIGNAL, 'password-verified');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return respond({
      access_token: id === chairId ? "test-chair-password-token" : "test-access-token", token_type: "bearer",
      refresh_token: "test-refresh-token", expires_in: 3600,
      user: { id, email: body.email, email_confirmed_at: "2026-09-29T00:00:00Z" },
    });
  }
  if (url.pathname === "/auth/v1/admin/users" && options.method === "POST") {
    const { email, app_metadata } = JSON.parse(options.body);
    if (invitationUsers.has(email)) return respond({ error: "duplicate" }, 422);
    const user = { id: email === "member@example.edu" ? memberId : "aadf192d-7b32-42d1-ab6f-a63ce8f0a1b4", email, app_metadata };
    invitationUsers.set(email, user);
    return respond(user);
  }
  if (url.pathname === "/auth/v1/admin/users")
    return respond({ users: [...invitationUsers.values()].filter(user => user.email.includes(url.searchParams.get("filter"))) });
  if (url.pathname === "/auth/v1/invite")
    return respond(invitationUsers.get(JSON.parse(options.body).email) || { error: "not prepared" });
  if (url.pathname === "/auth/v1/recover") return respond({});
  if (url.pathname === "/auth/v1/user") {
    const accessToken = new Headers(options.headers).get('authorization')?.replace(/^Bearer /, '');
    const chair = ['test-chair-account-token', 'test-chair-password-token'].includes(accessToken);
    const member = ['test-account-token', 'test-access-token'].includes(accessToken);
    if (!chair && !member) return respond({ error: 'invalid token' }, 401);
    const id = chair ? chairId : memberId;
    const factors = chair && process.env.TEST_AUTH_PREENROLLED === 'true'
      ? [{ id: 'factor-existing', factor_type: 'totp', status: 'verified', friendly_name: 'Scholarship Chair' }] : [];
    if (options.method === "PUT") {
      if (factors.length > 0)
        return respond({ code: 'insufficient_aal', message: 'AAL2 is required to update password when MFA is enabled.' }, 401);
      passwords.set(id, JSON.parse(options.body).password);
    }
    return respond(chair
      ? { id: chairId, email: "chair@example.edu", factors }
      : { id: memberId, email: "member@example.edu" });
  }
  if (url.pathname.startsWith("/auth/v1/admin/users/") && options.method === "PUT") {
    const id = url.pathname.split("/").at(-1);
    if (!passwords.has(id)) return respond({ error: "not found" }, 404);
    const password = JSON.parse(options.body).password;
    if (password === "provider-failure-test-password")
      return respond({ error: "temporary provider failure" }, 503);
    passwords.set(id, password);
    return respond({ id, email: id === chairId ? "chair@example.edu" : "member@example.edu" });
  }
  if (url.pathname.startsWith("/auth/v1/admin/users/") && options.method === "DELETE")
    return respond({});
  return respond({ error: "unexpected mock request" }, 404);
};
