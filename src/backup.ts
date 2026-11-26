import Papa from "papaparse";
import {
  AppError,
  accountInput,
  duplicate,
  fail,
  id,
  normalized,
  object,
  str,
  url,
  type Account,
  type Category,
  type Platform,
} from "./model";
export const columns = [
  "所属平台",
  "登录帐号",
  "登录网址",
  "绑定邮箱",
  "绑定手机号",
  "帐号备注",
  "自定义分类",
  "标签",
];
export interface Backup {
  schemaVersion: 1;
  exportedAt: string;
  platforms: Platform[];
  categories: Category[];
  accounts: Account[];
}
const array = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : fail("备份缺少有效数组");
function timestamp(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d\d-\d\dT.*Z$/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    return fail("时间戳必须为有效 UTC ISO 时间");
  return v;
}
function unique<T>(values: T[], key: (v: T) => unknown, label: string) {
  if (new Set(values.map(key)).size !== values.length) fail(`${label}重复`);
}
export function validateBackup(raw: unknown): Backup {
  const v = object(raw);
  if (v.schemaVersion !== 1)
    return fail("不支持的 schemaVersion，请使用版本 1 备份");
  const platforms = array(v.platforms).map((x) => {
    const p = object(x);
    return {
      id: id(p.id),
      name: str(p.name, 100, "平台名称", true)!,
      default_url: url(p.default_url),
      created_at: timestamp(p.created_at),
      updated_at: timestamp(p.updated_at),
    };
  });
  const categories = array(v.categories).map((x) => {
    const c = object(x);
    if (!Number.isSafeInteger(c.sort_order)) return fail("分类排序无效");
    return {
      id: id(c.id),
      name: str(c.name, 50, "分类名称", true)!,
      sort_order: c.sort_order as number,
      created_at: timestamp(c.created_at),
    };
  });
  const rows = array(v.accounts);
  if (rows.length > 500 || platforms.length > 1000 || categories.length > 1000)
    throw new AppError(
      413,
      "IMPORT_LIMIT",
      "每次最多恢复 500 个帐号、1000 个平台或分类",
    );
  const a = rows.map((x) => {
    const r = object(x);
    const a = {
      ...accountInput(r),
      id: id(r.id),
      platform_id: id(r.platform_id),
      category_id: r.category_id == null ? null : id(r.category_id),
      created_at: timestamp(r.created_at),
      updated_at: timestamp(r.updated_at),
    };
    if (
      !platforms.some((p) => p.id === a.platform_id) ||
      (a.category_id !== null &&
        !categories.some((c) => c.id === a.category_id))
    )
      return fail(`帐号 ${a.id} 引用了不存在的平台或分类`);
    return a;
  });
  unique(platforms, (p) => p.id, "平台 ID");
  unique(platforms, (p) => normalized(p.name), "平台名称");
  unique(categories, (c) => c.id, "分类 ID");
  unique(categories, (c) => normalized(c.name), "分类名称");
  unique(a, (a) => a.id, "帐号 ID");
  return {
    schemaVersion: 1,
    exportedAt: timestamp(v.exportedAt),
    platforms,
    categories,
    accounts: a,
  };
}
export async function exportBackup(db: D1Database): Promise<Backup> {
  // Read one transactional snapshot so concurrent edits cannot break backup relationships.
  const [p, c, a] = await db.batch([
    db.prepare(
      "SELECT id,name,default_url,created_at,updated_at FROM platforms ORDER BY name COLLATE NOCASE,id",
    ),
    db.prepare(
      "SELECT id,name,sort_order,created_at FROM categories ORDER BY sort_order,name COLLATE NOCASE,id",
    ),
    db.prepare(
      "SELECT id,platform_id,username,login_url,email,phone,notes,category_id,tags,created_at,updated_at FROM accounts ORDER BY updated_at DESC,id DESC",
    ),
  ]);
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    platforms: p.results as unknown as Platform[],
    categories: c.results as unknown as Category[],
    accounts: (
      a.results as unknown as (Omit<Account, "tags"> & { tags: string })[]
    ).map((row) => ({ ...row, tags: JSON.parse(row.tags) as string[] })),
  };
}
function csvSafe(v: string | null | undefined): string {
  const s = v || "";
  return /^[\s]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s) ? `'${s}` : s;
}
export async function exportCSV(db: D1Database): Promise<string> {
  const b = await exportBackup(db);
  return (
    "\uFEFF" +
    Papa.unparse({
      fields: columns,
      data: b.accounts.map((a) =>
        [
          b.platforms.find((p) => p.id === a.platform_id)!.name,
          a.username,
          a.login_url ??
            b.platforms.find((p) => p.id === a.platform_id)!.default_url,
          a.email,
          a.phone,
          a.notes,
          b.categories.find((c) => c.id === a.category_id)?.name,
          JSON.stringify(a.tags),
        ].map(csvSafe),
      ),
    })
  );
}
export interface Preview {
  platforms: number;
  categories: number;
  accounts: number;
  valid: number;
  duplicates: number;
  errors: { row: number; message: string }[];
  replacing?: { platforms: number; categories: number; accounts: number };
}
export async function prepareImport(
  db: D1Database,
  body: Record<string, unknown>,
): Promise<{ preview: Preview; backup: Backup; replace: boolean }> {
  if (typeof body.content !== "string") return fail("请选择导入文件");
  if (new TextEncoder().encode(body.content).length > 1048576)
    throw new AppError(413, "FILE_TOO_LARGE", "文件不能超过 1 MiB");
  const current = await exportBackup(db);
  let backup: Backup;
  const preview: Preview = {
    platforms: 0,
    categories: 0,
    accounts: 0,
    valid: 0,
    duplicates: 0,
    errors: [],
  };
  if (body.format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.content);
    } catch {
      return fail("JSON 文件格式错误");
    }
    backup = validateBackup(parsed);
    preview.replacing = {
      accounts: current.accounts.length,
      platforms: current.platforms.length,
      categories: current.categories.length,
    };
    preview.duplicates = backup.accounts.filter((a, i, all) =>
      all.slice(0, i).some((b) => duplicate(a, b)),
    ).length;
    preview.valid = backup.accounts.length;
  } else if (body.format === "csv") {
    const parsed = Papa.parse<string[]>(body.content.replace(/^\uFEFF/, ""), {
      skipEmptyLines: "greedy",
    });
    if (parsed.data.length - 1 > 500)
      throw new AppError(413, "IMPORT_LIMIT", "每次最多导入 500 个帐号");
    parsed.errors.forEach((e) =>
      preview.errors.push({
        row: (e.row ?? 0) + 1,
        message: `CSV 格式错误：${e.message}`,
      }),
    );
    const header = parsed.data.shift();
    if (
      !header ||
      header.length !== columns.length ||
      !header.every((v, i) => v === columns[i])
    )
      return fail(`CSV 表头必须为：${columns.join(",")}`);
    backup = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      platforms: [],
      categories: [],
      accounts: [],
    };
    let nextP = Math.max(0, ...current.platforms.map((p) => p.id)) + 1,
      nextC = Math.max(0, ...current.categories.map((c) => c.id)) + 1,
      nextA = Math.max(0, ...current.accounts.map((a) => a.id)) + 1;
    for (const [index, row] of parsed.data.entries()) {
      try {
        if (row.length !== 8) fail("列数必须为 8");
        const [
          platform,
          username,
          login_url,
          email,
          phone,
          notes,
          category,
          tagText,
        ] = row;
        let tagValue: unknown = [];
        try {
          tagValue = tagText ? JSON.parse(tagText) : [];
        } catch {
          fail("标签列必须是 JSON 数组");
        }
        const input = accountInput({
          username,
          login_url,
          email,
          phone,
          notes,
          tags: tagValue,
        });
        const pName = str(platform, 100, "所属平台", true)!,
          cName = str(category, 50, "自定义分类");
        let p = [...current.platforms, ...backup.platforms].find(
          (p) => normalized(p.name) === normalized(pName),
        );
        if (!p) {
          p = {
            id: nextP++,
            name: pName,
            default_url: null,
            created_at: backup.exportedAt,
            updated_at: backup.exportedAt,
          };
          backup.platforms.push(p);
        }
        let c = cName
          ? [...current.categories, ...backup.categories].find(
              (c) => normalized(c.name) === normalized(cName),
            )
          : null;
        if (cName && !c) {
          c = {
            id: nextC++,
            name: cName,
            sort_order: current.categories.length + backup.categories.length,
            created_at: backup.exportedAt,
          };
          backup.categories.push(c);
        }
        const a: Account = {
          ...input,
          id: nextA++,
          platform_id: p.id,
          category_id: c?.id ?? null,
          created_at: backup.exportedAt,
          updated_at: backup.exportedAt,
        };
        const exists = [...current.accounts, ...backup.accounts].some((b) =>
          duplicate(a, b),
        );
        if (exists) preview.duplicates++;
        preview.valid++;
        if (!exists || body.keepDuplicates === true) backup.accounts.push(a);
      } catch (error) {
        preview.errors.push({
          row: index + 2,
          message: error instanceof AppError ? error.message : "行数据无效",
        });
      }
    }
    // Do not create unused base records from invalid/skipped rows.
    backup.platforms = backup.platforms.filter((p) =>
      backup.accounts.some((a) => a.platform_id === p.id),
    );
    backup.categories = backup.categories.filter((c) =>
      backup.accounts.some((a) => a.category_id === c.id),
    );
  } else return fail("文件格式必须为 json 或 csv");
  preview.accounts = backup.accounts.length;
  preview.platforms = backup.platforms.length;
  preview.categories = backup.categories.length;
  return { preview, backup, replace: body.format === "json" };
}
// One bound JSON value per table keeps 500-record imports below Free's 50-query/100-parameter limits.
export async function commitImport(
  db: D1Database,
  b: Backup,
  replace: boolean,
) {
  const statements: D1PreparedStatement[] = [];
  if (replace)
    statements.push(
      db.prepare("DELETE FROM accounts"),
      db.prepare("DELETE FROM platforms"),
      db.prepare("DELETE FROM categories"),
    );
  statements.push(
    db
      .prepare(
        `INSERT INTO platforms(id,name,default_url,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.default_url'),json_extract(value,'$.created_at'),json_extract(value,'$.updated_at') FROM json_each(?)`,
      )
      .bind(JSON.stringify(b.platforms)),
    db
      .prepare(
        `INSERT INTO categories(id,name,sort_order,created_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.sort_order'),json_extract(value,'$.created_at') FROM json_each(?)`,
      )
      .bind(JSON.stringify(b.categories)),
    db
      .prepare(
        `INSERT INTO accounts(id,platform_id,username,login_url,email,phone,notes,category_id,tags,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.platform_id'),json_extract(value,'$.username'),json_extract(value,'$.login_url'),json_extract(value,'$.email'),json_extract(value,'$.phone'),json_extract(value,'$.notes'),json_extract(value,'$.category_id'),json_extract(value,'$.tags'),json_extract(value,'$.created_at'),json_extract(value,'$.updated_at') FROM json_each(?)`,
      )
      .bind(JSON.stringify(b.accounts)),
  );
  await db.batch(statements);
}
