import type { KanbanRole } from "./permissions.ts";
import type { KanbanAction, KanbanToolInput } from "./schemas.ts";

const CARD_READ_ACTIONS = new Set<KanbanAction>(["list_cards", "get_card", "my_tasks"]);
const LABEL_MUTATION_ACTIONS = new Set<KanbanAction>(["add_card_label", "remove_card_label"]);

const CARD_MUTATION_ACTIONS = new Set<KanbanAction>([
  "create_card",
  "update_card",
  "edit_card_description",
  "move_card",
  "set_card_completed",
]);

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function compactCard(
  value: unknown,
  options: { description?: boolean; boardName?: boolean } = {},
): Record<string, unknown> {
  const card = asRecord(value, "Kanban API returned an invalid card");
  const compact: Record<string, unknown> = {
    id: card.id,
    title: card.title,
    board_id: card.board_id,
    list_id: card.list_id,
    list_name: card.list_name,
    assignee_id: card.assignee_id,
    assignee_name: card.assignee_name,
    labels: card.labels,
    due_date: card.due_date,
    overdue: card.overdue,
    completed: card.completed,
    checklist: card.checklist,
    position: card.position,
  };
  if (options.boardName && card.board_name !== undefined) compact.board_name = card.board_name;
  if (options.description) compact.description = card.description;
  return compact;
}

function compactReadResult(input: KanbanToolInput, payload: unknown): unknown {
  if (input.action === "get_card") return compactCard(payload, { description: true });

  const record = asRecord(payload, "Kanban API returned an invalid cards response");
  if (!Array.isArray(record.cards)) return payload;
  const cards = record.cards.map((card) => compactCard(card, { boardName: input.action === "my_tasks" }));
  return { ...record, cards, total: cards.length };
}

function comparable(value: unknown): string {
  return JSON.stringify(value);
}

function verificationFields(input: KanbanToolInput): Record<string, unknown> {
  if (input.action === "move_card") {
    return { list_id: input.list_id, position: (input.position ?? 0) + 1 };
  }
  if (input.action === "set_card_completed") return { completed: input.completed };

  const fields: Record<string, unknown> = {};
  if (input.title !== undefined) fields.title = input.title;
  if (input.description !== undefined) fields.description = input.description;
  if (input.due_date !== undefined) fields.due_date = input.due_date;
  if (input.clear_due_date) fields.due_date = null;
  if (input.assignee_id !== undefined) fields.assignee_id = input.assignee_id;
  if (input.clear_assignee) fields.assignee_id = null;
  if (input.labels !== undefined) fields.labels = input.labels;
  if (input.action === "create_card" && input.list_id !== undefined) fields.list_id = input.list_id;
  return fields;
}

function mismatchValue(field: string, value: unknown): unknown {
  if (field !== "description") return value;
  return { length: typeof value === "string" ? value.length : 0 };
}

function normalizedLabelName(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function labelsMatch(requested: unknown, persisted: unknown): boolean {
  if (!Array.isArray(requested) || !Array.isArray(persisted)) return false;
  const expected = new Map<string, Record<string, unknown>>();
  requested.forEach((raw) => {
    const label = asRecord(raw, "Kanban label input is invalid");
    expected.set(normalizedLabelName(label.name), label);
  });
  if (expected.size !== persisted.length) return false;

  return [...expected.entries()].every(([name, label]) => {
    const match = persisted.find((raw) => {
      const candidate = asRecord(raw, "Kanban API returned an invalid label");
      return normalizedLabelName(candidate.name) === name;
    });
    if (!match) return false;
    const candidate = asRecord(match, "Kanban API returned an invalid label");
    return label.color === undefined || String(candidate.color).toLowerCase() === String(label.color).toLowerCase();
  });
}

function checklistItems(card: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(card.checklist_items)) {
    throw new Error("Kanban mutation response is missing canonical checklist_items");
  }
  return card.checklist_items.map((item) => asRecord(item, "Kanban mutation returned an invalid checklist item"));
}

