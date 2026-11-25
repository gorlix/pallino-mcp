import { describe, expect, it, vi } from "vitest";
import { PallinoClient, PallinoError } from "../src/client.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function setup(...responses: (Response | Error)[]) {
  const fetchMock = vi.fn(async (_url: URL | string | Request, _init?: RequestInit) => {
    const r = responses.shift() ?? json(200, {});
    if (r instanceof Error) throw r;
    return r;
  });
  const client = new PallinoClient("pallino_testkey_testkey_testkey", "https://example.test/base", fetchMock as unknown as typeof fetch);
  return { fetchMock, client };
}

describe("PallinoClient", () => {
  it("builds URL, drops undefined/null query values and sends auth", async () => {
    const { fetchMock, client } = setup(json(200, { ok: 1 }));
    const r = await client.request("GET", "v1/agent/x", { query: { a: 1, b: undefined, c: null, d: false, e: "q r" } });
    expect(r).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://example.test/base/v1/agent/x?a=1&d=false&e=q+r");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer pallino_testkey_testkey_testkey");
    expect(init!.body).toBeUndefined();
  });

  it("sends a JSON body", async () => {
    const { fetchMock, client } = setup(json(200, {}));
    await client.request("POST", "v1/agent/x", { body: { a: 1 } });
    const init = fetchMock.mock.calls[0][1]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("returns undefined on 204", async () => {
    const { client } = setup(new Response(null, { status: 204 }));
    expect(await client.request("DELETE", "v1/agent/x")).toBeUndefined();
  });

  it("maps the error envelope to PallinoError", async () => {
    const { client } = setup(json(422, { error: { code: "validation_error", message: "bad", field: "title" } }));
    const e = await client.request("POST", "v1/agent/x").catch((x) => x);
    expect(e).toBeInstanceOf(PallinoError);
    expect(e).toMatchObject({ status: 422, code: "validation_error", message: "bad", field: "title" });
  });

  it("retries once on 429 with Retry-After 0", async () => {
    const { fetchMock, client } = setup(json(429, { error: { code: "rate_limited", message: "slow" } }, { "retry-after": "0" }), json(200, { ok: true }));
    expect(await client.request("GET", "v1/agent/x")).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry twice", async () => {
    const r429 = () => json(429, { error: { code: "rate_limited", message: "slow" } }, { "retry-after": "0" });
    const { fetchMock, client } = setup(r429(), r429());
    await expect(client.request("GET", "v1/agent/x")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("wraps network errors", async () => {
    const { client } = setup(new Error("boom"));
    await expect(client.request("GET", "v1/agent/x")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });
});
