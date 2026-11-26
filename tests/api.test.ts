/// <reference types="@cloudflare/vitest-plugin/types" />
import { env, applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/auth";
import type { Account, Category, Platform } from "../src/model";
import type { Backup } from "../src/backup";
import Papa from "papaparse";

const testEnv = env as unknown as Env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
let bindings: Env, session: string;
let ipCounter = 0;
const origin = "https://account.example";
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = session,
  extra: Record<string, string> = {},
) {
  return app.request(
    origin + path,
    {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "CF-Connecting-IP": `192.0.2.${++ipCounter}`,
        ...(cookie ? { Cookie: cookie } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
  );
}
async function data<T>(r: Response): Promise<T> {
  expect(r.status).toBe(200);
  return ((await r.json()) as { data: T }).data;
}
async function create(input: Record<string, unknown>): Promise<Account> {
  return data(
    await request("/api/accounts", "POST", {
      platform_name: "GitHub",
      email: "a@example.com",
      ...input,
    }),
  );
}
async function backup(): Promise<Backup> {
  const r = await request("/api/backup/export");
  expect(r.status).toBe(200);
  return r.json();
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  bindings = {
    ...testEnv,
    ADMIN_USERNAME: "test-admin",
    ADMIN_PASSWORD: "only-test-fixture-long-password-29",
  };
  session = "";
  const r = await request("/api/auth/login", "POST", {
    username: bindings.ADMIN_USERNAME,
    password: bindings.ADMIN_PASSWORD,
  });
  expect(r.status).toBe(200);
  session = r.headers.get("Set-Cookie")!.split(";")[0];
});
describe("authentication and security", () => {
  it("requires auth for all business APIs, backups, unknown API and direct HTML", async () => {
    for (const path of [
      "/api/accounts",
      "/api/platforms",
      "/api/categories",
      "/api/tags",
      "/api/backup/export",
      "/api/backup/csv",
      "/api/missing",
      "/api",
    ])
      expect((await request(path, "GET", undefined, "")).status).toBe(401);
    expect((await request("/", "GET", undefined, "")).status).toBe(302);
    expect((await request("/index.html", "GET", undefined, "")).status).toBe(
      302,
    );
    expect(
      (
        await request(
          "/api/accounts",
          "GET",
          undefined,
          "__Host-session=" + "a".repeat(64),
        )
      ).status,
    ).toBe(401);
    const missing = await request("/api/missing");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Type")).toContain("application/json");
  });
  it("accepts eight-character passwords and fails closed for invalid configuration", async () => {
    for (const change of [
      { ADMIN_PASSWORD: "" },
      { ADMIN_PASSWORD: "1234567" },
      { ADMIN_USERNAME: "" },
      { LOGIN_LIMITER: undefined },
    ]) {
      const b = { ...bindings, ...change } as Env;
      expect((await app.request(origin + "/api/accounts", {}, b)).status).toBe(
        503,
      );
    }
    bindings.ADMIN_PASSWORD = "test-8pw";
    const login = await request("/api/auth/login", "POST", {
      username: bindings.ADMIN_USERNAME,
      password: bindings.ADMIN_PASSWORD,
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("Set-Cookie")!.split(";")[0];
    expect(
      (await request("/api/auth/session", "GET", undefined, cookie)).status,
    ).toBe(200);
  });
  it("uses uniform failures, preserves password whitespace and limits attempts", async () => {
    for (const input of [
      { username: "wrong", password: bindings.ADMIN_PASSWORD },
      { username: bindings.ADMIN_USERNAME, password: "wrong" },
      {
        username: bindings.ADMIN_USERNAME,
        password: bindings.ADMIN_PASSWORD + " ",
      },
    ]) {
      const r = await request("/api/auth/login", "POST", input);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({
        error: { code: "LOGIN_FAILED", message: "用户名或密码错误" },
      });
    }
    const ip = `198.51.100.${++ipCounter}`;
    const codes = [];
    for (let i = 0; i < 6; i++)
      codes.push(
        (
          await request(
            "/api/auth/login",
            "POST",
            { username: "x", password: "x" },
            "",
            { "CF-Connecting-IP": ip },
          )
        ).status,
      );
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  });
  it("sets production cookie, hashes tokens, expires and revokes sessions including credential rotation", async () => {
    const r = await request("/api/auth/login", "POST", {
      username: bindings.ADMIN_USERNAME,
      password: bindings.ADMIN_PASSWORD,
      remember: true,
    });
    expect(r.headers.get("Set-Cookie")).toMatch(
      /^__Host-session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=2592000$/,
    );
    const stored = await bindings.DB.prepare("SELECT * FROM sessions").all<{
      id_hash: string;
      expires_at: number;
      created_at: number;
    }>();
    expect(stored.results.every((x) => !session.includes(x.id_hash))).toBe(
      true,
    );
    expect(
      stored.results.some((x) => x.expires_at - x.created_at === 2592000),
    ).toBe(true);
    const original = bindings.ADMIN_PASSWORD;
    bindings.ADMIN_PASSWORD += "changed";
    expect((await request("/api/accounts")).status).toBe(401);
    bindings.ADMIN_PASSWORD = original;
    const out = await request("/api/auth/logout", "POST", {});
    expect(out.status).toBe(200);
    expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await request("/api/accounts")).status).toBe(401);
    await bindings.DB.prepare("UPDATE sessions SET expires_at=0").run();
    expect(
      (
        await request(
          "/api/accounts",
          "GET",
          undefined,
          r.headers.get("Set-Cookie")!.split(";")[0],
        )
      ).status,
    ).toBe(401);
  });
  it("rejects cross-origin/missing-origin writes and invalid bodies, provides no-store and CSP", async () => {
    for (const path of [
      "/api/accounts",
      "/api/auth/login",
      "/api/auth/logout",
      "/api/backup/import",
    ])
      expect(
        (
          await request(path, "POST", {}, session, {
            Origin: "https://evil.example",
          })
        ).status,
      ).toBe(403);
    const absent = await app.request(
      origin + "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      bindings,
    );
    expect(absent.status).toBe(403);
    expect(
      (
        await request("/api/accounts", "POST", {}, session, {
          "Content-Type": "text/plain",
        })
      ).status,
    ).toBe(400);
    const r = await request("/api/accounts");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(r.headers.get("Content-Security-Policy")).not.toContain(
      "unsafe-inline",
    );
    expect(
      (
        await request("/api/accounts", "POST", {
          platform_name: "A",
          username: "x".repeat(40000),
        })
      ).status,
    ).toBe(413);
  });
});
describe("account and base-data contracts", () => {
  it("allows email-only, phone-only and distinct accounts on one platform; refuses empty identities and unsafe URLs", async () => {
    const email = await create({ email: "  A@Example.com  ", username: "  " });
    expect(email.username).toBeNull();
    expect(email.email).toBe("A@Example.com");
    const phone = await create({ email: null, phone: "+86 0013800000000" });
    expect(phone.phone).toBe("+86 0013800000000");
    await create({ email: "b@example.com" });
    expect((await data<Account[]>(await request("/api/accounts"))).length).toBe(
      3,
    );
    expect(
      (
        await request("/api/accounts", "POST", {
          platform_name: "A",
          username: " ",
          email: " ",
          phone: " ",
        })
      ).status,
    ).toBe(400);
    for (const login_url of [
      "javascript:alert(1)",
      "data:text/html,hello",
      "https://user:pass@example.com",
    ])
      expect(
        (
          await request("/api/accounts", "POST", {
            platform_name: "A",
            username: "x",
            login_url,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await request("/api/accounts", "POST", {
          platform_name: "A",
          email: "a@@example.com",
        })
      ).status,
    ).toBe(400);
  });
  it("detects only defined duplicate candidates and allows explicit continuation/edit-self", async () => {
    const a = await create({ username: "person", email: "common@example.com" });
    await data(
      await request(`/api/accounts/${a.id}`, "PUT", { ...a, notes: "edited" }),
    );
    expect(
      (
        await request("/api/accounts", "POST", {
          platform_id: a.platform_id,
          username: "person",
        })
      ).status,
    ).toBe(409);
    await create({ username: "person", confirmDuplicate: true });
    await create({ username: "Person" });
    await create({ username: "different", email: "common@example.com" });
    const email = await create({
      email: "  Case@Example.com ",
      username: null,
    });
    expect(
      (
        await request("/api/accounts", "POST", {
          platform_id: email.platform_id,
          email: "case@example.com",
        })
      ).status,
    ).toBe(409);
    await create({ platform_name: "Cloudflare", email: "case@example.com" });
    await create({ email: "case+alias@example.com" });
    const phone = await create({ email: null, phone: "00123" });
    expect(
      (
        await request("/api/accounts", "POST", {
          platform_id: phone.platform_id,
          phone: "00123",
        })
      ).status,
    ).toBe(409);
  });
  it("inherits URL dynamically, restricts referenced platforms, and clears deleted categories", async () => {
    const a = await create({
      platform_url: "https://github.com/login",
      category_name: "临时分类",
    });
    const override = await create({
      username: "second",
      login_url: "https://github.com/other",
    });
    await data(
      await request(`/api/platforms/${a.platform_id}`, "PUT", {
        name: "GITHUB",
        default_url: "https://github.com/new",
      }),
    );
    const rows = await data<(Account & { effective_url: string })[]>(
      await request("/api/accounts"),
    );
    expect(rows.find((x) => x.id === a.id)!.effective_url).toBe(
      "https://github.com/new",
    );
    expect(rows.find((x) => x.id === override.id)!.effective_url).toBe(
      "https://github.com/other",
    );
    expect(
      (await request(`/api/platforms/${a.platform_id}`, "DELETE", {})).status,
    ).toBe(409);
    await data(await request(`/api/categories/${a.category_id}`, "DELETE", {}));
    expect(
      (await data<Account>(await request(`/api/accounts/${a.id}`))).category_id,
    ).toBeNull();
    await data(await request(`/api/accounts/${a.id}`, "DELETE", {}));
    expect((await request(`/api/accounts/${a.id}`)).status).toBe(404);
  });
  it("manages empty platforms/categories, unicode case-insensitive names, ordering, tags merge and delete", async () => {
    const p = await data<Platform>(
      await request("/api/platforms", "POST", { name: "ÄPlatform" }),
    );
    expect(
      (await request("/api/platforms", "POST", { name: "äplatform" })).status,
    ).toBe(409);
    await data(await request(`/api/platforms/${p.id}`, "DELETE", {}));
    const category = await data<Category>(
      await request("/api/categories", "POST", {
        name: "置顶",
        sort_order: -1,
      }),
    );
    expect(
      (await data<Category[]>(await request("/api/categories")))[0].id,
    ).toBe(category.id);
    const a = await create({ tags: ["工作", "重要", "工作"] });
    expect(a.tags).toEqual(["工作", "重要"]);
    await data(
      await request("/api/tags", "PUT", { name: "工作", newName: "重要" }),
    );
    expect(
      (await data<Account>(await request(`/api/accounts/${a.id}`))).tags,
    ).toEqual(["重要"]);
    await data(await request("/api/tags", "DELETE", { name: "重要" }));
    expect(await data(await request("/api/tags"))).toEqual([]);
  });
  it("stores XSS/SQL input as literal text, without accessing third-party URLs", async () => {
    const notes = "<img src=x onerror=alert(1)>\n' ); DROP TABLE accounts; --";
    const a = await create({ username: "a');DROP TABLE platforms;--", notes });
    expect(a.notes).toBe(notes);
    expect((await data<Account[]>(await request("/api/accounts"))).length).toBe(
      1,
    );
  });
});
describe("atomic backup and import", () => {
  it("round-trips 100 records and empty base records, preserving sessions and UTC timestamps", async () => {
    const before = await backup(),
      time = "2026-11-25T00:00:00.000Z";
    const b: Backup = {
      ...before,
      platforms: [
        {
          id: 5,
          name: "平台",
          default_url: "https://example.com",
          created_at: time,
          updated_at: time,
        },
        {
          id: 6,
          name: "空平台",
          default_url: null,
          created_at: time,
          updated_at: time,
        },
      ],
      accounts: Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        platform_id: 5,
        username: i % 2 ? `user${i}` : null,
        login_url: null,
        email: `user${i}@example.com`,
        phone: i % 3 ? null : "+00123",
        notes: '备注,包含"引号"\n多行',
        category_id: before.categories[0].id,
        tags: ["个人"],
        created_at: time,
        updated_at: time,
      })),
    };
    const input = { format: "json", content: JSON.stringify(b) };
    expect(
      (
        await data<{ accounts: number }>(
          await request("/api/backup/preview", "POST", input),
        )
      ).accounts,
    ).toBe(100);
    await data(
      await request("/api/backup/import", "POST", { ...input, confirm: true }),
    );
    const restored = await backup();
    expect(restored.accounts.sort((a, b) => a.id - b.id)).toEqual(b.accounts);
    expect(restored.platforms).toEqual(
      b.platforms.sort((a, b) => a.name.localeCompare(b.name, "en")),
    );
    expect(JSON.stringify(restored)).not.toMatch(
      /ADMIN_|id_hash|password|sessions/,
    );
    expect((await request("/api/auth/session")).status).toBe(200);
    await data(
      await request("/api/backup/import", "POST", {
        format: "json",
        content: JSON.stringify(restored),
        confirm: true,
      }),
    );
    expect((await backup()).accounts).toHaveLength(100);
  });
  it("rejects bad relationships, invalid JSON, over-limit files, unsupported versions and edited submissions without deleting anything", async () => {
    await create({});
    const original = await backup();
    for (const content of [
      "{",
      JSON.stringify({ ...original, schemaVersion: 99 }),
      JSON.stringify({
        ...original,
        accounts: original.accounts.map((a) => ({ ...a, platform_id: 999 })),
      }),
      JSON.stringify({
        ...original,
        accounts: original.accounts.map((a) => ({
          ...a,
          tags: ["x".repeat(51)],
        })),
      }),
    ]) {
      expect(
        (
          await request("/api/backup/import", "POST", {
            format: "json",
            content,
            confirm: true,
          })
        ).status,
      ).toBe(400);
      expect((await backup()).accounts).toEqual(original.accounts);
    }
    expect(
      (
        await request("/api/backup/preview", "POST", {
          format: "csv",
          content: "x".repeat(1048577),
        })
      ).status,
    ).toBe(413);
    const input = { format: "json", content: JSON.stringify(original) };
    await data(await request("/api/backup/preview", "POST", input));
    expect(
      (
        await request("/api/backup/import", "POST", {
          ...input,
          content: "{}",
          confirm: true,
        })
      ).status,
    ).toBe(400);
    expect((await backup()).accounts).toEqual(original.accounts);
  });
  it("parses BOM, quotes, commas, multiline CSV; skips duplicates unless opted in, reports errors and never partially writes", async () => {
    await create({ email: "duplicate@example.com" });
    const csv =
      "\uFEFF" +
      Papa.unparse({
        fields: [
          "所属平台",
          "登录帐号",
          "登录网址",
          "绑定邮箱",
          "绑定手机号",
          "帐号备注",
          "自定义分类",
          "标签",
        ],
        data: [
          ["GitHub", "", "", "duplicate@example.com", "", "", "", "[]"],
          [
            "新平台",
            "",
            "",
            "new@example.com",
            "+001234",
            '第一行, "引号"\n第二行',
            "新分类",
            '["标签"]',
          ],
        ],
      });
    const input = { format: "csv", content: csv };
    const preview = await data<{
      valid: number;
      duplicates: number;
      accounts: number;
    }>(await request("/api/backup/preview", "POST", input));
    expect(preview).toMatchObject({ valid: 2, duplicates: 1, accounts: 1 });
    await data(
      await request("/api/backup/import", "POST", { ...input, confirm: true }),
    );
    const all = await data<Account[]>(await request("/api/accounts"));
    expect(all).toHaveLength(2);
    expect(all.find((a) => a.email === "new@example.com")).toMatchObject({
      phone: "+001234",
      notes: '第一行, "引号"\n第二行',
      tags: ["标签"],
    });
    await data(
      await request("/api/backup/import", "POST", {
        ...input,
        keepDuplicates: true,
        confirm: true,
      }),
    );
    expect(await data<Account[]>(await request("/api/accounts"))).toHaveLength(
      4,
    );
    const bad = csv + "\r\n坏行,,,,,,,not-json";
    const badPreview = await data<{ errors: { row: number }[] }>(
      await request("/api/backup/preview", "POST", {
        format: "csv",
        content: bad,
      }),
    );
    expect(badPreview.errors[0].row).toBe(4);
    expect(
      (
        await request("/api/backup/import", "POST", {
          format: "csv",
          content: bad,
          confirm: true,
        })
      ).status,
    ).toBe(400);
    expect(await data<Account[]>(await request("/api/accounts"))).toHaveLength(
      4,
    );
  });
  it("safely exports formula prefixes and does not truncate exports exceeding import limits", async () => {
    await create({
      username: '=HYPERLINK("evil")',
      phone: "+86123",
      notes: "\t=cmd",
    });
    const csv = await (await request("/api/backup/csv")).text(),
      rows = Papa.parse<string[]>(csv).data;
    expect(rows[1][1]).toBe('\'=HYPERLINK("evil")');
    expect(rows[1][4]).toBe("'+86123");
    const b = await backup(),
      a = b.accounts[0];
    await bindings.DB.prepare(
      `INSERT INTO accounts(platform_id,username,tags) SELECT ?, 'bulk-' || value, '[]' FROM json_each(?)`,
    )
      .bind(
        a.platform_id,
        JSON.stringify(Array.from({ length: 501 }, (_, i) => i)),
      )
      .run();
    expect((await backup()).accounts).toHaveLength(502);
    expect(
      Papa.parse<string[]>(await (await request("/api/backup/csv")).text())
        .data,
    ).toHaveLength(503);
  });
  it("imports typical 100-record CSV and the 500-record boundary, refusing 501 without partial writes", async () => {
    const fields = [
      "所属平台",
      "登录帐号",
      "登录网址",
      "绑定邮箱",
      "绑定手机号",
      "帐号备注",
      "自定义分类",
      "标签",
    ];
    for (const count of [100, 500]) {
      const content = Papa.unparse({
        fields,
        data: Array.from({ length: count }, (_, i) => [
          `平台 ${i % 3}`,
          `batch${count}-${i}`,
          "",
          `person${i}@example.com`,
          "+00123",
          "中文,备注\n下一行",
          "分类",
          '["测试","个人"]',
        ]),
      });
      const input = { format: "csv", content };
      expect(
        await data(await request("/api/backup/preview", "POST", input)),
      ).toMatchObject({ valid: count, accounts: count, errors: [] });
      await data(
        await request("/api/backup/import", "POST", {
          ...input,
          confirm: true,
        }),
      );
    }
    const content = Papa.unparse({
      fields,
      data: Array.from({ length: 501 }, (_, i) => [
        "平台",
        `overflow-${i}`,
        "",
        "",
        "",
        "",
        "",
        "[]",
      ]),
    });
    expect(
      (
        await request("/api/backup/import", "POST", {
          format: "csv",
          content,
          confirm: true,
        })
      ).status,
    ).toBe(413);
    expect((await backup()).accounts).toHaveLength(600);
  });
  it("rolls back entire D1 batch if a later insert fails", async () => {
    await create({});
    const b = await backup();
    const trigger = await bindings.DB.prepare(
      "CREATE TRIGGER fail_import BEFORE INSERT ON accounts BEGIN SELECT RAISE(ABORT, 'test-failure'); END",
    ).run();
    expect(trigger.success).toBe(true);
    expect(
      (
        await request("/api/backup/import", "POST", {
          format: "json",
          content: JSON.stringify(b),
          confirm: true,
        })
      ).status,
    ).toBe(503);
    expect((await backup()).accounts).toEqual(b.accounts);
    expect((await backup()).platforms).toEqual(b.platforms);
  });
});
