import type { KanbanClient } from "./client.ts";
import type { ResolvedKanbanConfig } from "./config.ts";
import type { KanbanRole } from "./permissions.ts";
import type { KanbanAction, KanbanToolInput } from "./schemas.ts";

interface ListRecord {
  id: number;
  name: string;
  archived: boolean;
}

export interface PreparedKanbanAction {
  input: KanbanToolInput;
  assigneeName?: string;
}

export interface WorkflowPreparationContext {
  statusCommand?: string;
}

export interface WorkflowStatusItem {
  stage: string;
  configuredName: string;
  listId?: number;
  actualName?: string;
  error?: string;
}

const DEFAULT_BOARD_ACTIONS = new Set<KanbanAction>([
  "get_board",
  "summary",
  "list_lists",
  "list_labels",
  "list_cards",
  "my_tasks",
  "create_card",
  "create_cards",
]);

const REQUIRED_BOARD_ACTIONS = new Set<KanbanAction>([
  "get_board",
  "summary",
  "list_lists",
  "list_labels",
  "create_card",
  "create_cards",
]);

const ASSISTANT_SCOPED_READ_ACTIONS = new Set<KanbanAction>([
  "list_cards",
  "my_tasks",
]);

const LIST_SELECTOR_ACTIONS = new Set<KanbanAction>([
  "list_cards",
  "create_card",
  "create_cards",
  "move_card",
]);

const CARD_ACTIONS = new Set<KanbanAction>([
  "get_card",
  "update_card",
  "edit_card_description",
  "delete_card",
  "move_card",
  "set_card_completed",
  "get_checklist",
  "reorder_checklist",
  "add_card_label",
  "remove_card_label",
  "list_comments",
  "create_comment",
  "list_attachments",
  "upload_attachment",
  "download_attachment",
  "delete_attachment",
]);

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function listsFromPayload(payload: unknown): ListRecord[] {
  const record = asRecord(payload, "Kanban API returned an invalid lists response");
  if (!Array.isArray(record.lists)) throw new Error("Kanban API returned an invalid lists response");

  return record.lists.map((value) => {
    const list = asRecord(value, "Kanban API returned an invalid list");
    const id = Number(list.id);
    if (!Number.isInteger(id) || id <= 0 || typeof list.name !== "string") {
      throw new Error("Kanban API returned an invalid list");
    }
    return { id, name: list.name, archived: list.archived === true };
  });
}

function activeListByName(lists: ListRecord[], name: string): ListRecord {
  const normalized = normalizeName(name);
  const matches = lists.filter((list) => !list.archived && normalizeName(list.name) === normalized);
  if (matches.length === 0) throw new Error(`No active Kanban list named '${name}' was found`);
  if (matches.length > 1) throw new Error(`Multiple active Kanban lists are named '${name}'`);
  return matches[0];
}

function assertAssistantGuardrailConfig(role: KanbanRole, config: ResolvedKanbanConfig): void {
  if (role !== "assistant") return;
  if (!config.allowedBoardIds || config.allowedBoardIds.length === 0) {
    throw new Error("Assistant Kanban actions require at least one configured allowed_board_ids guardrail");
  }
}

function assertAllowedBoard(role: KanbanRole, config: ResolvedKanbanConfig, boardId: number): void {
  if (role !== "assistant") return;
  assertAssistantGuardrailConfig(role, config);
  if (!config.allowedBoardIds?.includes(boardId)) {
    throw new Error(`Board ${boardId} is outside the assistant allowed_board_ids guardrail`);
  }
}

async function cardBoardId(client: KanbanClient, cardId: number, signal?: AbortSignal): Promise<number> {
  const card = asRecord(
    await client.json("GET", `/cards/${cardId}`, undefined, signal),
    "Kanban API returned an invalid card",
  );
  const boardId = Number(card.board_id);
  if (!Number.isInteger(boardId) || boardId <= 0) throw new Error("Card response is missing board_id");
  return boardId;
}

function selectorCount(input: KanbanToolInput): number {
  return [input.list_id !== undefined, Boolean(input.list_name?.trim()), Boolean(input.workflow_stage?.trim())]
    .filter(Boolean).length;
}

