import { expect, test } from "bun:test";
import { canRead } from "../src/perms";

const G = "100", U = "5", R = "200";
const VIEW = 1n << 10n, HIST = 1n << 16n, ADMIN = 1n << 3n;
const base = { guildId: G, ownerId: "1", userId: U, memberRoles: [R] as string[], overwrites: [] as any[] };
const roles = (everyone: bigint, role: bigint) => [
  { id: G, permissions: String(everyone) }, { id: R, permissions: String(role) },
];

test("見る+履歴があれば読める", () => expect(canRead({ ...base, roles: roles(VIEW | HIST, 0n) })).toBe(true));
test("履歴だけ無いと読めない", () => expect(canRead({ ...base, roles: roles(VIEW, 0n) })).toBe(false));
test("管理者は読める", () => expect(canRead({ ...base, roles: roles(0n, ADMIN) })).toBe(true));
test("オーナーは読める", () => expect(canRead({ ...base, ownerId: U, roles: roles(0n, 0n) })).toBe(true));
test("@everyone の上書き拒否で読めない", () =>
  expect(canRead({ ...base, roles: roles(VIEW | HIST, 0n), overwrites: [{ id: G, type: 0, allow: "0", deny: String(VIEW) }] })).toBe(false));
test("ロールの上書き許可で読める", () =>
  expect(canRead({ ...base, roles: roles(0n, 0n), overwrites: [{ id: R, type: 0, allow: String(VIEW | HIST), deny: "0" }] })).toBe(true));
test("本人の上書き拒否が最優先", () =>
  expect(canRead({ ...base, roles: roles(VIEW | HIST, 0n), overwrites: [{ id: R, type: 0, allow: String(VIEW | HIST), deny: "0" }, { id: U, type: 1, allow: "0", deny: String(HIST) }] })).toBe(false));
