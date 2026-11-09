const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b as ArrayBuffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);

export async function sha256Hex(s: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** dcm_ + 256bit 乱数(base64url) */
export function newKey() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return "dcm_" + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Discord Interactions の Ed25519 署名検証。生の本文で検証する。 */
export async function verifyDiscord(publicKeyHex: string, sigHex: string | null, ts: string | null, raw: string) {
  if (!sigHex || !ts || !/^[0-9a-f]+$/i.test(sigHex)) return false;
  // 古いタイムスタンプは拒否(リプレイ対策、5 分)
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  try {
    const key = await crypto.subtle.importKey("raw", unhex(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, unhex(sigHex), new TextEncoder().encode(ts + raw));
  } catch {
    return false;
  }
}
