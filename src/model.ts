export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}
export const fail = (
  message: string,
  fields?: Record<string, string>,
): never => {
  throw new AppError(400, "VALIDATION", message, fields);
};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("数据结构无效");
  return value as Record<string, unknown>;
}
export function str(
  value: unknown,
  max: number,
  field: string,
  required = false,
): string | null {
  if (value === undefined || value === null) {
    if (required) return fail(`请填写${field}`, { [field]: "必填" });
    return null;
  }
  if (typeof value !== "string") return fail(`${field}必须为文本`);
  const s = value.trim();
  if (s.length > max || (required && !s))
    return fail(`${field}${!s ? "不能为空" : `不能超过 ${max} 字符`}`, {
      [field]: "长度无效",
    });
  return s || null;
}
export function url(value: unknown): string | null {
  const s = str(value, 2048, "登录网址");
  if (!s) return null;
  try {
    const u = new URL(s);
    if (["http:", "https:"].includes(u.protocol) && !u.username && !u.password)
      return s;
  } catch {
    /* invalid */
  }
  return fail("登录网址必须是有效的 http/https 地址，且不能包含凭据");
}
export const emailValid = (s: string): boolean =>
  /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(s) && s.length <= 254;
export const normalized = (s: string): string => s.trim().toLowerCase();
export function tags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20)
    return fail("标签必须为最多 20 项的数组");
  return [...new Set(value.map((v) => str(v, 50, "标签", true)!))];
}
export function id(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(n) || n < 1) return fail("ID 无效");
  return n;
}
export interface Platform {
  id: number;
  name: string;
  default_url: string | null;
  created_at?: string;
  updated_at?: string;
}
export interface Category {
  id: number;
  name: string;
  sort_order: number;
  created_at?: string;
}
export interface Account {
  id: number;
  platform_id: number;
  username: string | null;
  login_url: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  category_id: number | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}
export function accountInput(v: Record<string, unknown>) {
  const a = {
    username: str(v.username, 320, "登录帐号"),
    login_url: url(v.login_url),
    email: str(v.email, 254, "绑定邮箱"),
    phone: str(v.phone, 50, "绑定手机号"),
    notes: str(v.notes, 2000, "帐号备注"),
    tags: tags(v.tags),
  };
  if (!a.username && !a.email && !a.phone)
    return fail("登录帐号、绑定邮箱、绑定手机号至少填写一项", {
      username: "至少填写一项",
      email: "至少填写一项",
      phone: "至少填写一项",
    });
  if (a.email && !emailValid(a.email))
    return fail("绑定邮箱格式无效", { email: "请输入有效邮箱" });
  return a;
}
export function duplicate(
  a: Pick<Account, "platform_id" | "username" | "email" | "phone">,
  b: Pick<Account, "platform_id" | "username" | "email" | "phone">,
): boolean {
  if (a.platform_id !== b.platform_id) return false;
  if (a.username && b.username)
    return emailValid(a.username) && emailValid(b.username)
      ? normalized(a.username) === normalized(b.username)
      : a.username === b.username;
  if (a.username || b.username) return false;
  if (a.email && b.email) return normalized(a.email) === normalized(b.email);
  return !a.email && !b.email && !!a.phone && a.phone === b.phone;
}
export async function accounts(db: D1Database): Promise<Account[]> {
  const r = await db
    .prepare(
      `SELECT a.*, p.name platform_name, p.default_url, COALESCE(a.login_url,p.default_url) effective_url, c.name category_name FROM accounts a JOIN platforms p ON p.id=a.platform_id LEFT JOIN categories c ON c.id=a.category_id ORDER BY a.updated_at DESC,a.id DESC`,
    )
    .all<Omit<Account, "tags"> & { tags: string }>();
  return r.results.map((a) => ({ ...a, tags: JSON.parse(a.tags) as string[] }));
}
export async function basics(db: D1Database) {
  const [p, c] = await db.batch<Platform | Category>([
    db.prepare("SELECT * FROM platforms ORDER BY name COLLATE NOCASE,id"),
    db.prepare(
      "SELECT * FROM categories ORDER BY sort_order,name COLLATE NOCASE,id",
    ),
  ]);
  return {
    platforms: p.results as Platform[],
    categories: c.results as Category[],
  };
}
