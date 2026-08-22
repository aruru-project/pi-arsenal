import { constants, type Stats } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KanbanRole } from "./permissions.ts";
import type { KanbanProfile } from "./profiles.ts";

export { DEVELOPMENT_PROFILE, PRODUCTION_PROFILE } from "./profiles.ts";

const PROJECT_CONFIG_DIR = ".pi";
const PRODUCTION_CONFIG_DIR = join(".config", "alu-kanban");
const PRODUCTION_CONFIG_FILE = "env";
const PRODUCTION_CONFIG_DIR_MODE = 0o700;
const PRODUCTION_CONFIG_FILE_MODE = 0o600;
const MAX_PRODUCTION_CONFIG_BYTES = 16 * 1024;
const PRODUCTION_TOKEN_NAMES = new Set([
  "ALU_KANBAN_ASSISTANT_KEY",
  "ALU_KANBAN_ENGINEER_KEY",
]);

export type KanbanTokenStatus = "configured" | "missing" | "invalid";

class MissingKanbanTokenError extends Error {}
class InvalidKanbanCredentialsError extends Error {}

function missingToken(): MissingKanbanTokenError {
  return new MissingKanbanTokenError("Alu Kanban token is missing");
}

function invalidCredentials(): InvalidKanbanCredentialsError {
  return new InvalidKanbanCredentialsError("Alu Kanban credentials are invalid");
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function assertOwnedMode(
  stats: Stats,
  expectedMode: number,
  kind: "directory" | "file",
): void {
  const uid = process.getuid?.();
  const correctType = kind === "directory" ? stats.isDirectory() : stats.isFile();
  if (
    uid === undefined
    || stats.isSymbolicLink()
    || !correctType
    || stats.uid !== uid
    || (stats.mode & 0o777) !== expectedMode
  ) {
    throw invalidCredentials();
  }
}

function parseProductionCredentials(raw: string): Map<string, string> {
  const credentials = new Map<string, string>();

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.includes("$(") || line.includes("`")) throw invalidCredentials();
    const assignment = line.match(/^export[ \t]+([A-Z0-9_]+)[ \t]*=[ \t]*(.+)$/);
    if (!assignment || !PRODUCTION_TOKEN_NAMES.has(assignment[1]) || credentials.has(assignment[1])) {
      throw invalidCredentials();
    }

    const literal = assignment[2].trim();
    let value: string | undefined;
    const singleQuoted = literal.match(/^'([^']*)'$/);
    const doubleQuoted = literal.match(/^"([^"\\$`]*)"$/);
    const unquoted = literal.match(/^[A-Za-z0-9_./:@%+=,-]+$/);
    if (singleQuoted) value = singleQuoted[1];
    else if (doubleQuoted) value = doubleQuoted[1];
    else if (unquoted) value = unquoted[0];

    if (!value?.trim()) throw invalidCredentials();
    credentials.set(assignment[1], value.trim());
  }

  return credentials;
}

async function readProductionCredentials(): Promise<Map<string, string> | undefined> {
  const directoryPath = join(homedir(), PRODUCTION_CONFIG_DIR);
  const filePath = join(directoryPath, PRODUCTION_CONFIG_FILE);
  let directoryStats: Stats;
  let fileStats: Stats;

  try {
    directoryStats = await lstat(directoryPath);
    fileStats = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw invalidCredentials();
  }

  assertOwnedMode(directoryStats, PRODUCTION_CONFIG_DIR_MODE, "directory");
  assertOwnedMode(fileStats, PRODUCTION_CONFIG_FILE_MODE, "file");
  if (fileStats.size > MAX_PRODUCTION_CONFIG_BYTES) throw invalidCredentials();

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile()
      || openedStats.dev !== fileStats.dev
      || openedStats.ino !== fileStats.ino
      || openedStats.uid !== fileStats.uid
      || (openedStats.mode & 0o777) !== PRODUCTION_CONFIG_FILE_MODE
      || openedStats.size > MAX_PRODUCTION_CONFIG_BYTES
    ) {
      throw invalidCredentials();
    }
    const raw = await handle.readFile();
    if (raw.byteLength > MAX_PRODUCTION_CONFIG_BYTES) throw invalidCredentials();
    return parseProductionCredentials(raw.toString("utf8"));
  } catch (error) {
    if (error instanceof InvalidKanbanCredentialsError) throw error;
    throw invalidCredentials();
  } finally {
    await handle?.close();
  }
}

export interface WorkflowStageConfig {
  listName: string;
}

export interface ResolvedKanbanConfig {
  role: KanbanRole;
  trusted: boolean;
  defaultBoardId?: number;
  workflow: Record<string, WorkflowStageConfig>;
  createStage?: string;
  allowedBoardIds?: number[];
  error?: string;
}

function engineerConfig(trusted: boolean, error?: string): ResolvedKanbanConfig {
  return { role: "engineer", trusted, workflow: {}, error };
}

function positiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function parseProjectConfig(raw: string): ResolvedKanbanConfig {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config must be an object");

  const role: KanbanRole = parsed.role === "assistant" ? "assistant" : "engineer";
  const defaults = parsed.defaults;
  const defaultsRecord = defaults && typeof defaults === "object" && !Array.isArray(defaults)
    ? defaults as Record<string, unknown>
    : {};
  const defaultBoardId = positiveInteger(defaultsRecord.board_id, "defaults.board_id");

  const workflow: Record<string, WorkflowStageConfig> = {};
  const rawWorkflow = defaultsRecord.workflow;
  if (rawWorkflow !== undefined) {
    if (!rawWorkflow || typeof rawWorkflow !== "object" || Array.isArray(rawWorkflow)) {
      throw new Error("defaults.workflow must be an object");
    }
    for (const [rawStage, value] of Object.entries(rawWorkflow as Record<string, unknown>)) {
      const stage = rawStage.trim().toLowerCase();
      if (!stage || !value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("each workflow stage must be an object");
      }
      const listName = (value as Record<string, unknown>).list_name;
      if (typeof listName !== "string" || !listName.trim()) {
        throw new Error(`workflow stage '${stage}' requires list_name`);
      }
      workflow[stage] = { listName: listName.trim() };
    }
  }

  const createStage = typeof defaultsRecord.create_stage === "string"
    ? defaultsRecord.create_stage.trim().toLowerCase()
    : undefined;
  if (createStage && !workflow[createStage]) {
    throw new Error("defaults.create_stage must reference a configured workflow stage");
  }

  const guardrails = parsed.guardrails;
  const guardrailRecord = guardrails && typeof guardrails === "object" && !Array.isArray(guardrails)
    ? guardrails as Record<string, unknown>
    : {};
  let allowedBoardIds: number[] | undefined;
  if (guardrailRecord.allowed_board_ids !== undefined) {
    if (!Array.isArray(guardrailRecord.allowed_board_ids)) {
      throw new Error("guardrails.allowed_board_ids must be an array");
    }
    allowedBoardIds = [...new Set(guardrailRecord.allowed_board_ids.map((value) => {
      const id = positiveInteger(value, "guardrails.allowed_board_ids[]");
      if (!id) throw new Error("guardrails.allowed_board_ids[] is required");
      return id;
    }))];
  }

  if (role === "assistant") {
    if (!allowedBoardIds || allowedBoardIds.length === 0) {
      throw new Error("assistant role requires at least one guardrails.allowed_board_ids entry");
    }
    if (defaultBoardId && !allowedBoardIds.includes(defaultBoardId)) {
      throw new Error("defaults.board_id must be included in guardrails.allowed_board_ids");
    }
  }

  return {
    role,
    trusted: true,
    defaultBoardId,
    workflow,
    createStage,
    allowedBoardIds,
  };
}

export async function resolveKanbanConfig(cwd: string, projectTrusted: boolean): Promise<ResolvedKanbanConfig> {
  if (!projectTrusted) return engineerConfig(false);

  try {
    const raw = await readFile(join(cwd, PROJECT_CONFIG_DIR, "alu-kanban.json"), "utf8");
    return parseProjectConfig(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return engineerConfig(true);
    return engineerConfig(true, error instanceof Error ? error.message : "invalid project config");
  }
}

export async function resolveRole(cwd: string, projectTrusted: boolean): Promise<KanbanRole> {
  return (await resolveKanbanConfig(cwd, projectTrusted)).role;
}

export async function tokenFor(profile: KanbanProfile, role: KanbanRole, cwd: string): Promise<string> {
  const envName = profile.tokenEnv[role];
  const environmentToken = process.env[envName]?.trim();
  if (environmentToken) return environmentToken;

  // The project-local development extension may read its ignored Rails `.env`
  // so `/reload` is enough after creating dev accounts. Production never reads
  // project dotenv files.
  if (profile.environment === "development") {
    try {
      const dotenv = await readFile(join(cwd, ".env"), "utf8");
      const line = dotenv.split(/\r?\n/).find((entry) => entry.startsWith(`${envName}=`));
      const value = line?.slice(envName.length + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
      if (value) return value;
    } catch {
      // Fall through to the bounded configuration error below.
    }
  } else {
    const credentials = await readProductionCredentials();
    const fileToken = credentials?.get(envName)?.trim();
    if (fileToken) return fileToken;
  }

  throw missingToken();
}

export async function tokenStatus(
  profile: KanbanProfile,
  role: KanbanRole,
  cwd: string,
): Promise<KanbanTokenStatus> {
  try {
    await tokenFor(profile, role, cwd);
    return "configured";
  } catch (error) {
    if (error instanceof MissingKanbanTokenError) return "missing";
    return "invalid";
  }
}
