import { expect, test } from "bun:test";
import { newKey, sha256Hex, verifyDiscord } from "../src/crypto";

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sign(body: string, ts: string) {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = hex(await crypto.subtle.exportKey("raw", kp.publicKey));
  const sig = hex(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(ts + body)));
  return { pub, sig };
}

test("正しい署名は通る", async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const { pub, sig } = await sign('{"type":1}', ts);
  expect(await verifyDiscord(pub, sig, ts, '{"type":1}')).toBe(true);
});
test("本文が改ざんされたら拒否", async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const { pub, sig } = await sign('{"type":1}', ts);
  expect(await verifyDiscord(pub, sig, ts, '{"type":2}')).toBe(false);
});
test("古いタイムスタンプは拒否", async () => {
  const ts = String(Math.floor(Date.now() / 1000) - 3600);
  const { pub, sig } = await sign("x", ts);
  expect(await verifyDiscord(pub, sig, ts, "x")).toBe(false);
});
test("署名なし・不正は拒否", async () => {
  expect(await verifyDiscord("00", null, "1", "x")).toBe(false);
  expect(await verifyDiscord("zz", "zz", String(Date.now() / 1000), "x")).toBe(false);
});
test("キーは dcm_ + 43 文字で毎回異なる", async () => {
  const a = newKey(), b = newKey();
  expect(a).toMatch(/^dcm_[A-Za-z0-9_-]{43}$/);
  expect(a).not.toBe(b);
  expect(await sha256Hex("a")).toHaveLength(64);
});
