import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";

const CREDENTIAL_NAME = "AZURE_IMAGE_API_KEY";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_BYTES = 16 * 1024;

export class MissingAzureImageCredentialError extends Error {
  constructor() {
    super("Azure image credential is missing");
  }
}

export class InvalidAzureImageCredentialError extends Error {
  constructor() {
    super("Azure image credential is invalid");
  }
}

function invalid(): InvalidAzureImageCredentialError {
  return new InvalidAzureImageCredentialError();
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
    throw invalid();
  }
}

export function parseAzureImageCredential(raw: string): string {
  let value: string | undefined;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.includes("$(") || line.includes("`") || value !== undefined) throw invalid();
    const assignment = line.match(/^export[ \t]+([A-Z0-9_]+)[ \t]*=[ \t]*(.+)$/);
    if (!assignment || assignment[1] !== CREDENTIAL_NAME) throw invalid();

    const literal = assignment[2].trim();
    const singleQuoted = literal.match(/^'([^']*)'$/);
    const doubleQuoted = literal.match(/^"([^"\\$`]*)"$/);
    const unquoted = literal.match(/^[A-Za-z0-9_./:@%+=,-]+$/);
    if (singleQuoted) value = singleQuoted[1];
    else if (doubleQuoted) value = doubleQuoted[1];
    else if (unquoted) value = unquoted[0];
    else throw invalid();

    value = value.trim();
    if (!value) throw invalid();
  }

  if (!value) throw invalid();
  return value;
}

export interface CredentialOptions {
  credentialDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

export async function resolveAzureImageApiKey(options: CredentialOptions = {}): Promise<string> {
  const environment = options.environment ?? process.env;
  const environmentValue = environment[CREDENTIAL_NAME];
  if (environmentValue?.trim()) return environmentValue.trim();

  const directoryPath = options.credentialDirectory ?? join(homedir(), ".config", "alu-imagegen");
  const filePath = join(directoryPath, "env");
  let directoryStats: Stats;
  let fileStats: Stats;

  try {
    directoryStats = await lstat(directoryPath);
    fileStats = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new MissingAzureImageCredentialError();
    throw invalid();
  }

  assertOwnedMode(directoryStats, DIRECTORY_MODE, "directory");
  assertOwnedMode(fileStats, FILE_MODE, "file");
  if (fileStats.size > MAX_BYTES) throw invalid();

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile()
      || openedStats.dev !== fileStats.dev
      || openedStats.ino !== fileStats.ino
      || openedStats.uid !== fileStats.uid
      || (openedStats.mode & 0o777) !== FILE_MODE
      || openedStats.size > MAX_BYTES
    ) {
      throw invalid();
    }

    const raw = await handle.readFile();
    if (raw.byteLength > MAX_BYTES) throw invalid();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return parseAzureImageCredential(decoded);
  } catch (error) {
    if (error instanceof InvalidAzureImageCredentialError) throw error;
    throw invalid();
  } finally {
    await handle?.close();
  }
}
