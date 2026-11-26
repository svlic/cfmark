import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
const blank = {
  schemaVersion: 1,
  exportedAt: "2026-11-25T00:00:00.000Z",
  platforms: [],
  categories: [],
  accounts: [],
};
async function login(page: Page) {
  const response = await page.goto("/login");
  expect(response?.headers()["cache-control"]).toBe("no-store");
  expect(response?.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  await page.getByLabel("用户名").fill("browser-test");
  await page
    .getByLabel("密码", { exact: true })
    .fill("synthetic-browser-test-only-2026");
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page.locator("#stat-accounts")).not.toHaveText("—");
  const r = await page.request.post("/api/backup/import", {
    headers: { Origin: "http://localhost:8788" },
    data: { format: "json", content: JSON.stringify(blank), confirm: true },
  });
  expect(r.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator("#stat-accounts")).toHaveText("0");
}
async function add(
  page: Page,
  platform: string,
  username: string,
  email: string,
  phone = "",
) {
  await page.getByRole("button", { name: "新增帐号", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增帐号" });
  await dialog.getByLabel("所属平台 *").fill(platform);
  await dialog.getByLabel("登录帐号", { exact: true }).fill(username);
  await dialog.getByLabel("绑定邮箱", { exact: true }).fill(email);
  await dialog.getByLabel("绑定手机号", { exact: true }).fill(phone);
  await dialog.getByRole("button", { name: "创建帐号", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
test("three shared views, CRUD, duplicate confirmation, literal XSS and private-storage boundary", async ({
  page,
}) => {
  await login(page);
  await add(page, "ChatGPT", "", "Alice@Example.com");
  await add(page, "GitHub", "alice@example.com", "other@example.com");
  await add(page, "Cloudflare", "", "alice@example.com");
  await add(page, "Phone only", "", "", "+001234");
  await expect(page.locator("#stat-accounts")).toHaveText("4");
  await expect(page.locator("#stat-emails")).toHaveText("2");
  await page.getByRole("button", { name: "按邮箱", exact: true }).click();
  await expect(page.locator(".group-card")).toHaveCount(2);
  await page.locator("#search").fill("alice@example.com");
  await expect(page.locator(".group-card")).toHaveCount(1);
  await expect(page.locator(".group-card")).toContainText(
    "3 个平台 · 3 个帐号",
  );
  await expect(page.locator("#stat-accounts")).toHaveText("4");
  await page.locator(".group-card").click();
  await expect(page.locator(".account-card")).toHaveCount(3);
  await expect(page.locator(".association")).toContainText([
    "绑定邮箱",
    "登录邮箱",
    "绑定邮箱",
  ]);
  await page.locator("#clear-filters").click();
  await page.getByRole("button", { name: "全部帐号", exact: true }).click();
  await page.locator("#search").fill("+001234");
  await expect(page.locator(".account-card")).toHaveCount(1);
  await page.locator(".card-open").click();
  await page.getByRole("button", { name: "编辑帐号", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑帐号" });
  await editor
    .getByLabel("帐号备注", { exact: true })
    .fill("<img src=x onerror=alert(1)>");
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.locator(".notes-excerpt")).toHaveText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(page.locator(".account-card img")).toHaveCount(0);
  await page.locator(".card-open").click();
  await page.getByRole("button", { name: "复制为新帐号", exact: true }).click();
  await page.getByRole("button", { name: "创建帐号", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "可能是重复帐号" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "仍然保存", exact: true }).click();
  await expect(page.locator("#stat-accounts")).toHaveText("5");
  await page.locator(".card-open").first().click();
  await page.getByRole("button", { name: "删除帐号", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.locator("#stat-accounts")).toHaveText("4");
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });
});
test("settings CRUD, JSON restore and CSV preview confirmation work through browser", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "＋ 新增平台", exact: true }).click();
  const create = page.getByRole("dialog", { name: "新增平台" });
  await create.getByLabel("平台名称 *").fill("空平台");
  await create.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".management-row")).toHaveCount(1);
  await page
    .locator(".management-row")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.locator(".management-row")).toHaveCount(0);
  await page.getByRole("button", { name: "数据备份", exact: true }).click();
  const csv =
    '所属平台,登录帐号,登录网址,绑定邮箱,绑定手机号,帐号备注,自定义分类,标签\r\n测试平台,,,test@example.com,,"第一行,备注\n第二行",开发工具,"[""测试""]"';
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "accounts.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  await page.getByRole("button", { name: "校验并预览", exact: true }).click();
  await expect(page.getByRole("heading", { name: "导入预览" })).toBeVisible();
  await page.getByRole("button", { name: "确认追加导入", exact: true }).click();
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect(page.locator("#stat-accounts")).toHaveText("1");
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "导出 JSON 完整备份", exact: true })
    .click();
  const downloaded = await downloadPromise;
  const file = await downloaded.path();
  const backup = JSON.parse(await fs.readFile(file!, "utf8"));
  expect(backup.accounts).toHaveLength(1);
  expect(backup.accounts[0].notes).toBe("第一行,备注\n第二行");
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "restore.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(blank)),
    });
  await page.getByRole("button", { name: "校验并预览", exact: true }).click();
  await page
    .getByRole("button", { name: "确认恢复并替换", exact: true })
    .click();
  await page.getByRole("button", { name: "替换并恢复", exact: true }).click();
  await expect(page.locator("#stat-accounts")).toHaveText("0");
});
test("desktop, tablet, mobile, dark mode and edit dialog render without overflow", async ({
  page,
}) => {
  await login(page);
  await fs.mkdir(".amp/in/artifacts", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".amp/in/artifacts/desktop-empty.png",
    fullPage: true,
  });
  for (const [platform, email] of [
    ["ChatGPT", "personal@example.com"],
    ["GitHub", "work@example.com"],
    ["Cloudflare", "personal@example.com"],
    ["Notion", "notes@example.com"],
  ])
    await add(page, platform, "", email);
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 6500 });
  await page.screenshot({
    path: ".amp/in/artifacts/desktop.png",
    fullPage: true,
  });
  for (const width of [768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `.amp/in/artifacts/${width === 375 ? "mobile" : "tablet"}.png`,
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "新增帐号", exact: true }).click();
  await page.getByLabel("所属平台 *").fill("Mobile form");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: ".amp/in/artifacts/mobile-form.png" });
  await page.getByLabel("绑定邮箱", { exact: true }).fill("mobile@example.com");
  await page
    .getByRole("button", { name: "创建帐号", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "创建帐号", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: ".amp/in/artifacts/mobile-form-bottom.png" });
  await page.getByRole("button", { name: "创建帐号", exact: true }).click();
  await expect(page.locator("#stat-accounts")).toHaveText("5");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#theme").selectOption("dark");
  await expect(page.locator(".group-card").first()).toHaveCSS(
    "background-color",
    "rgb(27, 30, 45)",
  );
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 6500 });
  await page.screenshot({
    path: ".amp/in/artifacts/desktop-dark.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).toBe("rgb(16, 18, 28)");
});
test("network errors preserve input, session expiry clears view and redirects", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "新增帐号", exact: true }).click();
  await page.getByLabel("所属平台 *").fill("Keep input");
  await page.getByLabel("绑定邮箱", { exact: true }).fill("keep@example.com");
  await page.route("**/api/accounts", (route) => route.abort());
  await page.getByRole("button", { name: "创建帐号", exact: true }).click();
  await expect(page.locator(".form-error")).toContainText("网络连接中断");
  await expect(page.getByLabel("绑定邮箱", { exact: true })).toHaveValue(
    "keep@example.com",
  );
  await page.unroute("**/api/accounts");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.context().clearCookies();
  await page.reload();
  await expect(page).toHaveURL(/login/);
  await expect(page.locator(".account-card")).toHaveCount(0);
});
