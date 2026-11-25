import express, { type Request, type Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PallinoOAuthProvider, verifyBearer } from "./oauth.js";
import type { Config } from "./config.js";

const APPROVE_PATH = "/oauth/approve";

export function createHttpApp(cfg: Config, buildServer: () => McpServer): express.Express {
  const publicUrl = new URL(cfg.publicUrl ?? `http://${cfg.host === "0.0.0.0" ? "localhost" : cfg.host}:${cfg.port}`);
  const mcpUrl = new URL("/mcp", publicUrl);
  // Host-header check guards against DNS rebinding; behind a public URL allow it plus loopback (container healthcheck).
  const app = createMcpExpressApp({ host: cfg.host, allowedHosts: cfg.publicUrl ? [publicUrl.hostname, "localhost", "127.0.0.1", "[::1]"] : undefined });
  app.disable("x-powered-by");
  if (cfg.trustProxy) app.set("trust proxy", cfg.trustProxy);
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http:; frame-ancestors 'none'");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  app.get("/healthz", (_req, res) => void res.json({ ok: true }));

  let verifier: OAuthTokenVerifier = { verifyAccessToken: async (t) => verifyBearer(t) };
  if (cfg.oauthSecret) {
    const provider = new PallinoOAuthProvider({ secret: cfg.oauthSecret, pallinoBaseUrl: cfg.baseUrl, approvePath: APPROVE_PATH });
    verifier = provider;
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: publicUrl,
        resourceServerUrl: mcpUrl,
        resourceName: "Pallino",
        serviceDocumentationUrl: new URL("https://github.com/gorlix/pallino-mcp"),
        clientRegistrationOptions: { clientIdGeneration: false },
      }),
    );
    app.post(APPROVE_PATH, express.urlencoded({ extended: false, limit: "16kb" }), async (req: Request, res: Response) => {
      const { pending, api_key } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof pending !== "string" || typeof api_key !== "string") return void res.status(400).send("Bad request");
      await provider.approve(pending, api_key, res);
    });
  }

  const bearer = requireBearerAuth({
    verifier,
    resourceMetadataUrl: cfg.oauthSecret ? getOAuthProtectedResourceMetadataUrl(mcpUrl) : undefined,
  });
  const auth = cfg.allowEnvKey && cfg.apiKey
    ? (req: Request, res: Response, next: () => void) => (req.headers.authorization ? bearer(req, res, next) : next())
    : bearer;

  // Stateless Streamable HTTP: a fresh server and transport per request, so any instance can serve any call.
  const handle = async (req: Request, res: Response) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("MCP request failed:", e instanceof Error ? e.message : e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  };
  app.post("/mcp", auth, handle);
  const notAllowed = (_req: Request, res: Response) =>
    void res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  return app;
}
