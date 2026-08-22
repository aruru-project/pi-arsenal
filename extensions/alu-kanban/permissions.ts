import type { KanbanAction } from "./metadata.ts";

export type KanbanRole = "assistant" | "engineer";

const ENGINEER_ACTIONS = new Set<KanbanAction>([
  "list_boards",
  "get_board",
  "summary",
  "list_lists",
  "list_labels",
  "list_cards",
  "get_card",
  "my_tasks",
  "create_card",
  "create_cards",
  "update_card",
  "edit_card_description",
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

const ASSISTANT_ONLY_ACTIONS = new Set<KanbanAction>([
  "delete_card",
]);

export const DESTRUCTIVE_ACTIONS = new Set<KanbanAction>([
  "delete_card",
  "delete_attachment",
]);

interface DestructiveInput {
  action: KanbanAction;
  checklist_items?: Array<{ _destroy?: boolean; [key: string]: unknown }>;
}

export function requiresDestructiveConfirmation(input: DestructiveInput): boolean {
  return DESTRUCTIVE_ACTIONS.has(input.action) ||
    input.checklist_items?.some((item) => item._destroy === true) === true;
}

export function actionAllowed(role: KanbanRole, action: KanbanAction): boolean {
  return ENGINEER_ACTIONS.has(action) || (role === "assistant" && ASSISTANT_ONLY_ACTIONS.has(action));
}

export function assertActionAllowed(role: KanbanRole, action: KanbanAction): void {
  if (!actionAllowed(role, action)) {
    throw new Error(`Kanban action '${action}' is not allowed for role '${role}'`);
  }
}