function configState(config: ResolvedKanbanConfig): string {
  const stages = Object.keys(config.workflow);
  return `Current project defaults: board=${config.defaultBoardId ?? "none"}; workflow_stages=${stages.length > 0 ? stages.join(",") : "none"}; create_stage=${config.createStage ?? "none"}.`;
}

function statusHint(context: WorkflowPreparationContext): string {
  return context.statusCommand
    ? `inspect ${context.statusCommand}`
    : "inspect the active Alu Kanban profile status command";
}

function selectorRecovery(
  config: ResolvedKanbanConfig,
  context: WorkflowPreparationContext,
): string {
  return `${configState(config)} workflow_stage is only available for names mapped in trusted .pi/alu-kanban.json. Pass board_id with list_name/list_id, or configure project defaults and ${statusHint(context)}.`;
}

function boardRecovery(
  config: ResolvedKanbanConfig,
  context: WorkflowPreparationContext,
  needsList: boolean,
): string {
  const explicit = needsList
    ? "Pass board_id with list_name/list_id"
    : "Pass board_id for this action";
  return `${configState(config)} ${explicit}, or configure project defaults and ${statusHint(context)}.`;
}

export async function prepareKanbanAction(
  client: KanbanClient,
  original: KanbanToolInput,
  role: KanbanRole,
  config: ResolvedKanbanConfig,
  signal?: AbortSignal,
  context: WorkflowPreparationContext = {},
): Promise<PreparedKanbanAction> {
  const input: KanbanToolInput = { ...original };
  assertAssistantGuardrailConfig(role, config);

  if (!LIST_SELECTOR_ACTIONS.has(input.action) && (input.list_name || input.workflow_stage)) {
    throw new Error(`list_name/workflow_stage are not supported by ${input.action}`);
  }
  if (selectorCount(input) > 1) {
    throw new Error("list_id, list_name, and workflow_stage are mutually exclusive");
  }

  if (DEFAULT_BOARD_ACTIONS.has(input.action) && input.board_id === undefined && config.defaultBoardId) {
    input.board_id = config.defaultBoardId;
  }
  if (role === "assistant" && ASSISTANT_SCOPED_READ_ACTIONS.has(input.action) && input.board_id === undefined) {
    if (config.allowedBoardIds?.length === 1) {
      input.board_id = config.allowedBoardIds[0];
    } else {
      throw new Error(`Action '${input.action}' requires explicit board_id when multiple assistant allowed_board_ids are configured (${config.allowedBoardIds?.join(",")}). ${statusHint(context)}.`);
    }
  }
  if ((input.action === "create_card" || input.action === "create_cards") && selectorCount(input) === 0 && config.createStage) {
    input.workflow_stage = config.createStage;
  }

  if (input.workflow_stage?.trim()) {
    const stage = input.workflow_stage.trim().toLowerCase();
    const configured = config.workflow[stage];
    if (!configured) {
      throw new Error(`Workflow stage '${stage}' is not configured. ${selectorRecovery(config, context)}`);
    }
    input.list_name = configured.listName;
    input.workflow_stage = stage;
  }

  let resolvedCardBoardId: number | undefined;
  if (input.card_id && CARD_ACTIONS.has(input.action) && role === "assistant" && config.allowedBoardIds !== undefined) {
    resolvedCardBoardId = await cardBoardId(client, input.card_id, signal);
    if (input.board_id !== undefined && input.board_id !== resolvedCardBoardId) {
      throw new Error(`Card ${input.card_id} does not belong to board ${input.board_id}`);
    }
    input.board_id ??= resolvedCardBoardId;
  }

  if (input.board_id !== undefined) assertAllowedBoard(role, config, input.board_id);
  if (REQUIRED_BOARD_ACTIONS.has(input.action) && input.board_id === undefined) {
    const needsList = input.action === "create_card" || input.action === "create_cards";
    throw new Error(`Action '${input.action}' requires board_id, but no configured default board is available. ${boardRecovery(config, context, needsList)}`);
  }

  const creating = input.action === "create_card" || input.action === "create_cards";
  if (creating && input.list_id === undefined && !input.list_name?.trim()) {
    throw new Error(`Action '${input.action}' requires list_id, list_name, or a configured create_stage. ${selectorRecovery(config, context)}`);
  }
  if (input.action === "create_card" && role === "engineer" && !input.description?.trim()) {
    throw new Error("Engineer-created cards require a description with discovery context and separate-scheduling rationale");
  }
  if (input.action === "create_cards" && role === "engineer" && input.cards?.some((card) => !card.description?.trim())) {
    throw new Error("Engineer-created cards require a description with discovery context and separate-scheduling rationale");
  }

  if (input.list_name?.trim()) {
    let boardId = input.board_id ?? resolvedCardBoardId;
    if (!boardId && input.card_id) boardId = await cardBoardId(client, input.card_id, signal);
    if (!boardId) {
      throw new Error(`list_name/workflow_stage requires board_id or a configured default board. ${selectorRecovery(config, context)}`);
    }
    assertAllowedBoard(role, config, boardId);
    input.board_id ??= boardId;
    const payload = await client.json("GET", `/boards/${boardId}/lists`, undefined, signal);
    input.list_id = activeListByName(listsFromPayload(payload), input.list_name).id;
  }

  if (creating && input.list_id === undefined) {
    throw new Error(`Action '${input.action}' could not resolve an active list. ${selectorRecovery(config, context)}`);
  }

  let assigneeName: string | undefined;
  if (input.assignee !== undefined) {
    if (input.action !== "list_cards") throw new Error("assignee is only supported by list_cards");
    if (input.assignee_id !== undefined) throw new Error("assignee and assignee_id are mutually exclusive");
    const assignee = input.assignee.trim();
    if (!assignee) throw new Error("assignee cannot be empty");
    if (assignee.toLowerCase() === "me") {
      const me = asRecord(await client.json("GET", "/me", undefined, signal), "Kanban API returned an invalid user");
      const id = Number(me.id);
      if (!Number.isInteger(id) || id <= 0) throw new Error("Current user response is missing id");
      input.assignee_id = id;
    } else {
      assigneeName = assignee;
    }
  }

  return { input, assigneeName };
}