function checklistMutationVerification(
  input: KanbanToolInput,
  card: Record<string, unknown>,
): { matches: boolean; mismatches: Array<Record<string, unknown>>; items: Record<string, unknown>[] } | undefined {
  if (input.checklist_items === undefined) return undefined;

  const persistedItems = checklistItems(card);
  const persistedById = new Map(persistedItems.map((item) => [Number(item.id), item]));
  const mutation = card.checklist_mutation && typeof card.checklist_mutation === "object"
    ? asRecord(card.checklist_mutation, "Kanban mutation returned invalid checklist metadata")
    : {};
  const createdIds = Array.isArray(mutation.created_item_ids)
    ? mutation.created_item_ids.map(Number)
    : persistedItems.map((item) => Number(item.id));
  const usedCreatedIds = new Set<number>();
  const mismatches: Array<Record<string, unknown>> = [];

  input.checklist_items.forEach((requested, index) => {
    if (requested._destroy === true) {
      if (requested.id !== undefined && persistedById.has(requested.id)) {
        mismatches.push({
          field: `checklist_items[${index}]`,
          requested: { id: requested.id, _destroy: true },
          persisted: persistedById.get(requested.id),
        });
      }
      return;
    }

    let persisted: Record<string, unknown> | undefined;
    if (requested.id !== undefined) {
      persisted = persistedById.get(requested.id);
    } else {
      const expectedCompleted = requested.completed ?? false;
      persisted = persistedItems.find((item) => {
        const id = Number(item.id);
        return createdIds.includes(id) && !usedCreatedIds.has(id) &&
          item.content === requested.content && item.completed === expectedCompleted;
      });
      if (persisted) usedCreatedIds.add(Number(persisted.id));
    }

    const expected: Record<string, unknown> = {};
    if (requested.id !== undefined) expected.id = requested.id;
    if (requested.content !== undefined) expected.content = requested.content;
    if (requested.completed !== undefined || requested.id === undefined) {
      expected.completed = requested.completed ?? false;
    }
    const itemMatches = persisted !== undefined && Object.entries(expected).every(([field, value]) => {
      return comparable(persisted?.[field]) === comparable(value);
    });
    if (!itemMatches) {
      mismatches.push({
        field: `checklist_items[${index}]`,
        requested: expected,
        persisted: persisted ?? null,
      });
    }
  });

  return { matches: mismatches.length === 0, mismatches, items: persistedItems };
}

function mutationReceipt(input: KanbanToolInput, payload: unknown): Record<string, unknown> {
  const card = asRecord(payload, "Kanban API returned an invalid mutation response");
  const requested = verificationFields(input);
  const verified: Record<string, boolean> = {};
  const mismatches: Array<Record<string, unknown>> = [];

  for (const [field, expected] of Object.entries(requested)) {
    const persisted = card[field];
    const matches = field === "labels"
      ? labelsMatch(expected, persisted)
      : comparable(expected) === comparable(persisted);
    verified[field] = matches;
    if (!matches) {
      mismatches.push({
        field,
        requested: mismatchValue(field, expected),
        persisted: mismatchValue(field, persisted),
      });
    }
  }

  const checklistVerification = checklistMutationVerification(input, card);
  if (checklistVerification) {
    verified.checklist_items = checklistVerification.matches;
    mismatches.push(...checklistVerification.mismatches);
  }

  const persisted: Record<string, unknown> = {
    id: card.id,
    title: card.title,
    board_id: card.board_id,
    list_id: card.list_id,
    list_name: card.list_name,
    assignee_id: card.assignee_id,
    assignee_name: card.assignee_name,
    due_date: card.due_date,
    completed: card.completed,
    completed_at: card.completed_at,
    labels: card.labels,
    checklist: card.checklist,
    position: card.position,
    updated_at: card.updated_at,
  };
  if (checklistVerification) persisted.checklist_items = checklistVerification.items;
  if (input.description !== undefined) {
    persisted.description_length = typeof card.description === "string" ? card.description.length : 0;
  }
  if (input.action === "move_card") persisted.requested_position_index = input.position ?? 0;

  return {
    ok: mismatches.length === 0,
    action: input.action,
    card_id: card.id,
    verified,
    mismatches,
    persisted,
  };
}

