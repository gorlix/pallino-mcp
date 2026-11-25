import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHash } from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { PallinoClient } from "./client.js";

/**
 * Stateless OAuth 2.1 facade: the user pastes a Pallino API key on our authorize page; every artifact
 * (client_id, pending request, code, access and refresh token) is an AES-256-GCM sealed blob.
 * No database. Rotating OAUTH_SECRET invalidates every client and token.
 */

export const API_KEY_RE = /^pallino_[A-Za-z0-9_-]{20,100}$/;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 90 * 24 * 3600;
const CODE_TTL = 120;
const PENDING_TTL = 15 * 60;

type Kind = "client" | "pending" | "code" | "access" | "refresh";

export class Sealer {
  private readonly key: Buffer;
  constructor(secret: string) {
    if (secret.length < 32) throw new Error("OAUTH_SECRET must be at least 32 characters");
    this.key = Buffer.from(hkdfSync("sha256", secret, "pallino-mcp", "oauth-seal-v1", 32));
  }
  seal(kind: Kind, payload: object, ttl: number): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(kind));
    const pt = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttl }));
    const ct = Buffer.concat([c.update(pt), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
  }
  /** Returns the payload, or undefined when forged, of another kind, or expired. */
  open<T>(kind: Kind, token: string): (T & { exp: number }) | undefined {
    try {
      const raw = Buffer.from(token, "base64url");
      if (raw.length < 29) return undefined;
      const d = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(kind));
      d.setAuthTag(raw.subarray(12, 28));
      const p = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString()) as T & { exp: number };
      return p.exp >= Math.floor(Date.now() / 1000) ? p : undefined;
    } catch {
      return undefined;
    }
  }
}

type ClientBlob = Omit<OAuthClientInformationFull, "client_id">;
interface Pending {
  c: string; // client_id
  r: string; // redirect_uri
  ch: string; // PKCE challenge
  s?: string; // state
  res?: string; // resource
  sc?: string[];
}
interface Grant {
  k: string; // Pallino API key
  c: string; // client_id hash
  r?: string;
  ch?: string;
  res?: string;
  sc?: string[];
}

const clientHash = (clientId: string) => createHash("sha256").update(clientId).digest("base64url").slice(0, 22);

export interface FacadeOptions {
  secret: string;
  pallinoBaseUrl: string;
  /** Where the authorize page form posts. */
  approvePath: string;
  fetchImpl?: typeof fetch;
}

export class PallinoOAuthProvider implements OAuthServerProvider {
  readonly sealer: Sealer;
  private readonly usedCodes = new Map<string, number>();

