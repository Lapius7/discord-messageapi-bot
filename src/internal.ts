import type { Env } from "./types";

/** サーバー側 API への呼び出し。共有シークレット付き。 */
export function internal(env: Env) {
  const call = (path: string, init: RequestInit & { actor?: string } = {}) => {
    const h = new Headers(init.headers);
    h.set("x-internal-secret", env.INTERNAL_SECRET);
    if (init.actor) h.set("x-actor", init.actor);
    return fetch(env.INTERNAL_URL + path, { ...init, headers: h });
  };
  const json = (method: string, path: string, body?: unknown, actor?: string) =>
    call(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" }, actor });
  return { call, json };
}
