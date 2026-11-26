# pallino-mcp

MCP server for [Pallino Cloud](https://cloud.pallino.me): lets an AI client read and manage your spaces, projects, notes and tasks through the Pallino agent API (`/v1/agent/*`).

- Transports: stdio (local) and stateless Streamable HTTP (remote, `/mcp`).
- Auth: your Pallino API key, passed as env var (stdio), as a Bearer token, or through a built-in OAuth 2.1 facade (for claude.ai connectors).
- What the agent can do is limited by the grants of the key you give it.

## Tools

| Tool | What it does |
| --- | --- |
| `pallino_list_spaces` | Spaces the key reaches, members and granted actions |
| `pallino_list_projects` | Projects of a space |
| `pallino_create_project` | Create a project |
| `pallino_rename_project` | Rename a project |
| `pallino_delete_project` | Delete a project (notes and tasks stay) |
| `pallino_list_notes` | List/search notes (no body) |
| `pallino_get_note` | One note with body |
| `pallino_create_note` | Create a note, list, template or bookmark |
| `pallino_update_note` | Update fields; omitted fields unchanged |
| `pallino_delete_note` | Delete a note |
| `pallino_list_tasks` | List/search tasks, filter by done, due range, project |
| `pallino_get_task` | One task |
| `pallino_create_task` | Create a task |
| `pallino_update_task` | Update fields; `null` clears |
| `pallino_complete_task` | Mark done (or reopen with `done: false`) |
| `pallino_delete_task` | Delete a task |

It also exposes the resource `pallino://capabilities` (server limits and supported actions).

## Quick start (local, stdio)

1. Create a Pallino API key with the minimum grants you need (in the app, or `POST /v1/keys`). Give it only the spaces and actions the agent should have.
2. Add the server to your client.

Claude Code:

```sh
claude mcp add pallino -e PALLINO_API_KEY=pallino_xxx -- npx -y @pallino.me/mcp
```

Claude Desktop (`claude_desktop_config.json`), Cursor and most other clients:

```json
{
  "mcpServers": {
    "pallino": {
      "command": "npx",
      "args": ["-y", "@pallino.me/mcp"],
      "env": { "PALLINO_API_KEY": "pallino_xxx", "PALLINO_TIMEZONE": "Europe/Rome" }
    }
  }
}
```

Set `PALLINO_TIMEZONE` (IANA name) so "today" is computed in your zone; it falls back to `TZ`, then the server zone.

### Agent skill

[`skills/pallino/SKILL.md`](skills/pallino/SKILL.md) teaches an agent how to use these tools well: orient first, read freely, write only after the user's OK, use `revision`, rewrite note bodies whole, map "every Monday" or "by Friday" to the right fields, format summaries. For Claude Code:

```sh
mkdir -p ~/.claude/skills/pallino
curl -fsSL https://raw.githubusercontent.com/gorlix/pallino-mcp/main/skills/pallino/SKILL.md -o ~/.claude/skills/pallino/SKILL.md
```

For claude.ai, zip the `skills/pallino` folder and upload it under Settings → Capabilities → Skills. Add your own default space, membership id and project ids at the end of the file to skip lookups.

## Remote / self-host

```sh
docker run -d -p 3000:3000 \
  -e OAUTH_SECRET="$(openssl rand -hex 32)" \
  -e PUBLIC_URL=https://mcp.example.com \
  -e TRUST_PROXY=1 \
  ghcr.io/gorlix/pallino-mcp:latest
```

Generate `OAUTH_SECRET` once and keep it stable: a new value logs every connected client out.

Or use [`docker-compose.example.yml`](docker-compose.example.yml). Without Docker: `npx -y @pallino.me/mcp --transport http --port 3000`.

Put a reverse proxy with HTTPS in front. OAuth clients require HTTPS, and `PUBLIC_URL` must be the exact public origin.

**claude.ai custom connector:** add a connector with URL `https://mcp.example.com/mcp`. During the OAuth flow a page asks you to paste your Pallino API key; the server checks it against Pallino and seals it into the tokens.

**Clients that support headers:** skip OAuth and send `Authorization: Bearer pallino_xxx` to `/mcp`. This works with or without `OAUTH_SECRET`.

**Self-hosted Pallino:** set `PALLINO_BASE_URL` to your Pallino server (default `https://cloud.pallino.me`).

Health check: `GET /healthz`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` (flag `--transport`) |
| `PALLINO_API_KEY` | | Key for stdio; for HTTP only used with `ALLOW_ENV_KEY` |
| `PALLINO_BASE_URL` | `https://cloud.pallino.me` | Pallino server |
| `PALLINO_TIMEZONE` / `TZ` | server zone | IANA zone used for "today" |
| `HOST` | `127.0.0.1` | HTTP bind address (flag `--host`); Docker image uses `0.0.0.0` |
| `PORT` | `3000` | HTTP port (flag `--port`) |
| `PUBLIC_URL` | `http://HOST:PORT` | Public origin, used by OAuth metadata and host checks |
| `OAUTH_SECRET` | | 32+ chars; enables the OAuth facade |
| `ALLOW_ENV_KEY` | `false` | HTTP: use `PALLINO_API_KEY` when a request has no Authorization header |
| `TRUST_PROXY` | | Express `trust proxy` (`true`, a hop count, or a subnet) |

## Security notes

- API keys are never logged and never put in URLs.
- OAuth is stateless: client ids, codes and tokens are AES-256-GCM sealed blobs holding the Pallino key. There is no database.
- Changing `OAUTH_SECRET` revokes every client and token.
- To cut an agent's access for good, revoke the key in Pallino.
- Authorization codes are single-use per process only (they also expire after 2 minutes and need PKCE S256). Access tokens last 1 hour, refresh tokens 90 days.
- Keep `ALLOW_ENV_KEY` off on a public server: it lets anonymous callers use your key.

## Development

```sh
npm ci
npm run dev        # tsx src/index.ts
npm run typecheck
npm test           # PALLINO_LIVE_KEY=... enables the read-only live test
npm run build
```

MIT License.
