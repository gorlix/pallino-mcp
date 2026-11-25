import { DEFAULT_BASE_URL } from "./client.js";

export interface Config {
  transport: "stdio" | "http";
  baseUrl: string;
  apiKey?: string;
  timeZone?: string;
  host: string;
  port: number;
  publicUrl?: string;
  oauthSecret?: string;
  allowEnvKey: boolean;
  trustProxy?: string | number | boolean;
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Config {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) return argv[i + 1];
    return argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  };
  const transport = (flag("transport") ?? env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transport !== "stdio" && transport !== "http") throw new Error(`Unknown transport "${transport}" (use stdio or http)`);
  const port = Number(flag("port") ?? env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port "${port}"`);
  const timeZone = env.PALLINO_TIMEZONE || env.TZ || undefined;
  if (timeZone) new Intl.DateTimeFormat("en", { timeZone }); // throws RangeError on an unknown zone
  const trust = env.TRUST_PROXY;
  return {
    transport,
    baseUrl: env.PALLINO_BASE_URL || DEFAULT_BASE_URL,
    apiKey: env.PALLINO_API_KEY || undefined,
    timeZone,
    host: flag("host") ?? env.HOST ?? "127.0.0.1",
    port,
    publicUrl: env.PUBLIC_URL || undefined,
    oauthSecret: env.OAUTH_SECRET || undefined,
    allowEnvKey: env.ALLOW_ENV_KEY === "true",
    trustProxy: trust === undefined || trust === "" ? undefined : trust === "true" ? true : /^\d+$/.test(trust) ? Number(trust) : trust,
  };
}