function batchMutationReceipt(input: KanbanToolInput, payload: unknown): Record<string, unknown> {
  const response = asRecord(payload, "Kanban API returned an invalid batch mutation response");
  if (!Array.isArray(response.cards)) throw new Error("Kanban batch mutation response is missing cards");
  const requested = input.cards ?? [];
  const countMatches = requested.length === response.cards.length;
  const positions = response.cards.map((card) => Number(asRecord(card, "Kanban API returned an invalid card").position));
  const positionsMatch = positions.every((position, index) => {
    return Number.isInteger(position) && position > 0 && (index === 0 || position === positions[index - 1] + 1);
  });
  const receipts = requested.slice(0, response.cards.length).map((card, index) => mutationReceipt({
    action: "create_card",
    board_id: input.board_id,
    list_id: input.list_id,
    ...card,
  }, response.cards[index]));
  const cardsMatch = countMatches && receipts.every((receipt) => receipt.ok === true);

  return {
    ok: cardsMatch && positionsMatch,
    action: input.action,
    verified: { count: countMatches, cards: cardsMatch, positions: positionsMatch },
    mismatches: [
      ...(countMatches ? [] : [{ field: "count", requested: requested.length, persisted: response.cards.length }]),
      ...(positionsMatch ? [] : [{ field: "positions", requested: "contiguous ascending positions", persisted: positions }]),
      ...receipts.flatMap((receipt, index) => {
        const mismatches = receipt.mismatches as Array<Record<string, unknown>>;
        return mismatches.map((mismatch) => ({ ...mismatch, card_index: index }));
      }),
    ],
    persisted: {
      total: response.cards.length,
      cards: receipts.map((receipt) => receipt.persisted),
    },
  };
}

function labelMutationReceipt(input: KanbanToolInput, payload: unknown): Record<string, unknown> {
  const card = asRecord(payload, "Kanban API returned an invalid label mutation response");
  if (!Array.isArray(card.labels)) throw new Error("Kanban label mutation response is missing labels");
  const expected = input.label_name?.trim().toLowerCase() ?? "";
  const present = card.labels.some((raw) => {
    const label = asRecord(raw, "Kanban API returned an invalid label");
    return String(label.name ?? "").trim().toLowerCase() === expected;
  });
  const matches = input.action === "add_card_label" ? present : !present;
  return {
    ok: matches,
    action: input.action,
    card_id: card.id,
    verified: { label: matches },
    mismatches: matches ? [] : [{ field: "label", requested: input.label_name, persisted: card.labels }],
    persisted: { labels: card.labels, updated_at: card.updated_at },
  };
}

function commentMutationReceipt(input: KanbanToolInput, payload: unknown): Record<string, unknown> {
  const comment = asRecord(payload, "Kanban API returned an invalid comment mutation response");
  const expected = input.content?.trim() ?? "";
  const matches = comment.body === expected;
  return {
    ok: matches,
    action: input.action,
    card_id: comment.card_id,
    comment_id: comment.id,
    verified: { content: matches },
    mismatches: matches ? [] : [{
      field: "content",
      requested: { length: expected.length },
      persisted: { length: typeof comment.body === "string" ? comment.body.length : 0 },
    }],
    persisted: {
      id: comment.id,
      card_id: comment.card_id,
      author: comment.author,
      body_length: typeof comment.body === "string" ? comment.body.length : 0,
      created_at: comment.created_at,
    },
  };
}

function reorderReceipt(input: KanbanToolInput, payload: unknown): Record<string, unknown> {
  const response = asRecord(payload, "Kanban API returned an invalid reorder response");
  if (!Array.isArray(response.persisted_order)) {
    throw new Error("Kanban reorder response is missing persisted_order");
  }
  const requested = input.item_ids ?? [];
  const persistedOrder = response.persisted_order.map(Number);
  const matches = comparable(requested) === comparable(persistedOrder);

  return {
    ok: matches,
    action: input.action,
    card_id: response.card_id,
    verified: { item_ids: matches },
    mismatches: matches ? [] : [{ field: "item_ids", requested, persisted: persistedOrder }],
    persisted: {
      item_ids: persistedOrder,
      checklist: response.checklist,
      checklist_items: response.checklist_items,
      updated_at: response.updated_at,
    },
  };
}

export function presentKanbanResult(
  role: KanbanRole,
  input: KanbanToolInput,
  payload: unknown,
): unknown {
  if (CARD_MUTATION_ACTIONS.has(input.action)) {
    return input.detailed === true ? payload : mutationReceipt(input, payload);
  }
  if (input.action === "create_cards") {
    return input.detailed === true ? payload : batchMutationReceipt(input, payload);
  }
  if (input.action === "reorder_checklist") {
    return input.detailed === true ? payload : reorderReceipt(input, payload);
  }
  if (LABEL_MUTATION_ACTIONS.has(input.action)) {
    return input.detailed === true ? payload : labelMutationReceipt(input, payload);
  }
  if (input.action === "create_comment") {
    return input.detailed === true ? payload : commentMutationReceipt(input, payload);
  }

  if (!CARD_READ_ACTIONS.has(input.action)) return payload;
  const detailed = input.detailed ?? role === "engineer";
  return detailed ? payload : compactReadResult(input, payload);
}
