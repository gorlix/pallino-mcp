import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PallinoClient } from "../src/client.js";
import { Sealer, verifyBearer } from "../src/oauth.js";
import { createHttpApp } from "../src/http.js";
import { registerTools } from "../src/tools.js";
import type { Config } from "../src/config.js";

const SECRET = "s".repeat(40);
const KEY = "pallino_" + "a".repeat(30);
const BAD_KEY = "pallino_" + "b".repeat(30);

describe("Sealer", () => {
  const s = new Sealer(SECRET);
  it("round-trips", () => {
    expect(s.open("code", s.seal("code", { a: 1 }, 60))).toMatchObject({ a: 1 });
  });
  it("rejects wrong kind, tampering and expiry", () => {
    const t = s.seal("code", { a: 1 }, 60);
    expect(s.open("access", t)).toBeUndefined();
    expect(s.open("code", t.slice(0, -2) + (t.endsWith("AA") ? "BB" : "AA"))).toBeUndefined();
    expect(s.open("code", s.seal("code", { a: 1 }, -5))).toBeUndefined();
    expect(new Sealer("t".repeat(40)).open("code", t)).toBeUndefined();
  });
  it("requires a long secret", () => {
    expect(() => new Sealer("short")).toThrow(/32/);
  });
});

describe("verifyBearer", () => {
  const s = new Sealer(SECRET);
  it("accepts raw keys and access tokens, rejects the rest", () => {
    expect(verifyBearer(KEY).extra).toEqual({ apiKey: KEY });
    expect(verifyBearer(s.seal("access", { k: KEY, c: "c" }, 60), s).extra).toEqual({ apiKey: KEY });
    expect(() => verifyBearer(s.seal("refresh", { k: KEY, c: "c" }, 60), s)).toThrow();
    expect(() => verifyBearer("junk", s)).toThrow();
    expect(() => verifyBearer(s.seal("access", { k: KEY, c: "c" }, 60))).toThrow();
  });
});

describe("OAuth flow over HTTP", () => {
  let stub: Server, mcp: Server, base: string;
  const seen: string[] = [];

  beforeAll(async () => {
    stub = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const okKey = req.headers.authorization === `Bearer ${KEY}`;
      res.writeHead(okKey ? 200 : 401, { "content-type": "application/json" }).end(okKey ? "[]" : '{"error":{"code":"unauthorized","message":"no"}}');
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const pallinoUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    // Reserve a port first so PUBLIC_URL matches the real listener.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    base = `http://127.0.0.1:${port}`;
    const cfg: Config = { transport: "http", baseUrl: pallinoUrl, host: "127.0.0.1", port, publicUrl: base, oauthSecret: SECRET, allowEnvKey: false };
    const app = createHttpApp(cfg, () => {
      const s = new McpServer({ name: "t", version: "0" });
      registerTools(s, (extra) => new PallinoClient(extra?.apiKey as string, pallinoUrl));
      return s;
    });
    mcp = await new Promise<Server>((r) => {
      const srv = app.listen(port, "127.0.0.1", () => r(srv));
    });
  });
  afterAll(() => {
    stub.close();
    mcp.close();
  });

  const redirect = "http://localhost:9999/cb";
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  it("401 without auth points at resource metadata", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("runs register, authorize, approve, token, mcp", async () => {
    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "Test" }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };

    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st" });
    const page = await fetch(`${base}/authorize?${q}`);
    expect(page.status).toBe(200);
    const pending = /name="pending" value="([^"]+)"/.exec(await page.text())![1];

    const approve = (api_key: string) =>
      fetch(`${base}/oauth/approve`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ pending, api_key }) });
    expect((await approve(BAD_KEY)).status).toBe(400);
    const ap = await approve(KEY);
    expect(ap.status).toBe(302);
    const loc = new URL(ap.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(redirect);
    expect(loc.searchParams.get("state")).toBe("st");
    const code = loc.searchParams.get("code")!;

    const token = (c: string) =>
      fetch(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: c, client_id, redirect_uri: redirect, code_verifier: verifier }),
      });
    const t = await token(code);
    expect(t.status).toBe(200);
    const tokens = (await t.json()) as { access_token: string; refresh_token: string };
    expect((await token(code)).status).toBe(400);

    const rpc = (bearer: string) =>
      fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const list = await rpc(tokens.access_token);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(16);
    expect((await rpc(KEY)).status).toBe(200);
    expect((await rpc(tokens.refresh_token)).status).toBe(401);
  });
});
