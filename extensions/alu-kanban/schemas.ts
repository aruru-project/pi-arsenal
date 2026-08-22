import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { KANBAN_ACTIONS, WORKFLOW_STAGE_GUIDELINE } from "./metadata.ts";

export { KANBAN_ACTIONS, KANBAN_ACTION_HELP, type KanbanAction } from "./metadata.ts";

const labelSchema = Type.Object({
  name: Type.String({ description: "Label name" }),
  color: Type.Optional(Type.String({ description: "Label color, usually a CSS hex value" })),
});

const checklistItemMutationSchema = Type.Object({
  id: Type.Optional(Type.Integer({ minimum: 1, description: "Existing item ID; omit to create" })),
  content: Type.Optional(Type.String({ description: "Required for new items; optional for existing items" })),
  completed: Type.Optional(Type.Boolean({ description: "Explicit completed state" })),
  _destroy: Type.Optional(Type.Boolean({ description: "Explicitly delete an existing item; requires confirmation" })),
}, { additionalProperties: false });

const batchCardSchema = Type.Object({
  title: Type.String(),
  description: Type.Optional(Type.String()),
  due_date: Type.Optional(Type.String()),
  assignee_id: Type.Optional(Type.Integer({ minimum: 1 })),
  labels: Type.Optional(Type.Array(labelSchema)),
  checklist_items: Type.Optional(Type.Array(checklistItemMutationSchema)),
}, { additionalProperties: false });

export const kanbanToolSchema = Type.Object({
  action: StringEnum(KANBAN_ACTIONS, { description: "Kanban operation to perform" }),
  board_id: Type.Optional(Type.Integer({ minimum: 1, description: "Board ID; trusted project defaults may supply it" })),
  list_id: Type.Optional(Type.Integer({ minimum: 1, description: "Exact list ID; mutually exclusive with list_name/workflow_stage" })),
  list_name: Type.Optional(Type.String({ description: "Unique active list name within the board; case-insensitive" })),
  workflow_stage: Type.Optional(Type.String({ description: WORKFLOW_STAGE_GUIDELINE })),
  card_id: Type.Optional(Type.Integer({ minimum: 1 })),
  attachment_id: Type.Optional(Type.Integer({ minimum: 1 })),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  old_text: Type.Optional(Type.String({ description: "Exact non-empty description fragment to replace once" })),
  new_text: Type.Optional(Type.String({ description: "Exact replacement text; may be empty" })),
  due_date: Type.Optional(Type.String()),
  clear_due_date: Type.Optional(Type.Boolean()),
  assignee_id: Type.Optional(Type.Integer({ minimum: 1, description: "Exact assignee user ID; mutually exclusive with assignee" })),
  assignee: Type.Optional(Type.String({ description: "For list_cards: 'me' or an assignee display name" })),
  clear_assignee: Type.Optional(Type.Boolean()),
  labels: Type.Optional(Type.Array(labelSchema)),
  cards: Type.Optional(Type.Array(batchCardSchema, { minItems: 1, maxItems: 50, description: "Cards created in this array order by create_cards" })),
  label_name: Type.Optional(Type.String({ description: "Canonical or custom label name for add/remove" })),
  label_color: Type.Optional(Type.String({ description: "Color for a new custom label; existing catalog color wins" })),
  content: Type.Optional(Type.String({ maxLength: 4000, description: "Append-only comment content" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Bounded comment page size" })),
  before_id: Type.Optional(Type.Integer({ minimum: 1, description: "Read comments older than this ID" })),
  checklist_items: Type.Optional(Type.Array(checklistItemMutationSchema, { description: "Batch nested checklist create/update/completion/explicit deletion for create_card or update_card" })),
  item_ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "Complete ordered checklist item IDs for reorder_checklist" })),
  completed: Type.Optional(Type.Boolean()),
  position: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based card position for move_card" })),
  query: Type.Optional(Type.String()),
  label: Type.Optional(Type.Array(Type.String())),
  overdue: Type.Optional(Type.Boolean()),
  updated_since: Type.Optional(Type.String()),
  include_completed: Type.Optional(Type.Boolean({ description: "Include completed cards; defaults to false" })),
  detailed: Type.Optional(Type.Boolean({ description: "Return raw detailed data when true, compact/persisted receipt when false" })),
  file_path: Type.Optional(Type.String()),
  output_path: Type.Optional(Type.String()),
  overwrite: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export type KanbanToolInput = Static<typeof kanbanToolSchema>;