export function filterAllowedBoards(
  payload: unknown,
  role: KanbanRole,
  config: ResolvedKanbanConfig,
): unknown {
  if (role !== "assistant" || config.allowedBoardIds === undefined) return payload;
  const record = asRecord(payload, "Kanban API returned an invalid boards response");
  if (!Array.isArray(record.boards)) return payload;
  const boards = record.boards.filter((board) => {
    if (!board || typeof board !== "object") return false;
    return config.allowedBoardIds?.includes(Number((board as Record<string, unknown>).id));
  });
  return { ...record, boards };
}

export function filterCardsByAssigneeName(payload: unknown, assigneeName?: string): unknown {
  if (!assigneeName) return payload;
  const record = asRecord(payload, "Kanban API returned an invalid cards response");
  if (!Array.isArray(record.cards)) return payload;
  const expected = normalizeName(assigneeName);
  const cards = record.cards.filter((card) => {
    if (!card || typeof card !== "object") return false;
    const name = (card as Record<string, unknown>).assignee_name;
    return typeof name === "string" && normalizeName(name) === expected;
  });
  return { ...record, cards, total: cards.length };
}

export async function resolveWorkflowStatus(
  client: KanbanClient,
  config: ResolvedKanbanConfig,
  signal?: AbortSignal,
): Promise<WorkflowStatusItem[]> {
  if (!config.defaultBoardId || Object.keys(config.workflow).length === 0) return [];
  const payload = await client.json("GET", `/boards/${config.defaultBoardId}/lists`, undefined, signal);
  const lists = listsFromPayload(payload);

  return Object.entries(config.workflow).map(([stage, workflow]) => {
    try {
      const list = activeListByName(lists, workflow.listName);
      return { stage, configuredName: workflow.listName, listId: list.id, actualName: list.name };
    } catch (error) {
      return {
        stage,
        configuredName: workflow.listName,
        error: error instanceof Error ? error.message : "resolution failed",
      };
    }
  });
}
