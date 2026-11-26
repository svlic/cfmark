import { AppError } from "./model";
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LOGIN_LIMITER: RateLimit;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
}
const encoder = new TextEncoder();
export function configured(env: Env): boolean {
  return (
    typeof env.ADMIN_USERNAME === "string" &&
    !!env.ADMIN_USERNAME.trim() &&
    encoder.encode(env.ADMIN_USERNAME).length <= 320 &&
    typeof env.ADMIN_PASSWORD === "string" &&
    env.ADMIN_PASSWORD.length >= 20 &&
    encoder.encode(env.ADMIN_PASSWORD).length <= 1024
  );
}
export function requireConfig(env: Env) {
  if (!configured(env) || !env.LOGIN_LIMITER)
    throw new AppError(
      503,
      "CONFIGURATION",
      "部署配置尚未完成，请检查管理员 Secrets 与登录限流绑定",
    );
}
async function digest(s: string) {
  return crypto.subtle.digest("SHA-256", encoder.encode(s));
}
export async function credentials(
  env: Env,
  username: string,
  password: string,
) {
  const [a, b, c, d] = await Promise.all([
    digest(username),
    digest(env.ADMIN_USERNAME),
    digest(password),
    digest(env.ADMIN_PASSWORD),
  ]);
  const user = crypto.subtle.timingSafeEqual(a, b);
  const pass = crypto.subtle.timingSafeEqual(c, d);
  return user && pass;
}
const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
// HMAC binds lookup values to both current credentials without persisting a password verifier.
export async function sessionHash(env: Env, token: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(JSON.stringify([env.ADMIN_USERNAME, env.ADMIN_PASSWORD])),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(token)));
}
export function local(request: Request): boolean {
  const u = new URL(request.url);
  return (
    u.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
  );
}
export const cookieName = (r: Request): string =>
  local(r) ? "dev-session" : "__Host-session";
export function cookie(r: Request, token: string, age?: number): string {
  return `${cookieName(r)}=${token}; Path=/; HttpOnly; SameSite=Strict${local(r) ? "" : "; Secure"}${age === undefined ? "" : `; Max-Age=${age}`}`;
}
export function tokenFrom(r: Request): string | null {
  const token = (r.headers.get("cookie") || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${cookieName(r)}=`))
    ?.split("=")[1];
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function authenticated(r: Request, env: Env): Promise<boolean> {
  const token = tokenFrom(r);
  if (!token) return false;
  return !!(await env.DB.prepare(
    "SELECT 1 FROM sessions WHERE id_hash=? AND expires_at>?",
  )
    .bind(await sessionHash(env, token), Math.floor(Date.now() / 1000))
    .first());
}
export async function login(
  r: Request,
  env: Env,
  body: Record<string, unknown>,
): Promise<string> {
  requireConfig(env);
  const ip = r.headers.get("CF-Connecting-IP");
  if (!ip && !local(r))
    throw new AppError(503, "CLIENT_IP", "无法获取可信客户端地址");
  const rate = await env.LOGIN_LIMITER.limit({
    key: `login:${ip || "localhost"}`,
  });
  if (!rate.success)
    throw new AppError(429, "RATE_LIMIT", "登录尝试过于频繁，请在一分钟后重试");
  if (
    typeof body.username !== "string" ||
    typeof body.password !== "string" ||
    encoder.encode(body.username).length > 320 ||
    encoder.encode(body.password).length > 1024 ||
    !(await credentials(env, body.username, body.password))
  )
    throw new AppError(401, "LOGIN_FAILED", "用户名或密码错误");
  const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const now = Math.floor(Date.now() / 1000),
    age = body.remember === true ? 2592000 : 86400;
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM sessions WHERE id_hash IN (SELECT id_hash FROM sessions WHERE expires_at<=? LIMIT 100)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO sessions(id_hash,created_at,expires_at) VALUES(?,?,?)",
    ).bind(await sessionHash(env, token), now, now + age),
  ]);
  return cookie(r, token, body.remember === true ? age : undefined);
}
