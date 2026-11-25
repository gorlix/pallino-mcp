export const DEFAULT_BASE_URL = "https://cloud.pallino.me";

export class PallinoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "PallinoError";
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
}

/** Thin wrapper over the Pallino Cloud agent API (`/v1/agent/*`), authenticated with one API key. */
export class PallinoClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/");
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "pallino-mcp" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const init: RequestInit = {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    };

    let res = await this.send(url, init);
    if (res.status === 429) {
      // One retry, only when the server asks for a short wait.
      const wait = Number(res.headers.get("retry-after"));
      if (Number.isFinite(wait) && wait >= 0 && wait <= 10) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        res = await this.send(url, init);
      }
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string; field?: string } } | undefined)?.error;
      let message = err?.message ?? (text.slice(0, 200) || res.statusText);
      if (res.status === 429) message += ` (retry after ${res.headers.get("retry-after") ?? "?"}s)`;
      throw new PallinoError(res.status, err?.code ?? `http_${res.status}`, message, err?.field);
    }
    return data as T;
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new PallinoError(0, "network_error", `Cannot reach ${url.origin}: ${reason}`);
    }
  }
}
