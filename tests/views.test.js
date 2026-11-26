import { describe, expect, it } from "vitest";
import {
  emailsFor,
  filterAccounts,
  groupAccounts,
  identity,
  recentAccounts,
} from "../public/js/model.js";
const rows = [
  {
    id: 1,
    platform_id: 11,
    platform_name: "ChatGPT",
    username: " Shared@Example.com ",
    email: "shared@example.com",
    phone: null,
    category_id: 7,
    category_name: "AI",
    tags: ["工作"],
    notes: "research",
    updated_at: "2026-11-24T00:00:00Z",
  },
  {
    id: 2,
    platform_id: 12,
    platform_name: "GitHub",
    username: "shared@example.com",
    email: "other@example.com",
    phone: null,
    category_id: 8,
    category_name: "开发",
    tags: ["工作", "个人"],
    notes: null,
    updated_at: "2026-11-25T00:00:00Z",
  },
  {
    id: 3,
    platform_id: 11,
    platform_name: "ChatGPT",
    username: null,
    email: null,
    phone: "+00123",
    category_id: null,
    category_name: null,
    tags: ["个人"],
    notes: "phone only",
    updated_at: "2026-11-25T00:00:00Z",
  },
  {
    id: 4,
    platform_id: 13,
    platform_name: "Cloudflare",
    username: "invalid@",
    email: "shared+alias@example.com",
    category_id: null,
    tags: [],
    updated_at: "2026-11-23T00:00:00Z",
  },
];
describe("shared browser view contracts", () => {
  it("unions both email roles by record ID without merging aliases or treating ordinary usernames as email", () => {
    expect([...emailsFor(rows[0])]).toEqual([
      ["shared@example.com", ["登录邮箱", "绑定邮箱"]],
    ]);
    expect([...emailsFor(rows[2])]).toEqual([]);
    expect([
      ...emailsFor({ ...rows[2], username: "x".repeat(250) + "@example.com" }),
    ]).toEqual([]);
    const groups = groupAccounts(rows, "email");
    expect(
      Object.fromEntries(
        groups.map((g) => [g.name, g.accounts.map((a) => a.id)]),
      ),
    ).toEqual({
      "other@example.com": [2],
      "shared+alias@example.com": [4],
      "shared@example.com": [1, 2],
    });
    expect(
      groupAccounts(rows, "platform")
        .find((g) => g.key === "11")
        .accounts.map((a) => a.id),
    ).toEqual([1, 3]);
    expect(rows.map(identity)).toEqual([
      " Shared@Example.com ",
      "shared@example.com",
      "+00123",
      "invalid@",
    ]);
  });
  it("searches across fields and intersects category/tag without affecting original records", () => {
    expect(filterAccounts(rows, { search: "+00123" }).map((a) => a.id)).toEqual(
      [3],
    );
    expect(
      filterAccounts(rows, {
        category: "7",
        tag: "工作",
        search: "RESEARCH",
      }).map((a) => a.id),
    ).toEqual([1]);
    expect(
      filterAccounts(rows, { category: "none", tag: "个人" }).map((a) => a.id),
    ).toEqual([3]);
    expect(filterAccounts(rows, { search: "开发" }).map((a) => a.id)).toEqual([
      2,
    ]);
    expect(rows).toHaveLength(4);
    expect(recentAccounts(rows).map((a) => a.id)).toEqual([3, 2, 1, 4]);
  });
  it("specific email search shows only that group, not the unrelated email on the same account", () => {
    const filtered = filterAccounts(rows, { search: "shared@example.com" });
    expect(
      groupAccounts(filtered, "email", "shared@example.com").map((g) => [
        g.name,
        g.accounts.map((a) => a.id),
      ]),
    ).toEqual([["shared@example.com", [1, 2]]]);
    expect(
      groupAccounts(
        filterAccounts(rows, { search: "shared@" }),
        "email",
        "shared@",
      ).map((g) => g.name),
    ).toEqual(["shared@example.com"]);
  });
});