  constructor(private readonly opts: FacadeOptions) {
    this.sealer = new Sealer(opts.secret);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => {
        const blob = this.sealer.open<ClientBlob>("client", clientId);
        return blob ? { ...blob, client_id: clientId } : undefined;
      },
      registerClient: (client) => {
        if (client.redirect_uris.length > 10) throw new InvalidClientMetadataError("Too many redirect_uris");
        const blob: ClientBlob = {
          redirect_uris: client.redirect_uris,
          token_endpoint_auth_method: client.token_endpoint_auth_method,
          grant_types: client.grant_types,
          response_types: client.response_types,
          client_name: client.client_name?.slice(0, 100),
          client_secret: client.client_secret,
          client_secret_expires_at: client.client_secret_expires_at,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        return { ...blob, client_id: this.sealer.seal("client", blob, 10 * 365 * 24 * 3600) };
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const pending = this.sealer.seal(
      "pending",
      {
        c: client.client_id,
        r: params.redirectUri,
        ch: params.codeChallenge,
        s: params.state,
        res: params.resource?.href,
        sc: params.scopes,
      } satisfies Pending,
      PENDING_TTL,
    );
    res.status(200).type("html").send(authorizePage({ pending, approvePath: this.opts.approvePath, clientName: client.client_name, redirectUri: params.redirectUri }));
  }

  /** Handles the authorize page form: validates the key against Pallino, then redirects with a code. */
  async approve(pendingToken: string, apiKey: string, res: Response): Promise<void> {
    const p = this.sealer.open<Pending>("pending", pendingToken);
    if (!p) {
      res.status(400).type("html").send(errorPage("This authorization request expired. Start again from your AI client."));
      return;
    }
    const key = apiKey.trim();
    const retry = (msg: string) =>
      res.status(400).type("html").send(authorizePage({ pending: pendingToken, approvePath: this.opts.approvePath, redirectUri: p.r, error: msg }));
    if (!API_KEY_RE.test(key)) return void retry("That is not a Pallino API key (it starts with pallino_).");
    try {
      await new PallinoClient(key, this.opts.pallinoBaseUrl, this.opts.fetchImpl).request("GET", "v1/agent/spaces");
    } catch {
      return void retry("Pallino did not accept this key: check it is correct, not expired and not revoked.");
    }
    const code = this.sealer.seal("code", { k: key, c: clientHash(p.c), r: p.r, ch: p.ch, res: p.res, sc: p.sc } satisfies Grant, CODE_TTL);
    const target = new URL(p.r);
    target.searchParams.set("code", code);
    if (p.s !== undefined) target.searchParams.set("state", p.s);
    res.redirect(302, target.href);
  }

  private openGrant(kind: "code" | "refresh", client: OAuthClientInformationFull, token: string): Grant {
    const g = this.sealer.open<Grant>(kind, token);
    if (!g || g.c !== clientHash(client.client_id)) throw new InvalidGrantError(`Invalid or expired ${kind === "code" ? "authorization code" : "refresh token"}`);
    return g;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.openGrant("code", client, code).ch!;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const g = this.openGrant("code", client, code);
    if (redirectUri !== undefined && redirectUri !== g.r) throw new InvalidGrantError("redirect_uri does not match");
    // shortcut: single-use is enforced per process only; codes also expire in 2 minutes and need PKCE.
    const now = Date.now() / 1000;
    for (const [c, exp] of this.usedCodes) if (exp < now) this.usedCodes.delete(c);
    if (this.usedCodes.has(code)) throw new InvalidGrantError("Authorization code already used");
    this.usedCodes.set(code, now + CODE_TTL);
    return this.issue(g);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    return this.issue(this.openGrant("refresh", client, refreshToken));
  }

  private issue(g: Grant): OAuthTokens {
    const grant: Grant = { k: g.k, c: g.c, res: g.res, sc: g.sc };
    return {
      access_token: this.sealer.seal("access", grant, ACCESS_TTL),
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: this.sealer.seal("refresh", grant, REFRESH_TTL),
      scope: g.sc?.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return verifyBearer(token, this.sealer);
  }
}

/** Accepts a raw Pallino API key (passthrough) or, when a sealer is given, an access token from the facade. */
export function verifyBearer(token: string, sealer?: Sealer): AuthInfo {
  if (API_KEY_RE.test(token)) {
    // Pallino validates the key itself on every call; expiry here only satisfies the bearer middleware.
    return { token, clientId: "api-key", scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600, extra: { apiKey: token } };
  }
  const g = sealer?.open<Grant & { exp: number }>("access", token);
  if (!g) throw new InvalidTokenError("Invalid or expired token");
  return { token, clientId: g.c, scopes: g.sc ?? [], expiresAt: g.exp, resource: g.res ? new URL(g.res) : undefined, extra: { apiKey: g.k } };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function shell(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Pallino</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:28rem;margin:10vh auto;padding:0 1rem;line-height:1.5}
input{width:100%;box-sizing:border-box;padding:.6rem;font:inherit;font-family:ui-monospace,monospace;margin:.5rem 0 1rem}
button{padding:.6rem 1.2rem;font:inherit;cursor:pointer}.err{color:#c0392b}.muted{opacity:.7;font-size:.9em}code{word-break:break-all}
</style></head><body>${body}</body></html>`;
}

function authorizePage(o: { pending: string; approvePath: string; redirectUri: string; clientName?: string; error?: string }): string {
  return shell(`<h1>Connect Pallino</h1>
<p>${o.clientName ? `<strong>${esc(o.clientName)}</strong>` : "An application"} wants to access your Pallino account.</p>
<p class="muted">It will be able to do only what the key allows. After you approve, you go back to <code>${esc(new URL(o.redirectUri).origin)}</code>.</p>
${o.error ? `<p class="err" role="alert">${esc(o.error)}</p>` : ""}
<form method="post" action="${esc(o.approvePath)}">
<input type="hidden" name="pending" value="${esc(o.pending)}">
<label for="key">Pallino API key</label>
<input id="key" name="api_key" type="password" autocomplete="off" required placeholder="pallino_…" pattern="pallino_.+">
<button type="submit">Connect</button>
</form>
<p class="muted">Create a dedicated API key in Pallino, granting only the spaces and actions you want this application to use.</p>`);
}

function errorPage(msg: string): string {
  return shell(`<h1>Connect Pallino</h1><p class="err" role="alert">${esc(msg)}</p>`);
}
