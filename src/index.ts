import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  authenticated,
  cookie,
  login,
  requireConfig,
  sessionHash,
  tokenFrom,
  local,
  type Env,
} from "./auth";
import {
  AppError,
  accountInput,
  accounts,
  basics,
  duplicate,
  fail,
  id,
  normalized,
  object,
  str,
  url,
  type Account,
} from "./model";
import { commitImport, exportBackup, exportCSV, prepareImport } from "./backup";
type Bindings = { Bindings: Env; Variables: { body: Record<string, unknown> } };
const app = new Hono<Bindings>();
app.onError((error, c) => {
  if (error instanceof AppError)
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
        },
      },
      error.status as ContentfulStatusCode,
    );
  // Do not log D1 errors: a driver message may contain bound personal data.
  return c.json(
    {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "数据服务暂时不可用，请稍后重试；输入与已有数据不会被主动清空",
      },
    },
    503,
  );
});
app.use("*", async (c, next) => {
  await next();
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Cache-Control", "no-store");
  if (new URL(c.req.url).protocol === "https:")
    c.header("Strict-Transport-Security", "max-age=31536000");
});
app.use("*", async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method)) {
    const u = new URL(c.req.url);
    if (
      (!local(c.req.raw) && u.protocol !== "https:") ||
      c.req.header("Origin") !== u.origin
    )
      throw new AppError(403, "ORIGIN", "拒绝跨站或缺少 Origin 的写入请求");
  }
  await next();
});
app.use("/api/*", async (c, next) => {
  requireConfig(c.env);
  if (
    c.req.path !== "/api/auth/login" &&
    !(await authenticated(c.req.raw, c.env))
  )
    throw new AppError(401, "UNAUTHENTICATED", "登录已过期，请重新登录");
  if (["POST", "PUT", "DELETE"].includes(c.req.method)) {
    if (
      c.req.method === "DELETE" &&
      /^\/api\/(accounts|platforms|categories)\/\d+$/.test(c.req.path)
    ) {
      c.set("body", {});
      await next();
      return;
    }
    if (
      c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    )
      throw new AppError(400, "CONTENT_TYPE", "请使用 application/json 请求");
    const max = c.req.path.startsWith("/api/backup/")
      ? 6 * 1048576 + 1024
      : 32768;
    const reader = c.req.raw.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) {
          await reader.cancel();
          throw new AppError(413, "BODY_TOO_LARGE", "请求内容过大");
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      );
    } catch {
      return fail("JSON 请求格式错误");
    }
    c.set("body", object(parsed));
  }
  await next();
});
app.post("/api/auth/login", async (c) => {
  c.header("Set-Cookie", await login(c.req.raw, c.env, c.get("body")));
  return c.json({ data: { authenticated: true } });
});
app.get("/api/auth/session", (c) => c.json({ data: { authenticated: true } }));
app.post("/api/auth/logout", async (c) => {
  const token = tokenFrom(c.req.raw)!;
  await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash=?")
    .bind(await sessionHash(c.env, token))
    .run();
  c.header("Set-Cookie", cookie(c.req.raw, "", 0));
  return c.json({ data: { loggedOut: true } });
});
app.get("/api/accounts", async (c) =>
  c.json({ data: await accounts(c.env.DB) }),
);
app.get("/api/accounts/:id", async (c) => {
  const a = (await accounts(c.env.DB)).find(
    (a) => a.id === id(c.req.param("id")),
  );
  if (!a) throw new AppError(404, "NOT_FOUND", "帐号不存在");
  return c.json({ data: a });
});
async function saveAccount(c: Context<Bindings>, edit: boolean) {
  const db = c.env.DB,
    v = c.get("body"),
    input = accountInput(v),
    aId = edit ? id(c.req.param("id")) : null;
  const all = await accounts(db);
  if (edit && !all.some((a) => a.id === aId))
    throw new AppError(404, "NOT_FOUND", "帐号不存在");
  const base = await basics(db);
  const statements: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  let pId: number,
    cId: number | null = null;
  if (v.platform_name) {
    const name = str(v.platform_name, 100, "平台名称", true)!,
      found = base.platforms.find(
        (p) => normalized(p.name) === normalized(name),
      );
    pId = found?.id ?? Math.max(0, ...base.platforms.map((p) => p.id)) + 1;
    if (!found)
      statements.push(
        db
          .prepare(
            "INSERT INTO platforms(id,name,default_url,created_at,updated_at) VALUES(?,?,?,?,?)",
          )
          .bind(pId, name, url(v.platform_url), now, now),
      );
  } else {
    pId = id(v.platform_id);
    if (!base.platforms.some((p) => p.id === pId))
      return fail("所选平台不存在");
  }
  if (v.category_name) {
    const name = str(v.category_name, 50, "分类名称", true)!,
      found = base.categories.find(
        (c) => normalized(c.name) === normalized(name),
      );
    cId = found?.id ?? Math.max(0, ...base.categories.map((c) => c.id)) + 1;
    if (!found)
      statements.push(
        db
          .prepare(
            "INSERT INTO categories(id,name,sort_order,created_at) VALUES(?,?,?,?)",
          )
          .bind(cId, name, base.categories.length, now),
      );
  } else if (v.category_id) {
    cId = id(v.category_id);
    if (!base.categories.some((c) => c.id === cId))
      return fail("所选分类不存在");
  }
  if (
    v.confirmDuplicate !== true &&
    all.some(
      (a) => a.id !== aId && duplicate({ ...input, platform_id: pId }, a),
    )
  )
    throw new AppError(
      409,
      "DUPLICATE",
      "发现同平台可能重复的帐号，是否仍要保存？",
    );
  let savedId = aId;
  if (edit)
    statements.push(
      db
        .prepare(
          "UPDATE accounts SET platform_id=?,username=?,login_url=?,email=?,phone=?,notes=?,category_id=?,tags=?,updated_at=? WHERE id=?",
        )
        .bind(
          pId,
          input.username,
          input.login_url,
          input.email,
          input.phone,
          input.notes,
          cId,
          JSON.stringify(input.tags),
          now,
          aId,
        ),
    );
  else {
    savedId = Math.max(0, ...all.map((a) => a.id)) + 1;
    statements.push(
      db
        .prepare(
          "INSERT INTO accounts(id,platform_id,username,login_url,email,phone,notes,category_id,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          savedId,
          pId,
          input.username,
          input.login_url,
          input.email,
          input.phone,
          input.notes,
          cId,
          JSON.stringify(input.tags),
          now,
          now,
        ),
    );
  }
  await db.batch(statements);
  return c.json({ data: (await accounts(db)).find((a) => a.id === savedId) });
}
app.post("/api/accounts", (c) => saveAccount(c, false));
app.put("/api/accounts/:id", (c) => saveAccount(c, true));
app.delete("/api/accounts/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM accounts WHERE id=?")
    .bind(id(c.req.param("id")))
    .run();
  if (!r.meta.changes) throw new AppError(404, "NOT_FOUND", "帐号不存在");
  return c.json({ data: { deleted: true } });
});
for (const kind of ["platforms", "categories"] as const) {
  app.get(`/api/${kind}`, async (c) =>
    c.json({ data: (await basics(c.env.DB))[kind] }),
  );
  const save = async (c: Parameters<typeof saveAccount>[0], edit: boolean) => {
    const v = c.get("body"),
      name = str(v.name, kind === "platforms" ? 100 : 50, "名称", true)!,
      rows = (await basics(c.env.DB))[kind];
    const target = edit ? id(c.req.param("id")) : null;
    if (edit && !rows.some((r) => r.id === target))
      throw new AppError(404, "NOT_FOUND", "记录不存在");
    if (
      rows.some(
        (r) => r.id !== target && normalized(r.name) === normalized(name),
      )
    )
      throw new AppError(409, "NAME_EXISTS", "名称已存在（不区分大小写）");
    let sort = 0;
    if (kind === "categories") {
      sort = v.sort_order == null ? rows.length : Number(v.sort_order);
      if (!Number.isSafeInteger(sort) || Math.abs(sort) > 1000000)
        return fail("排序必须是合理的整数");
    }
    const now = new Date().toISOString();
    const statement =
      kind === "platforms"
        ? edit
          ? c.env.DB.prepare(
              "UPDATE platforms SET name=?,default_url=?,updated_at=? WHERE id=?",
            ).bind(name, url(v.default_url), now, target)
          : c.env.DB.prepare(
              "INSERT INTO platforms(name,default_url) VALUES(?,?)",
            ).bind(name, url(v.default_url))
        : edit
          ? c.env.DB.prepare(
              "UPDATE categories SET name=?,sort_order=? WHERE id=?",
            ).bind(name, sort, target)
          : c.env.DB.prepare(
              "INSERT INTO categories(name,sort_order) VALUES(?,?)",
            ).bind(name, sort);
    const result = await statement.run();
    return c.json({
      data: (await basics(c.env.DB))[kind].find(
        (r) => r.id === (target ?? result.meta.last_row_id),
      ),
    });
  };
  app.post(`/api/${kind}`, (c) => save(c, false));
  app.put(`/api/${kind}/:id`, (c) => save(c, true));
  app.delete(`/api/${kind}/:id`, async (c) => {
    const target = id(c.req.param("id")),
      db = c.env.DB;
    if (!(await basics(db))[kind].some((r) => r.id === target))
      throw new AppError(404, "NOT_FOUND", "记录不存在");
    if (
      kind === "platforms" &&
      (await db
        .prepare("SELECT 1 FROM accounts WHERE platform_id=? LIMIT 1")
        .bind(target)
        .first())
    )
      throw new AppError(409, "IN_USE", "平台仍有关联帐号，请先迁移或删除帐号");
    if (kind === "categories")
      await db.batch([
        db
          .prepare(
            "UPDATE accounts SET category_id=NULL,updated_at=? WHERE category_id=?",
          )
          .bind(new Date().toISOString(), target),
        db.prepare("DELETE FROM categories WHERE id=?").bind(target),
      ]);
    else
      await db.prepare("DELETE FROM platforms WHERE id=?").bind(target).run();
    return c.json({ data: { deleted: true } });
  });
}
app.get("/api/tags", async (c) =>
  c.json({
    data: [
      ...new Set((await accounts(c.env.DB)).flatMap((a) => a.tags)),
    ].sort(),
  }),
);
for (const method of ["put", "delete"] as const)
  app[method]("/api/tags", async (c) => {
    const v = c.get("body"),
      name = str(v.name, 50, "标签", true)!,
      replacement =
        method === "put" ? str(v.newName, 50, "新标签", true) : null;
    const all = await accounts(c.env.DB),
      changed = all.filter((a) => a.tags.includes(name));
    if (!changed.length) throw new AppError(404, "NOT_FOUND", "标签不存在");
    const payload = changed.map((a) => ({
      id: a.id,
      tags: [
        ...new Set(
          a.tags.flatMap((t) =>
            t === name ? (replacement ? [replacement] : []) : [t],
          ),
        ),
      ],
    }));
    await c.env.DB.prepare(
      `UPDATE accounts SET tags=(SELECT json_extract(value,'$.tags') FROM json_each(?) WHERE json_extract(value,'$.id')=accounts.id),updated_at=? WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`,
    )
      .bind(
        JSON.stringify(payload),
        new Date().toISOString(),
        JSON.stringify(payload),
      )
      .run();
    return c.json({ data: { updated: changed.length } });
  });
