import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PallinoClient } from "../src/client.js";
import { registerTools, todayIn } from "../src/tools.js";

const U = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const TZ = "Pacific/Kiritimati";

let responses: Response[];
const fetchMock = vi.fn(async (_u: URL | string | Request, _i?: RequestInit) => responses.shift() ?? new Response("{}", { status: 200 }));
const ok = (b: unknown = {}) => new Response(JSON.stringify(b), { status: 200 });

let client: Client;
beforeEach(async () => {
  fetchMock.mockClear();
  responses = [];
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, () => new PallinoClient("pallino_testkey_testkey_testkey", "https://p.test", fetchMock as unknown as typeof fetch), { timeZone: TZ });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

async function call(name: string, args: Record<string, unknown>, ...res: Response[]) {
  responses = res.length ? res : [ok()];
  const r = await client.callTool({ name, arguments: args });
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  return { r, method: init?.method, path: url ? new URL(String(url)).pathname + new URL(String(url)).search : undefined, body: init?.body ? JSON.parse(String(init.body)) : undefined };
}

describe("tool listing", () => {
  it("lists 16 tools with annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    for (const t of tools) {
      const a = t.annotations!;
      if (/_(list|get)_/.test(t.name)) expect(a.readOnlyHint).toBe(true);
      else expect(a.readOnlyHint).toBe(false);
      expect(a.destructiveHint).toBe(t.name.includes("_delete_"));
    }
  });
});

describe("tool calls", () => {
  it("list_spaces", async () => {
    const x = await call("pallino_list_spaces", {}, ok([{ id: U }]));
    expect([x.method, x.path]).toEqual(["GET", "/v1/agent/spaces"]);
  });
  it("list_projects / create / rename / delete", async () => {
    expect(await call("pallino_list_projects", { space_id: U })).toMatchObject({ method: "GET", path: `/v1/agent/spaces/${U}/projects` });
    fetchMock.mockClear();
    expect(await call("pallino_create_project", { space_id: U, name: "P" })).toMatchObject({ method: "POST", path: `/v1/agent/spaces/${U}/projects`, body: { name: "P" } });
    fetchMock.mockClear();
    expect(await call("pallino_rename_project", { project_id: V, name: "Q" })).toMatchObject({ method: "PATCH", path: `/v1/agent/projects/${V}`, body: { name: "Q" } });
    fetchMock.mockClear();
    const d = await call("pallino_delete_project", { project_id: V }, new Response(null, { status: 204 }));
    expect([d.method, d.path]).toEqual(["DELETE", `/v1/agent/projects/${V}`]);
    expect(d.r.structuredContent).toEqual({ deleted: V });
  });
  it("notes", async () => {
    expect(await call("pallino_list_notes", { space_id: U, q: "x", archived: false, limit: 5 })).toMatchObject({
      method: "GET",
      path: `/v1/agent/spaces/${U}/notes?q=x&archived=false&limit=5`,
    });
    fetchMock.mockClear();
    expect(await call("pallino_get_note", { note_id: V })).toMatchObject({ method: "GET", path: `/v1/agent/notes/${V}` });
    fetchMock.mockClear();
    expect(await call("pallino_create_note", { space_id: U, title: "T", type: "list" })).toMatchObject({ method: "POST", path: `/v1/agent/spaces/${U}/notes`, body: { title: "T", type: "list" } });
    fetchMock.mockClear();
    const u = await call("pallino_update_note", { note_id: V, title: "N", project_id: null });
    expect(u).toMatchObject({ method: "PATCH", path: `/v1/agent/notes/${V}` });
    expect(u.body).toEqual({ title: "N", project_id: null });
    fetchMock.mockClear();
    const d = await call("pallino_delete_note", { note_id: V }, new Response(null, { status: 204 }));
    expect(d.method).toBe("DELETE");
    expect(d.r.structuredContent).toEqual({ deleted: V });
  });
  it("tasks", async () => {
    expect(await call("pallino_list_tasks", { space_id: U, done: false, due_from: "2026-01-01" })).toMatchObject({
      method: "GET",
      path: `/v1/agent/spaces/${U}/tasks?done=false&due_from=2026-01-01`,
    });
    fetchMock.mockClear();
    expect(await call("pallino_get_task", { task_id: V })).toMatchObject({ method: "GET", path: `/v1/agent/tasks/${V}` });
    fetchMock.mockClear();
    const c = await call("pallino_create_task", { space_id: U, title: "Do", time: "09:30" });
    expect(c).toMatchObject({ method: "POST", path: `/v1/agent/spaces/${U}/tasks` });
    expect(c.body).toEqual({ title: "Do", time: "09:30", today: todayIn(TZ) });
    fetchMock.mockClear();
    const up = await call("pallino_update_task", { task_id: V, prio: 2, due: null });
    expect(up.body).toEqual({ prio: 2, due: null, today: todayIn(TZ) });
    fetchMock.mockClear();
    const done = await call("pallino_complete_task", { task_id: V });
    expect(done).toMatchObject({ method: "PATCH", path: `/v1/agent/tasks/${V}`, body: { done: true, today: todayIn(TZ) } });
    fetchMock.mockClear();
    expect((await call("pallino_complete_task", { task_id: V, done: false })).body.done).toBe(false);
    fetchMock.mockClear();
    const d = await call("pallino_delete_task", { task_id: V }, new Response(null, { status: 204 }));
    expect(d.r.structuredContent).toEqual({ deleted: V });
  });
});

describe("errors and validation", () => {
  it.each([
    [403, "forbidden", "not granted"],
    [409, "conflict", "revision"],
  ])("surfaces %i with hint", async (status, code, hint) => {
    const { r } = await call("pallino_get_task", { task_id: V }, new Response(JSON.stringify({ error: { code, message: "nope" } }), { status }));
    expect(r.isError).toBe(true);
    const text = (r.content as { text: string }[])[0].text;
    expect(text).toContain(`${status} ${code}`);
    expect(text).toContain(hint);
  });

  it("rejects invalid input without calling Pallino", async () => {
    for (const [name, args] of [
      ["pallino_create_task", { space_id: U, title: "x", time: "25:00" }],
      ["pallino_create_task", { space_id: U, title: "x", tags: ["a", "b", "c", "d"] }],
    ] as const) {
      const r = await client.callTool({ name, arguments: { ...args } }).catch(() => ({ isError: true }));
      expect(r.isError).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resources", () => {
  it("serves pallino://capabilities", async () => {
    responses = [ok({ limits: 1 })];
    const r = await client.readResource({ uri: "pallino://capabilities" });
    expect(JSON.parse((r.contents[0] as { text: string }).text)).toEqual({ limits: 1 });
    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe("/v1/capabilities");
  });
});
