import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { executeKanbanAction } from "./actions.ts";
import { KanbanClient } from "./client.ts";
import { resolveKanbanConfig, tokenFor, tokenStatus } from "./config.ts";
import { formatKanbanHelp, formatKanbanStatus } from "./help.ts";
import { assertActionAllowed, requiresDestructiveConfirmation } from "./permissions.ts";
import { presentKanbanResult } from "./presenter.ts";
import type { KanbanProfile } from "./profiles.ts";
import { kanbanToolSchema } from "./schemas.ts";
import {
  KANBAN_PROMPT_GUIDELINES,
  KANBAN_SKILL_PATH,
  shouldExposeKanbanSkill,
} from "./skill.ts";
import {
  filterAllowedBoards,
  filterCardsByAssigneeName,
  prepareKanbanAction,
  resolveWorkflowStatus,
  type WorkflowStatusItem,
} from "./workflow.ts";

export function createKanbanExtension(profile: KanbanProfile) {
  return function kanbanExtension(pi: ExtensionAPI) {
    const setToolActive = (active: boolean) => {
      const current = pi.getActiveTools();
      if (active) {
        pi.setActiveTools([...new Set([...current, profile.toolName])]);
      } else {
        pi.setActiveTools(current.filter((name) => name !== profile.toolName));
      }
    };

    const updateStatus = async (ctx: ExtensionContext, active: boolean) => {
      if (!active) {
        ctx.ui.setStatus(profile.commandName, undefined);
        return;
      }
      const config = await resolveKanbanConfig(ctx.cwd, ctx.isProjectTrusted());
      ctx.ui.setStatus(profile.commandName, config.role.toUpperCase());
    };

    pi.registerTool({
      name: profile.toolName,
      label: profile.label,
      description: profile.description,
      promptSnippet: profile.environment === "development"
        ? "Read or update cards in the alubot_admin development Kanban"
        : "Read or update Alu Kanban cards",
      promptGuidelines: [...KANBAN_PROMPT_GUIDELINES],
      parameters: kanbanToolSchema,

      async execute(_toolCallId, originalInput, signal, _onUpdate, ctx) {
        const config = await resolveKanbanConfig(ctx.cwd, ctx.isProjectTrusted());
        const role = config.role;
        assertActionAllowed(role, originalInput.action);

        if (requiresDestructiveConfirmation(originalInput)) {
          if (!ctx.hasUI) throw new Error(`${originalInput.action} requires interactive confirmation`);
          const nestedChecklistDeletion = originalInput.checklist_items?.some((item) => item._destroy === true) === true;
          const confirmed = await ctx.ui.confirm(
            "Confirm Kanban deletion",
            nestedChecklistDeletion
              ? `Delete the explicitly marked checklist item(s) via update_card in the ${profile.environment} Kanban?`
              : `Run ${originalInput.action} in the ${profile.environment} Kanban?`,
          );
          if (!confirmed) throw new Error("Kanban deletion cancelled");
        }

        const client = new KanbanClient({
          baseUrl: profile.baseUrl,
          token: await tokenFor(profile, role, ctx.cwd),
        });
        const prepared = await prepareKanbanAction(client, originalInput, role, config, signal, {
          statusCommand: `/${profile.commandName} status`,
        });
        let data = await executeKanbanAction(
          client,
          prepared.input,
          ctx.cwd,
          signal,
          { withFileMutationQueue },
        );
        if (prepared.input.action === "list_boards") data = filterAllowedBoards(data, role, config);
        if (prepared.input.action === "list_cards") {
          data = filterCardsByAssigneeName(data, prepared.assigneeName);
        }
        data = presentKanbanResult(role, prepared.input, data);

        const serialized = JSON.stringify(data, null, 2);
        const truncated = truncateHead(serialized, {
          maxBytes: DEFAULT_MAX_BYTES,
          maxLines: DEFAULT_MAX_LINES,
        });
        let text = truncated.content;
        if (truncated.truncated) text += "\n\n[Kanban result truncated]";

        return {
          content: [{ type: "text", text }],
          details: {
            action: prepared.input.action,
            environment: profile.environment,
            role,
            default_board_id: config.defaultBoardId,
            workflow_stages: Object.keys(config.workflow),
            create_stage: config.createStage,
            config_error: config.error,
            status_command: `/${profile.commandName} status`,
          },
        };
      },
    });

    pi.on("resources_discover", () => {
      const registeredToolNames = pi.getAllTools().map((tool) => tool.name);
      if (!shouldExposeKanbanSkill(profile, registeredToolNames)) return;
      return { skillPaths: [KANBAN_SKILL_PATH] };
    });

    pi.on("session_start", async (_event, ctx) => {
      setToolActive(profile.defaultActive);
      await updateStatus(ctx, profile.defaultActive);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      ctx.ui.setStatus(profile.commandName, undefined);
    });

    pi.registerCommand(profile.commandName, {
      description: `Enable, disable, inspect, or explain the ${profile.environment} Kanban tool`,
      getArgumentCompletions: (prefix) => {
        const values = ["enable", "disable", "status", "help"];
        const items = values
          .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
          .map((value) => ({ value, label: value }));
        return items.length > 0 ? items : null;
      },
      handler: async (args, ctx) => {
        const action = args.trim().toLowerCase() || "status";
        const config = await resolveKanbanConfig(ctx.cwd, ctx.isProjectTrusted());
        if (action === "help") {
          ctx.ui.notify(formatKanbanHelp(config.role, config), "info");
          return;
        }
        if (action === "enable") setToolActive(true);
        else if (action === "disable") setToolActive(false);
        else if (action !== "status") {
          ctx.ui.notify(`Usage: /${profile.commandName} enable|disable|status|help`, "warning");
          return;
        }

        const active = pi.getActiveTools().includes(profile.toolName);
        await updateStatus(ctx, active);
        const currentTokenStatus = await tokenStatus(profile, config.role, ctx.cwd);
        let workflowStatus: WorkflowStatusItem[] = [];
        if (currentTokenStatus === "configured" && config.defaultBoardId && Object.keys(config.workflow).length > 0) {
          try {
            const client = new KanbanClient({
              baseUrl: profile.baseUrl,
              token: await tokenFor(profile, config.role, ctx.cwd),
            });
            workflowStatus = await resolveWorkflowStatus(client, config);
          } catch (error) {
            workflowStatus = [{
              stage: "workflow",
              configuredName: "validation",
              error: error instanceof Error ? error.message : "validation failed",
            }];
          }
        }
        const message = formatKanbanStatus(config.role, active, currentTokenStatus, config, workflowStatus);
        ctx.ui.notify(message, currentTokenStatus === "configured" && !config.error ? "info" : "warning");
      },
    });
  };
}
