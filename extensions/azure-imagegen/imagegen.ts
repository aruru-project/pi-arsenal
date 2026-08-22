import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveAzureImageApiKey } from "./credential.ts";

export const AZURE_BASE_URL = "https://us-001.services.ai.azure.com/openai/v1/";
export const MODEL = "gpt-image-2";
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_ERROR_BYTES = 2048;
const TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_DIRECTORY = join(".pi", "agent", "generated-images");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ImageGenParams {
  prompt: string;
  image_paths?: string[];
  size?: string;
  quality?: "low" | "medium" | "high" | "auto";
  output_path?: string;
}

export interface ImageGenDetails {
  path: string;
  operation: "generation" | "edit";
  model: typeof MODEL;
  size: string;
  quality: string;
  bytes: number;
}

export interface ImageGenResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/png" }
  >;
  details: ImageGenDetails;
}

export interface ImageGenDependencies {
  fetchFn?: typeof fetch;
  apiKeyResolver?: () => Promise<string>;
  homeDirectory?: string;
  uniqueId?: () => string;
}

interface PreparedImage {
  path: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: Buffer;
}

function cleanPath(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function validateSize(raw: string | undefined): string {
  const size = raw?.trim() || "auto";
  if (size === "auto") return size;
  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) throw new Error("size must be 'auto' or WIDTHxHEIGHT");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (
    width % 16 !== 0
    || height % 16 !== 0
    || Math.max(width, height) > 3840
    || ratio > 3
    || pixels < 655_360
    || pixels > 8_294_400
  ) {
    throw new Error("size is outside GPT Image 2 dimension limits");
  }
  return `${width}x${height}`;
}

function validateParams(params: ImageGenParams): { prompt: string; paths: string[]; size: string; quality: string } {
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required");

  const paths = params.image_paths ?? [];
  if (!Array.isArray(paths) || paths.length > 5 || paths.some((path) => typeof path !== "string")) {
    throw new Error("image_paths must contain at most 5 local paths");
  }
  for (const rawPath of paths) {
    const path = cleanPath(rawPath);
    if (!isAbsolute(path)) throw new Error("every image path must be an absolute local filesystem path");
  }

  const quality = params.quality ?? "auto";
  if (!["low", "medium", "high", "auto"].includes(quality)) throw new Error("quality is invalid");
  return { prompt, paths: paths.map(cleanPath), size: validateSize(params.size), quality };
}

function detectMimeType(path: string, data: Buffer): PreparedImage["mimeType"] | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === ".png" && data.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if ((extension === ".jpg" || extension === ".jpeg") && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    extension === ".webp"
    && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  return undefined;
}

async function readInputImage(path: string): Promise<PreparedImage> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch {
    throw new Error(`invalid input image: ${path}`);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_INPUT_BYTES) {
    throw new Error(`invalid input image: ${path}`);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const after = await handle.stat();
    if (
      !after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size > MAX_INPUT_BYTES
    ) throw new Error(`invalid input image: ${path}`);
    const data = await handle.readFile();
    if (data.byteLength > MAX_INPUT_BYTES) throw new Error(`invalid input image: ${path}`);
    const mimeType = detectMimeType(path, data);
    if (!mimeType) throw new Error(`invalid input image: ${path}`);
    return { path, name: basename(path), mimeType, data };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("invalid input image:")) throw error;
    throw new Error(`invalid input image: ${path}`);
  } finally {
    await handle?.close();
  }
}

function combineSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < MAX_ERROR_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = MAX_ERROR_BYTES - bytes;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(slice, { stream: true });
      bytes += slice.byteLength;
      if (slice.byteLength < value.byteLength) break;
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

function redactAndBound(message: string, key: string): string {
  const redacted = key ? message.split(key).join("[REDACTED]") : message;
  return redacted.slice(0, MAX_ERROR_BYTES);
}

async function apiError(response: Response, key: string): Promise<Error> {
  const body = await boundedResponseText(response);
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown } };
    message = typeof parsed.error?.message === "string"
      ? parsed.error.message
      : typeof parsed.error?.code === "string" ? parsed.error.code : body;
  } catch {
    // Use the already bounded response text.
  }
  const safe = redactAndBound(message || response.statusText || "request failed", key);
  return new Error(`Azure image API error (${response.status}): ${safe}`);
}

