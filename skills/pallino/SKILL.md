---
name: pallino
description: Work with Pallino (spaces, projects, notes and tasks) through the pallino-mcp server. Use whenever the user mentions Pallino, their Pallino notes, lists, projects or tasks, asks what they have to do, wants a summary of tasks assigned to them, or asks to add, edit, reschedule, complete or delete a task or note in Pallino.
---

# Working with Pallino

Tools come from the `pallino-mcp` server (`pallino_*`). What they can do is limited by the user's API key: every space lists the actions granted.

## Ground rules

- **Read freely, write only with an explicit OK.** Before creating, editing, rescheduling, completing or deleting, state the exact change in one line and wait for the user to confirm. One OK covers the change it was given for, not later ones.
- **Shared spaces are shared.** In a space with other members, every change is visible to them. Never touch a task assigned to someone else unless the user asks for that task.
- **Deleting is permanent** (no trash). Ask every time; prefer completing a task or archiving a note.
- Reply in the user's language. Task titles and descriptions hold practical facts only, never pieces of the conversation.

## Start of every job: orient

1. `pallino_list_spaces` once per conversation. Keep in mind for each space: `id`, `name`, `role`, `membership_id` (the user in that space), `members` (`id` = membership, `name`) and `actions` (what the key may do).
2. `pallino_list_projects` for the space you work in, to turn project ids into names.
3. Pick the space from what the user says. If two spaces fit and the request writes, ask which.
4. Check `actions` before proposing a write: if the action is missing, say the key does not allow it instead of trying.

## Reading

- `pallino_list_tasks` with `space_id`, `done: false`, `limit: 200`; if `more` is true, call again with `offset` += 200.
- **The user's tasks** = `who` equal to their `membership_id` in that space (or `who` holding their name as free text). Tasks without assignee or of others stay out of personal summaries unless asked.
- Filters: `due_from`/`due_to` are inclusive and skip tasks with no `due`; overdue = `due` or `deadline` before today and not done. `q` searches title and description; `project_id`, `note_id`, `parent_id` (subtasks).
- `pallino_list_notes` returns no body: use `pallino_get_note` for the text. Filters: `q`, `type`, `archived`, `project_id`.
- Context for a task: project name, parent task (`pallino_get_task` on `parent_id`), linked note (`pallino_get_note` on `note_id`).

## Data model, as the API enforces it

- Space → projects, notes, tasks. Notes and tasks may belong to a project of the same space.
- **Task fields:** `title` (≤500, no newlines), `desc`, `due` (planned day `YYYY-MM-DD`) + `time` (`HH:MM`), `deadline` + `deadline_time` (the real cutoff), `prio` 1 urgent … 4 none, `who` (membership id, free name or empty), `tags` (≤3, 1–50 chars), `location`, `duration_minutes` (1–1440), `recurrence`, `started`, `done`, `note_id`, `parent_id`.
- **Subtasks:** two levels at most; a subtask cannot have children. Deleting a parent keeps its subtasks, without parent.
- **Recurrence:** `{unit: day|week|month|year|weekday, interval, from_completion}`. Completing a recurring task moves it to the next date and bumps `habit` (streak); it does not close it. To stop it, set `recurrence: null` first.
- **Notes:** types `note`, `list`, `template`, `bookmark`, chosen only at creation; Markdown body. Templates are never pinned or archived.
- Deleting a project keeps its notes and tasks in the space, without project.

## Mapping what the user says

| User says | Field |
|---|---|
| "on Friday", "tomorrow at 9" | `due` (+ `time`) |
| "by", "due", "deadline" | `deadline` (+ `deadline_time`) |
| "urgent" / "important" / "when I can" | `prio` 1 / 2 / 4 |
| "assign to Anna", "mine" | `who` = that member's membership id |
| "every Monday" | `recurrence {unit: week, interval: 1}` + `due` on a Monday |
| "every 3 days after I do it" | `recurrence {unit: day, interval: 3, from_completion: true}` |
| "weekdays" | `recurrence {unit: weekday, interval: 1}` |

Resolve relative dates against today in the user's time zone. The server computes `today` from `PALLINO_TIMEZONE`; you pass absolute dates.

## Writing (after the OK)

- **Create:** search duplicates first (`q` with the key words). Then `pallino_create_task` / `pallino_create_note` with the right `space_id`, `project_id`, `who`.
- **Edit:** read the record right before, then pass its `revision` to `pallino_update_task` / `pallino_update_note` / `pallino_rename_project`. Omitted fields stay as they are; `null` clears.
- **Note body replaces the whole text.** Read it with `pallino_get_note`, change it, send it back complete. Never send only the new lines. The old text is kept as a version server-side.
- **Reschedule:** `pallino_update_task` with the new `due` (and `deadline` if it moves too).
- **Complete:** `pallino_complete_task` (`done: false` reopens).
- **Projects:** create, rename or delete only when asked explicitly.
- After each write, confirm in one line from the returned record (title, date, assignee). No need to re-read: the tool returns the saved record.

## Errors

| Error | Meaning | Do |
|---|---|---|
| `conflict` (409) | Someone changed it since your read | Re-read, re-apply the change, show the user if it differs, retry with the new `revision` |
| 403 | The key lacks that action in that space | Tell the user which action is missing; do not retry |
| `not_found` (404) | Gone, or not visible to this key | Re-list; ids from earlier may be stale |
| `invalid_input` + field | A value breaks a limit | Fix that field (tags ≤3, `HH:MM`, no newline in title) |
| `unauthorized` | Key missing, expired or revoked | Ask the user to check the key |
| `rate_limited` | Too many calls | Wait, then batch: one list with filters beats many gets |

## Summaries

Group by project, one line per task, earliest first:

`☐ [dd/mm] Title · Project` (+ `⏰ HH:MM` if timed, `❗` if prio 1, `🔴` if overdue)

- Today: the user's tasks with `due` or `deadline` today, plus overdue.
- Tomorrow / this week: same with the matching range.
- Overdue for more than a few days: offer to reschedule, complete or delete, and act only on the answer.
- Nothing to show: say so in one line.

## Personal setup (optional)

A user can copy this skill and pin their own context below, so the agent skips lookups: default space, their membership id, project names → ids, house rules (e.g. "space X is for club work only"). Ids can change: if one fails, fall back to `pallino_list_spaces` / `pallino_list_projects`.
