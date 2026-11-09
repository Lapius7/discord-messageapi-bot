import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, sep } from "node:path";
import { config } from "./config";

const ROOT = resolve(config.storageDir);
const ID = /^\d{1,20}$/;
export const isId = (s: string) => ID.test(s);

/** マジックバイトから種類を判定。許可: png / jpg / gif / webp */
export function sniff(b: Uint8Array): { ext: string; mime: string } | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return { ext: "png", mime: "image/png" };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { ext: "jpg", mime: "image/jpeg" };
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return { ext: "gif", mime: "image/gif" };
  if (
    b.length >= 12 &&
    String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.slice(8, 12)) === "WEBP"
  )
    return { ext: "webp", mime: "image/webp" };
  return null;
}

export const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** ID だけでパスを組む。ここ以外でパスを作らない。 */
export function pathFor(channelId: string, messageId: string, attId: string, ext: string) {
  if (![channelId, messageId, attId].every(isId) || !MIME[ext]) throw new Error("bad id");
  const p = resolve(join(ROOT, channelId, messageId, `${attId}.${ext}`));
  if (!p.startsWith(ROOT + sep)) throw new Error("bad path");
  return p;
}

/** ストリームを上限つきで読み、検証して保存する。 */
export async function saveStream(
  body: ReadableStream<Uint8Array>,
  channelId: string,
  messageId: string,
  attId: string,
) {
  const dir = join(ROOT, channelId, messageId);
  await mkdir(dir, { recursive: true, mode: 0o750 });
  const tmp = join(dir, `.${attId}.${crypto.randomUUID()}.tmp`);
  const hash = createHash("sha256");
  const w = Bun.file(tmp).writer();
  let size = 0;
  let head = new Uint8Array(0);
  try {
    for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > config.maxImageBytes) throw new Error("too_large");
      if (head.length < 16) {
        // 最初のチャンクが小さくても判定できるよう 16 バイトまで貯める
        const m = new Uint8Array(Math.min(16, head.length + chunk.length));
        m.set(head);
        m.set(chunk.slice(0, m.length - head.length), head.length);
        head = m;
        if (head.length >= 12 && !sniff(head)) throw new Error("bad_type");
      }
      hash.update(chunk);
      w.write(chunk);
    }
    await w.end();
    const kind = sniff(head);
    if (!kind) throw new Error("bad_type");
    const dest = pathFor(channelId, messageId, attId, kind.ext);
    await rename(tmp, dest);
    return { ext: kind.ext, size, sha256: hash.digest("hex") };
  } catch (e) {
    try { await w.end(); } catch {}
    await rm(tmp, { force: true });
    throw e;
  }
}

export const removeChannelFiles = (channelId: string) =>
  isId(channelId) ? rm(join(ROOT, channelId), { recursive: true, force: true }) : Promise.resolve();

export const removeMessageFiles = (channelId: string, messageId: string) =>
  isId(channelId) && isId(messageId)
    ? rm(join(ROOT, channelId, messageId), { recursive: true, force: true })
    : Promise.resolve();

export const exists = (p: string) => stat(p).then(() => true, () => false);