app.get("/api/backup/export", async (c) => {
  c.header(
    "Content-Disposition",
    'attachment; filename="account-space-backup.json"',
  );
  return c.json(await exportBackup(c.env.DB));
});
app.get("/api/backup/csv", async (c) => {
  c.header("Content-Disposition", 'attachment; filename="account-space.csv"');
  c.header("Content-Type", "text/csv; charset=utf-8");
  return c.body(await exportCSV(c.env.DB));
});
app.post("/api/backup/preview", async (c) =>
  c.json({ data: (await prepareImport(c.env.DB, c.get("body"))).preview }),
);
app.post("/api/backup/import", async (c) => {
  const body = c.get("body");
  if (body.confirm !== true) return fail("请先预览并明确确认导入");
  const plan = await prepareImport(c.env.DB, body);
  if (plan.preview.errors.length)
    return fail(
      `导入包含 ${plan.preview.errors.length} 个错误，未写入任何数据`,
    );
  await commitImport(c.env.DB, plan.backup, plan.replace);
  return c.json({ data: plan.preview });
});
app.all("/api", (c) =>
  c.json({ error: { code: "NOT_FOUND", message: "接口不存在" } }, 404),
);
app.all("/api/*", (c) =>
  c.json({ error: { code: "NOT_FOUND", message: "接口不存在" } }, 404),
);
app.get("*", async (c) => {
  const path = c.req.path;
  const publicAsset =
    path === "/login" ||
    path === "/login.html" ||
    path === "/favicon.svg" ||
    /^\/(css|js)\/[a-zA-Z0-9_./-]+\.(css|js)$/.test(path);
  if (!publicAsset) {
    requireConfig(c.env);
    if (!(await authenticated(c.req.raw, c.env)))
      return c.redirect("/login", 302);
  }
  const u = new URL(c.req.url);
  if (path === "/login") u.pathname = "/login.html";
  if (path === "/") u.pathname = "/index.html";
  const res = await c.env.ASSETS.fetch(new Request(u, c.req.raw));
  return new Response(res.body, { status: res.status, headers: res.headers });
});
export default app;
