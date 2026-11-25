import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PallinoClient, PallinoError } from "./client.js";

/** Returns the Pallino client for the current request (stdio: env key; HTTP: the caller's key). */
export type ClientResolver = (authExtra?: Record<string, unknown>) => PallinoClient;

export const INSTRUCTIONS = `Pallino is a notes-and-tasks app. Data lives in spaces (personal or shared with other members).
Each space holds projects, notes (types: note, list, template, bookmark; Markdown body) and tasks.
- Start with pallino_list_spaces: it returns space ids, members (their membership id is what goes in a task's "who"), and the actions this API key is granted per type. A 403 means the key lacks that action.
- Notes and tasks can belong to a project; a task can link to a note and have a parent task (two levels at most).
- Tasks: due/deadline are dates (YYYY-MM-DD), time/deadline_time are HH:MM, prio 1 (urgent) to 4 (none). Completing a recurring task moves it to its next date instead of marking it done.
- Updates accept an optional "revision" from the last read: if someone changed the record since, the call fails with "conflict"; re-read and retry.
- Replaced note text is kept as a version server-side, so edits never lose data. Deleting is permanent.
- Lists are paginated (limit up to 200, offset); "more": true means another page exists.`;

const id = (what: string) => z.string().uuid().describe(`${what} id (UUID)`);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/, "HH:MM (24h) or empty");
const tags = z.array(z.string().min(1).max(50)).max(3).describe("Up to 3 tags, 1-50 chars each");
const limit = z.number().int().min(1).max(200).optional().describe("Max records (default 50, max 200)");
const offset = z.number().int().min(0).max(100000).optional().describe("Records to skip (default 0)");
const revision = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Revision from your last read; if the record changed since, the call fails with conflict. Omit or 0 to overwrite.");
const projectName = z.string().min(1).max(100).regex(/^[^\r\n]*$/, "no newlines").describe("1-100 chars, no newlines");

const noteFields = {
  title: z.string().max(500).regex(/^[^\r\n]*$/, "no newlines").optional().describe("Up to 500 chars, no newlines"),
  body: z.string().optional().describe("Markdown body (title + body up to 1 MiB)"),
  pinned: z.boolean().optional().describe("Pinned (templates are never pinned)"),
  archived: z.boolean().optional().describe("Archived (templates are never archived)"),
  tags: tags.optional(),
  project_id: id("Project").nullable().optional().describe("Project of the same space; null removes it"),
};

const recurrence = z
  .object({
    unit: z.enum(["day", "week", "month", "year", "weekday"]),
    interval: z.number().int().min(1).max(999).describe("Every N units (1 for weekday)"),
    from_completion: z.boolean().optional().describe("Count the next date from completion instead of the due date"),
  })
  .nullable()
  .describe("Recurrence rule; null removes it");

const taskFields = {
  title: z.string().max(500).regex(/^[^\r\n]*$/, "no newlines").optional().describe("Up to 500 chars, no newlines"),
  desc: z.string().optional().describe("Description"),
  due: date.nullable().optional().describe("Planned day YYYY-MM-DD; null clears"),
  time: hhmm.nullable().optional().describe("Planned time HH:MM; empty/null none"),
  deadline: date.nullable().optional().describe("Deadline day YYYY-MM-DD; null clears"),
  deadline_time: hhmm.nullable().optional().describe("Deadline time HH:MM; empty/null none"),
  prio: z.number().int().min(1).max(4).optional().describe("1 urgent ... 4 none"),
  duration_minutes: z.number().int().min(1).max(1440).nullable().optional().describe("Estimated minutes"),
  tags: tags.optional(),
  who: z.string().max(100).optional().describe("Assignee: a member's membership id (see pallino_list_spaces), a free name, or empty"),
  location: z.string().max(200).optional(),
  recurrence: recurrence.optional(),
  project_id: id("Project").nullable().optional().describe("Project of the same space; null removes it"),
  note_id: id("Note").nullable().optional().describe("Linked note of the same space; null removes it"),
  parent_id: id("Parent task").nullable().optional().describe("Parent task (must have no parent itself); null removes it"),
};

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

/** Today's date in the given IANA time zone (the Pallino server cannot know the caller's zone). */
export function todayIn(timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function ok(data: unknown): CallToolResult {
  const structured = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { result: data ?? "ok" };
  return { content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }, null, 2) }], structuredContent: structured };
}

const HINTS: Record<string, string> = {
  unauthorized: "The API key is missing, expired or revoked.",
  forbidden: "This API key is not granted the action needed for this change in this space (see actions in pallino_list_spaces).",
  not_found: "The record does not exist or this key cannot see it.",
  conflict: "The record changed since the given revision: re-read it and retry with the new revision.",
  rate_limited: "Too many requests: wait and retry.",
};

