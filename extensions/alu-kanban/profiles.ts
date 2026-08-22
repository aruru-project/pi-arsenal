import type { KanbanRole } from "./permissions.ts";

export interface KanbanProfile {
  environment: "development" | "production";
  baseUrl: string;
  toolName: "alu_kanban_dev" | "alu_kanban";
  commandName: "alu-kanban-dev" | "alu-kanban";
  label: string;
  description: string;
  defaultActive: boolean;
  tokenEnv: Record<KanbanRole, string>;
}

export const DEVELOPMENT_PROFILE: KanbanProfile = {
  environment: "development",
  baseUrl: "http://192.168.1.195:15501/api",
  toolName: "alu_kanban_dev",
  commandName: "alu-kanban-dev",
  label: "Alu Kanban Dev",
  description: "Read and update Development Alu Kanban cards. This tool never connects to Production.",
  defaultActive: false,
  tokenEnv: {
    assistant: "ALU_KANBAN_DEV_ASSISTANT_KEY",
    engineer: "ALU_KANBAN_DEV_ENGINEER_KEY",
  },
};

export const PRODUCTION_PROFILE: KanbanProfile = {
  environment: "production",
  baseUrl: "https://home.aruru.moe/api",
  toolName: "alu_kanban",
  commandName: "alu-kanban",
  label: "Alu Kanban",
  description: "Read and update Alu Kanban cards.",
  defaultActive: true,
  tokenEnv: {
    assistant: "ALU_KANBAN_ASSISTANT_KEY",
    engineer: "ALU_KANBAN_ENGINEER_KEY",
  },
};
