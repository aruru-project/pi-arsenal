import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { KanbanClient } from "./client.ts";
import type { KanbanToolInput } from "./schemas.ts";

interface CardContext {
  id: number;
  board_id: number;
}

interface CardDescriptionSnapshot extends CardContext {
  description: string;
  updated_at: string;
}

export interface KanbanActionRuntime {
  withFileMutationQueue<T>(path: string, operation: () => Promise<T>): Promise<T>;
}

const directRuntime: KanbanActionRuntime = {
  withFileMutationQueue: async (_path, operation) => operation(),
};

function requiredId(value: number | undefined, name: string): number {
  if (!value) throw new Error(`${name} is required for this Kanban action`);
  return value;
}

function requiredText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${name} is required for this Kanban action`);
  return text;
}

function requiredItemIds(value: number[] | undefined): number[] {
  if (!Array.isArray(value)) throw new Error("item_ids is required for reorder_checklist");
  if (value.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error("item_ids must contain positive integers");
  }
  if (new Set(value).size !== value.length) throw new Error("item_ids must not contain duplicates");
  return value;
}

function validateChecklistItems(
  action: "create_card" | "update_card",
  items: KanbanToolInput["checklist_items"],
): void {
  if (items === undefined) return;

  const existingIds = items.flatMap((item) => item.id === undefined ? [] : [item.id]);
  if (new Set(existingIds).size !== existingIds.length) {
    throw new Error("checklist_items must not contain duplicate IDs");
  }

  for (const item of items) {
    if (action === "create_card" && item.id !== undefined) {
      throw new Error("create_card checklist items cannot reference existing IDs");
    }
    if (item._destroy === true && item.id === undefined) {
      throw new Error("_destroy requires an existing checklist item ID");
    }
    if (item.id === undefined && item._destroy !== true && !item.content?.trim()) {
      throw new Error("New checklist items require content");
    }
    if (item.id !== undefined && item._destroy !== true && item.content === undefined && item.completed === undefined) {
      throw new Error("Existing checklist items require content, completed, or _destroy");
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kanban API returned an unexpected object");
  }
  return value as Record<string, unknown>;
}

function exactMatchIndexes(value: string, search: string): number[] {
  const indexes: number[] = [];
  for (let index = value.indexOf(search); index >= 0; index = value.indexOf(search, index + 1)) {
    indexes.push(index);
  }
  return indexes;
}

async function cardDescriptionSnapshot(
  client: KanbanClient,
  cardId: number,
  signal?: AbortSignal,
): Promise<CardDescriptionSnapshot> {
  const card = asRecord(await client.json("GET", `/cards/${cardId}`, undefined, signal));
  const id = Number(card.id);
  const boardId = Number(card.board_id);
  const description = card.description;
  const updatedAt = card.updated_at;
  if (!Number.isInteger(id) || id <= 0 || id !== cardId) {
    throw new Error("Card response is missing the requested id");
  }
  if (!Number.isInteger(boardId) || boardId <= 0) {
    throw new Error("Card response is missing board_id");
  }
  let descriptionText: string;
  if (description === null) descriptionText = "";
  else if (typeof description === "string") descriptionText = description;
  else throw new Error("Card response is missing description");
  if (typeof updatedAt !== "string" || !updatedAt) {
    throw new Error("Card response is missing updated_at");
  }
  return { id, board_id: boardId, description: descriptionText, updated_at: updatedAt };
}

function filterCompleted(payload: unknown, includeCompleted?: boolean): unknown {
  if (includeCompleted) return payload;
  const record = asRecord(payload);
  if (!Array.isArray(record.cards)) return payload;
  const cards = record.cards.filter((card) => {
    return !card || typeof card !== "object" || !(card as Record<string, unknown>).completed_at;
  });
  return { ...record, cards, total: cards.length };
}

async function cardContext(client: KanbanClient, input: KanbanToolInput, signal?: AbortSignal): Promise<CardContext> {
  const id = requiredId(input.card_id, "card_id");
  if (input.board_id) return { id, board_id: input.board_id };
  const card = asRecord(await client.json("GET", `/cards/${id}`, undefined, signal));
  const boardId = Number(card.board_id);
  if (!Number.isInteger(boardId) || boardId <= 0) throw new Error("Card response is missing board_id");
  return { id, board_id: boardId };
}

function cardFields(input: KanbanToolInput): Record<string, unknown> {
  const card: Record<string, unknown> = {};
  if (input.title !== undefined) card.title = input.title;
  if (input.description !== undefined) card.description = input.description;
  if (input.due_date !== undefined) card.due_date = input.due_date;
  if (input.clear_due_date) card.due_date = null;
  if (input.assignee_id !== undefined) card.assignee_id = input.assignee_id;
  if (input.clear_assignee) card.assignee_id = null;
  if (input.labels !== undefined) card.labels = input.labels;
  if (input.checklist_items !== undefined) {
    validateChecklistItems(input.action === "create_card" ? "create_card" : "update_card", input.checklist_items);
    card.checklist_items = input.checklist_items;
  }
  return card;
}

function batchCardFields(input: NonNullable<KanbanToolInput["cards"]>[number]): Record<string, unknown> {
  const card: Record<string, unknown> = { title: requiredText(input.title, "cards[].title") };
  if (input.description !== undefined) card.description = input.description;
  if (input.due_date !== undefined) card.due_date = input.due_date;
  if (input.assignee_id !== undefined) card.assignee_id = input.assignee_id;
  if (input.labels !== undefined) card.labels = input.labels;
  if (input.checklist_items !== undefined) {
    validateChecklistItems("create_card", input.checklist_items);
    card.checklist_items = input.checklist_items;
  }
  return card;
}

function queryString(input: KanbanToolInput): string {
  const params = new URLSearchParams();
  if (input.board_id) params.set("board_id", String(input.board_id));
  if (input.list_id) params.set("list_id", String(input.list_id));
  if (input.assignee_id) params.set("assignee_id", String(input.assignee_id));
  if (input.query) params.set("q", input.query);
  input.label?.forEach((label) => params.append("label[]", label));
  if (input.overdue) params.set("overdue", "true");
  if (input.updated_since) params.set("updated_since", input.updated_since);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function normalizePath(cwd: string, path: string): string {
  const normalized = path.startsWith("@") ? path.slice(1) : path;
  return resolve(cwd, normalized);
}

export async function executeKanbanAction(
  client: KanbanClient,
  input: KanbanToolInput,
  cwd: string,
  signal?: AbortSignal,
  runtime: KanbanActionRuntime = directRuntime,
): Promise<unknown> {
  switch (input.action) {
    case "list_boards":
      return client.json("GET", "/boards", undefined, signal);

    case "get_board":
      return client.json("GET", `/boards/${requiredId(input.board_id, "board_id")}`, undefined, signal);

    case "summary":
      return client.json("GET", `/boards/${requiredId(input.board_id, "board_id")}/summary`, undefined, signal);

    case "list_lists":
      return client.json("GET", `/boards/${requiredId(input.board_id, "board_id")}/lists`, undefined, signal);

    case "list_labels":
      return client.json("GET", `/boards/${requiredId(input.board_id, "board_id")}/labels`, undefined, signal);

    case "list_cards": {
      const prefix = input.board_id ? `/boards/${input.board_id}/cards` : "/cards";
      return filterCompleted(
        await client.json("GET", `${prefix}${queryString(input)}`, undefined, signal),
        input.include_completed,
      );
    }

    case "get_card":
      return client.json("GET", `/cards/${requiredId(input.card_id, "card_id")}`, undefined, signal);

    case "my_tasks":
      return filterCompleted(
        await client.json("GET", `/cards/mine${queryString(input)}`, undefined, signal),
        input.include_completed,
      );

    case "create_card": {
      const boardId = requiredId(input.board_id, "board_id");
      const card = cardFields(input);
      card.title = requiredText(input.title, "title");
      card.list_id = requiredId(input.list_id, "list_id");
      if (input.assignee_id === undefined && !input.clear_assignee) {
        const me = asRecord(await client.json("GET", "/me", undefined, signal));
        card.assignee_id = Number(me.id);
      }
      return client.json("POST", `/boards/${boardId}/cards`, { card }, signal);
    }

    case "create_cards": {
      const boardId = requiredId(input.board_id, "board_id");
      const listId = requiredId(input.list_id, "list_id");
      if (!input.cards?.length) throw new Error("cards is required for create_cards");
      const cards = input.cards.map(batchCardFields);
      if (cards.some((card) => card.assignee_id === undefined)) {
        const me = asRecord(await client.json("GET", "/me", undefined, signal));
        const assigneeId = Number(me.id);
        cards.forEach((card) => { card.assignee_id ??= assigneeId; });
      }
      return client.json("POST", `/boards/${boardId}/cards/batch`, { list_id: listId, cards }, signal);
    }

    case "update_card": {
      const card = await cardContext(client, input, signal);
      const fields = cardFields(input);
      if (Object.keys(fields).length === 0) throw new Error("At least one card field is required");
      return client.json("PATCH", `/boards/${card.board_id}/cards/${card.id}`, { card: fields }, signal);
    }

    case "edit_card_description": {
      const cardId = requiredId(input.card_id, "card_id");
      if (input.old_text === undefined || input.old_text.length === 0) {
        throw new Error("old_text is required and must not be empty for edit_card_description");
      }
      if (input.new_text === undefined) {
        throw new Error("new_text is required for edit_card_description");
      }

      const initial = await cardDescriptionSnapshot(client, cardId, signal);
      if (input.board_id !== undefined && input.board_id !== initial.board_id) {
        throw new Error(`Card ${cardId} does not belong to board ${input.board_id}`);
      }
      const matches = exactMatchIndexes(initial.description, input.old_text);
      if (matches.length === 0) {
        throw new Error("Description edit failed: old_text was not found");
      }
      if (matches.length > 1) {
        throw new Error(`Description edit failed: old_text must match exactly once (found ${matches.length} matches)`);
      }

      const matchIndex = matches[0];
      const nextDescription = initial.description.slice(0, matchIndex) + input.new_text +
        initial.description.slice(matchIndex + input.old_text.length);
      const latest = await cardDescriptionSnapshot(client, cardId, signal);
      if (
        latest.board_id !== initial.board_id ||
        latest.updated_at !== initial.updated_at ||
        latest.description !== initial.description
      ) {
        throw new Error("Description edit conflict: card changed after it was read; no update was sent");
      }

      input.description = nextDescription;
      return client.json("PATCH", `/boards/${initial.board_id}/cards/${cardId}`, {
        card: { description: nextDescription },
      }, signal);
    }

    case "delete_card": {
      const card = await cardContext(client, input, signal);
      return client.json("DELETE", `/boards/${card.board_id}/cards/${card.id}`, undefined, signal);
    }

    case "move_card":
      return client.json("PATCH", `/cards/${requiredId(input.card_id, "card_id")}/move`, {
        list_id: requiredId(input.list_id, "list_id"),
        position: input.position ?? 0,
      }, signal);

    case "set_card_completed":
      if (input.completed === undefined) throw new Error("completed is required");
      return client.json("PATCH", `/cards/${requiredId(input.card_id, "card_id")}/completion`, {
        completed: input.completed,
      }, signal);

    case "get_checklist": {
      const card = await cardContext(client, input, signal);
      return client.json("GET", `/boards/${card.board_id}/cards/${card.id}/checklist_status`, undefined, signal);
    }

    case "reorder_checklist": {
      const card = await cardContext(client, input, signal);
      return client.json("PATCH", `/boards/${card.board_id}/cards/${card.id}/reorder_checklist`, {
        item_ids: requiredItemIds(input.item_ids),
      }, signal);
    }

    case "add_card_label": {
      const card = await cardContext(client, input, signal);
      return client.json("POST", `/boards/${card.board_id}/cards/${card.id}/labels`, {
        label: {
          name: requiredText(input.label_name, "label_name"),
          ...(input.label_color ? { color: input.label_color } : {}),
        },
      }, signal);
    }

    case "remove_card_label": {
      const card = await cardContext(client, input, signal);
      return client.json("DELETE", `/boards/${card.board_id}/cards/${card.id}/labels`, {
        label: { name: requiredText(input.label_name, "label_name") },
      }, signal);
    }

    case "list_comments": {
      const card = await cardContext(client, input, signal);
      const params = new URLSearchParams();
      if (input.limit) params.set("limit", String(input.limit));
      if (input.before_id) params.set("before_id", String(input.before_id));
      const query = params.toString();
      return client.json("GET", `/boards/${card.board_id}/cards/${card.id}/comments${query ? `?${query}` : ""}`, undefined, signal);
    }

    case "create_comment": {
      const card = await cardContext(client, input, signal);
      return client.json("POST", `/boards/${card.board_id}/cards/${card.id}/comments`, {
        card_comment: { body: requiredText(input.content, "content") },
      }, signal);
    }

    case "list_attachments": {
      const card = await cardContext(client, input, signal);
      return client.json("GET", `/boards/${card.board_id}/cards/${card.id}/card_attachments`, undefined, signal);
    }

    case "upload_attachment": {
      const card = await cardContext(client, input, signal);
      const path = normalizePath(cwd, requiredText(input.file_path, "file_path"));
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`Attachment is not a file: ${path}`);
      if (info.size > 10 * 1024 * 1024) throw new Error("Attachment exceeds the 10MB limit");
      const form = new FormData();
      form.append("file", new Blob([await readFile(path)]), basename(path));
      return client.multipart("POST", `/boards/${card.board_id}/cards/${card.id}/card_attachments`, form, signal);
    }

    case "download_attachment": {
      const card = await cardContext(client, input, signal);
      const attachmentId = requiredId(input.attachment_id, "attachment_id");
      const output = normalizePath(cwd, requiredText(input.output_path, "output_path"));
      return runtime.withFileMutationQueue(output, async () => {
        if (!input.overwrite) {
          try {
            await access(output);
            throw new Error(`Output file already exists: ${output}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        const download = await client.download(
          `/boards/${card.board_id}/cards/${card.id}/card_attachments/${attachmentId}`,
          signal,
        );
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, download.data);
        return {
          output_path: output,
          byte_size: download.data.byteLength,
          content_type: download.contentType,
        };
      });
    }

    case "delete_attachment": {
      const card = await cardContext(client, input, signal);
      const attachmentId = requiredId(input.attachment_id, "attachment_id");
      return client.json("DELETE", `/boards/${card.board_id}/cards/${card.id}/card_attachments/${attachmentId}`, undefined, signal);
    }
  }
}