function fail(e: unknown): CallToolResult {
  if (e instanceof PallinoError) {
    const hint = HINTS[e.code] ?? (e.status === 403 ? HINTS.forbidden : e.status === 404 ? HINTS.not_found : "");
    const field = e.field ? ` (field: ${e.field})` : "";
    return { isError: true, content: [{ type: "text", text: `Pallino error ${e.status} ${e.code}${field}: ${e.message}${hint ? `\n${hint}` : ""}` }] };
  }
  return { isError: true, content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
}

/** Drops undefined values so omitted fields stay unchanged server-side (null is kept: it clears). */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface ToolOptions {
  timeZone?: string;
}

export function registerTools(server: McpServer, resolve: ClientResolver, opts: ToolOptions = {}): void {
  type Extra = { authInfo?: { extra?: Record<string, unknown> } };
  const run =
    <A>(fn: (c: PallinoClient, args: A) => Promise<unknown>) =>
    async (args: A, extra: Extra): Promise<CallToolResult> => {
      try {
        return ok(await fn(resolve(extra.authInfo?.extra), args));
      } catch (e) {
        return fail(e);
      }
    };
  const today = (given?: string) => given ?? todayIn(opts.timeZone);
  const seg = encodeURIComponent;

  // Spaces
  server.registerTool(
    "pallino_list_spaces",
    {
      title: "List spaces",
      description: "List the spaces this API key reaches, with members (membership ids for task assignment) and the actions granted per type.",
      inputSchema: {},
      annotations: RO,
    },
    run((c) => c.request("GET", "v1/agent/spaces")),
  );

  // Projects
  server.registerTool(
    "pallino_list_projects",
    { title: "List projects", description: "List the projects of a space.", inputSchema: { space_id: id("Space") }, annotations: RO },
    run((c, a: { space_id: string }) => c.request("GET", `v1/agent/spaces/${seg(a.space_id)}/projects`)),
  );
  server.registerTool(
    "pallino_create_project",
    { title: "Create project", description: "Create a project in a space.", inputSchema: { space_id: id("Space"), name: projectName }, annotations: WRITE },
    run((c, a: { space_id: string; name: string }) => c.request("POST", `v1/agent/spaces/${seg(a.space_id)}/projects`, { body: { name: a.name } })),
  );
  server.registerTool(
    "pallino_rename_project",
    { title: "Rename project", description: "Rename a project.", inputSchema: { project_id: id("Project"), name: projectName, revision }, annotations: EDIT },
    run((c, a: { project_id: string; name: string; revision?: number }) =>
      c.request("PATCH", `v1/agent/projects/${seg(a.project_id)}`, { body: compact({ name: a.name, revision: a.revision }) }),
    ),
  );
  server.registerTool(
    "pallino_delete_project",
    {
      title: "Delete project",
      description: "Permanently delete a project. Its notes and tasks stay in the space, without project.",
      inputSchema: { project_id: id("Project") },
      annotations: DELETE,
    },
    run(async (c, a: { project_id: string }) => {
      await c.request("DELETE", `v1/agent/projects/${seg(a.project_id)}`);
      return { deleted: a.project_id };
    }),
  );

  // Notes
  server.registerTool(
    "pallino_list_notes",
    {
      title: "List notes",
      description: "List or search the notes of a space (without body; use pallino_get_note for it).",
      inputSchema: {
        space_id: id("Space"),
        q: z.string().optional().describe("Case-insensitive search in title or body"),
        type: z.enum(["note", "list", "template", "bookmark"]).optional(),
        archived: z.boolean().optional().describe("true only archived, false only not archived; omit for both"),
        project_id: id("Project").optional(),
        limit,
        offset,
      },
      annotations: RO,
    },
    run((c, { space_id, ...query }: { space_id: string } & Record<string, string | number | boolean | undefined>) =>
      c.request("GET", `v1/agent/spaces/${seg(space_id)}/notes`, { query }),
    ),
  );
  server.registerTool(
    "pallino_get_note",
    { title: "Get note", description: "Get one note with its body.", inputSchema: { note_id: id("Note") }, annotations: RO },
    run((c, a: { note_id: string }) => c.request("GET", `v1/agent/notes/${seg(a.note_id)}`)),
  );
  server.registerTool(
    "pallino_create_note",
    {
      title: "Create note",
      description: "Create a note in a space. All fields optional.",
      inputSchema: {
        space_id: id("Space"),
        ...noteFields,
        type: z.enum(["note", "list", "template", "bookmark"]).optional().describe("Chosen only at creation (default note)"),
      },
      annotations: WRITE,
    },
    run((c, { space_id, ...body }: { space_id: string } & Record<string, unknown>) =>
      c.request("POST", `v1/agent/spaces/${seg(space_id)}/notes`, { body: compact(body) }),
    ),
  );
  server.registerTool(
    "pallino_update_note",
    {
      title: "Update note",
      description:
        "Update a note. Omitted fields stay unchanged. body replaces the whole text (the old text is kept as a version). title/body need 'edit'; pinned/archived/tags/project_id need 'organize'.",
      inputSchema: { note_id: id("Note"), ...noteFields, revision },
      annotations: EDIT,
    },
    run((c, { note_id, ...body }: { note_id: string } & Record<string, unknown>) =>
      c.request("PATCH", `v1/agent/notes/${seg(note_id)}`, { body: compact(body) }),
    ),
  );
  server.registerTool(
    "pallino_delete_note",
    { title: "Delete note", description: "Permanently delete a note and its versions.", inputSchema: { note_id: id("Note") }, annotations: DELETE },
    run(async (c, a: { note_id: string }) => {
      await c.request("DELETE", `v1/agent/notes/${seg(a.note_id)}`);
      return { deleted: a.note_id };
    }),
  );

  // Tasks
  server.registerTool(
    "pallino_list_tasks",
    {
      title: "List tasks",
      description: "List or search the tasks of a space. Date filters are inclusive; tasks without a due day are outside any date range.",
      inputSchema: {
        space_id: id("Space"),
        q: z.string().optional().describe("Case-insensitive search in title or description"),
        done: z.boolean().optional().describe("true only done, false only to do; omit for both"),
        due_from: date.optional().describe("From this due day, inclusive"),
        due_to: date.optional().describe("To this due day, inclusive"),
        project_id: id("Project").optional(),
        note_id: id("Note").optional(),
        parent_id: id("Parent task").optional().describe("Only subtasks of this task"),
        limit,
        offset,
      },
      annotations: RO,
    },
    run((c, { space_id, ...query }: { space_id: string } & Record<string, string | number | boolean | undefined>) =>
      c.request("GET", `v1/agent/spaces/${seg(space_id)}/tasks`, { query }),
    ),
  );
  server.registerTool(
    "pallino_get_task",
    { title: "Get task", description: "Get one task.", inputSchema: { task_id: id("Task") }, annotations: RO },
    run((c, a: { task_id: string }) => c.request("GET", `v1/agent/tasks/${seg(a.task_id)}`)),
  );
  server.registerTool(
    "pallino_create_task",
    {
      title: "Create task",
      description: "Create a task in a space.",
      inputSchema: { space_id: id("Space"), ...taskFields, title: taskFields.title.unwrap().min(1).describe("Task title, up to 500 chars") },
      annotations: WRITE,
    },
    run((c, { space_id, ...body }: { space_id: string } & Record<string, unknown>) =>
      c.request("POST", `v1/agent/spaces/${seg(space_id)}/tasks`, { body: { ...compact(body), today: today() } }),
    ),
  );
  server.registerTool(
    "pallino_update_task",
    {
      title: "Update task",
      description:
        "Update a task. Omitted fields stay unchanged; null clears. due/time/deadline/deadline_time need 'reschedule', done needs 'complete', the rest 'edit'.",
      inputSchema: {
        task_id: id("Task"),
        ...taskFields,
        done: z.boolean().optional().describe("true completes the occurrence (a recurring task moves to its next date); false reopens"),
        started: z.boolean().optional().describe("Manually started"),
        revision,
      },
      annotations: EDIT,
    },
    run((c, { task_id, ...body }: { task_id: string } & Record<string, unknown>) =>
      c.request("PATCH", `v1/agent/tasks/${seg(task_id)}`, { body: { ...compact(body), today: today() } }),
    ),
  );
  server.registerTool(
    "pallino_complete_task",
    {
      title: "Complete task",
      description: "Mark a task done (a recurring task moves to its next date and updates its habit streak). Set done=false to reopen.",
      inputSchema: { task_id: id("Task"), done: z.boolean().optional().describe("Default true") },
      annotations: EDIT,
    },
    run((c, a: { task_id: string; done?: boolean }) =>
      c.request("PATCH", `v1/agent/tasks/${seg(a.task_id)}`, { body: { done: a.done ?? true, today: today() } }),
    ),
  );
  server.registerTool(
    "pallino_delete_task",
    {
      title: "Delete task",
      description: "Permanently delete a task. Its subtasks stay, without parent.",
      inputSchema: { task_id: id("Task") },
      annotations: DELETE,
    },
    run(async (c, a: { task_id: string }) => {
      await c.request("DELETE", `v1/agent/tasks/${seg(a.task_id)}`);
      return { deleted: a.task_id };
    }),
  );

  // Server capabilities (public, no key needed).
  server.registerResource(
    "capabilities",
    "pallino://capabilities",
    { title: "Pallino server capabilities", description: "Limits and agent actions supported by the Pallino server", mimeType: "application/json" },
    async (uri, extra) => {
      const data = await resolve((extra as Extra).authInfo?.extra).request("GET", "v1/capabilities");
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
    },
  );
}