async function ensureOutputDoesNotExist(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`output already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function writeNewFile(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`output already exists: ${path}`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function explicitOutputPath(raw: string, cwd: string): string {
  const cleaned = cleanPath(raw.trim());
  if (!cleaned) throw new Error("output_path must not be empty");
  const path = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
  if (extname(path).toLowerCase() !== ".png") throw new Error("output_path must end in .png");
  return path;
}

async function persistOutput(
  data: Buffer,
  outputPath: string | undefined,
  cwd: string,
  dependencies: ImageGenDependencies,
): Promise<string> {
  if (outputPath !== undefined) {
    const path = explicitOutputPath(outputPath, cwd);
    await writeNewFile(path, data);
    return path;
  }

  const directory = join(dependencies.homeDirectory ?? homedir(), DEFAULT_OUTPUT_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directory);
  const uid = process.getuid?.();
  if (
    uid === undefined
    || directoryStats.isSymbolicLink()
    || !directoryStats.isDirectory()
    || directoryStats.uid !== uid
    || (directoryStats.mode & 0o077) !== 0
  ) {
    throw new Error("default output directory is invalid");
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = (dependencies.uniqueId ?? randomUUID)();
    const path = join(directory, `gpt-image-2-${id}.png`);
    try {
      await writeNewFile(path, data);
      return path;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("output already exists:")) throw error;
    }
  }
  throw new Error("could not allocate a unique output filename");
}

export async function executeImageGen(
  params: ImageGenParams,
  cwd: string,
  signal: AbortSignal | undefined,
  dependencies: ImageGenDependencies = {},
): Promise<ImageGenResult> {
  const validated = validateParams(params);
  if (params.output_path !== undefined) {
    await ensureOutputDoesNotExist(explicitOutputPath(params.output_path, cwd));
  }
  if (signal?.aborted) throw new Error("image generation cancelled");

  const images = await Promise.all(validated.paths.map(readInputImage));
  const key = await (dependencies.apiKeyResolver ?? resolveAzureImageApiKey)();
  const endpoint = images.length > 0 ? "images/edits" : "images/generations";
  let body: string | FormData;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };

  if (images.length === 0) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      model: MODEL,
      prompt: validated.prompt,
      size: validated.size,
      quality: validated.quality,
      n: 1,
      output_format: "png",
    });
  } else {
    const form = new FormData();
    form.append("model", MODEL);
    form.append("prompt", validated.prompt);
    form.append("size", validated.size);
    form.append("quality", validated.quality);
    form.append("n", "1");
    form.append("output_format", "png");
    const imageField = images.length === 1 ? "image" : "image[]";
    for (const image of images) {
      form.append(imageField, new Blob([image.data], { type: image.mimeType }), image.name);
    }
    body = form;
  }

  let response: Response;
  try {
    response = await (dependencies.fetchFn ?? fetch)(`${AZURE_BASE_URL}${endpoint}`, {
      method: "POST",
      headers,
      body,
      signal: combineSignal(signal),
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("image generation cancelled");
    const message = error instanceof Error ? error.message : "request failed";
    throw new Error(`Azure image request failed: ${redactAndBound(message, key)}`);
  }

  if (!response.ok) throw await apiError(response, key);
  let payload: { data?: Array<{ b64_json?: unknown }> };
  try {
    payload = await response.json() as typeof payload;
  } catch {
    throw new Error("Azure image API returned invalid JSON");
  }
  const encoded = payload.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || !encoded) throw new Error("Azure image API returned no image");
  const image = Buffer.from(encoded, "base64");
  if (image.byteLength === 0 || !image.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Azure image API returned invalid PNG data");
  }

  const path = await persistOutput(image, params.output_path, cwd, dependencies);
  const operation = images.length > 0 ? "edit" : "generation";
  const details: ImageGenDetails = {
    path,
    operation,
    model: MODEL,
    size: validated.size,
    quality: validated.quality,
    bytes: image.byteLength,
  };
  return {
    content: [
      { type: "text", text: `Created ${operation} PNG (${validated.size}, ${validated.quality}) at ${path}` },
      { type: "image", data: image.toString("base64"), mimeType: "image/png" },
    ],
    details,
  };
}
