import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { TextDecoder, promisify } from "node:util";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import https from "node:https";
import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const endpoint = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests";
const maxAudioBytes = 100 * 1024 * 1024;
const requestIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
class MusicError extends Error {}

const CREDENTIAL_NAME = "GMI_API_KEY";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_BYTES = 16 * 1024;

export class MissingMusicCredentialError extends MusicError {
  constructor() {
    super("Set GMI_API_KEY or fill ~/.config/alu-musicgen/env before using music_gen.");
  }
}

export class InvalidMusicCredentialError extends MusicError {
  constructor() {
    super("Invalid music credential; use a literal GMI_API_KEY export in ~/.config/alu-musicgen/env (private Windows ACL, or POSIX owned directory 0700 and file 0600).");
  }
}

function invalid(): InvalidMusicCredentialError {
  return new InvalidMusicCredentialError();
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function assertOwnedMode(
  stats: Awaited<ReturnType<typeof lstat>>,
  expectedMode: number,
  kind: "directory" | "file",
): void {
  const uid = process.getuid?.();
  const correctType = kind === "directory" ? stats.isDirectory() : stats.isFile();
  if (
    stats.isSymbolicLink()
    || !correctType
    || (process.platform !== "win32" && (
      uid === undefined || stats.uid !== uid || (stats.mode & 0o777) !== expectedMode
    ))
  ) {
    throw invalid();
  }
}

const runFile = promisify(execFile);

// Inspect Windows ACL metadata only; mode/uid are not POSIX permissions on Windows.
async function assertPrivateWindowsAcl(paths: string[]): Promise<void> {
  const encodedPaths = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$paths = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPaths}')))
$sidType = [Security.Principal.SecurityIdentifier]
$allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($path in $paths) {
  $acl = Get-Acl -LiteralPath $path
  if ($allowed -notcontains $acl.GetOwner($sidType).Value) { throw 'unsafe owner' }
  $rules = $acl.GetAccessRules($true, $true, $sidType)
  if ($rules.Count -eq 0) { throw 'missing access rules' }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        $allowed -notcontains $rule.IdentityReference.Value) { throw 'broad access' }
  }
}
[Console]::Write('ok')
`;
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await runFile(powershell, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], { timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true });
  if (stdout.trim() !== "ok") throw invalid();
}

export function parseMusicCredential(raw: string): string {
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

  if (!value || /[\r\n]/.test(value)) throw invalid();
  return value;
}

export interface CredentialOptions {
  credentialDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

export async function resolveMusicApiKey(options: CredentialOptions = {}): Promise<string> {
  const environment = options.environment ?? process.env;
  const environmentValue = environment[CREDENTIAL_NAME];
  if (environmentValue?.trim()) {
    const key = environmentValue.trim();
    if (/[\r\n]/.test(key)) throw invalid();
    return key;
  }

  const directoryPath = options.credentialDirectory ?? join(homedir(), ".config", "alu-musicgen");
  const filePath = join(directoryPath, "env");
  let directoryStats: Awaited<ReturnType<typeof lstat>>;
  let fileStats: Awaited<ReturnType<typeof lstat>>;

  try {
    directoryStats = await lstat(directoryPath);
    fileStats = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new MissingMusicCredentialError();
    throw invalid();
  }

  assertOwnedMode(directoryStats, DIRECTORY_MODE, "directory");
  assertOwnedMode(fileStats, FILE_MODE, "file");
  if (fileStats.size > MAX_BYTES) throw invalid();
  if (process.platform === "win32") {
    try { await assertPrivateWindowsAcl([directoryPath, filePath]); }
    catch { throw invalid(); }
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile()
      || openedStats.dev !== fileStats.dev
      || openedStats.ino !== fileStats.ino
      || openedStats.uid !== fileStats.uid
      || (process.platform !== "win32" && (openedStats.mode & 0o777) !== FILE_MODE)
      || openedStats.size > MAX_BYTES
    ) {
      throw invalid();
    }

    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw invalid();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    return parseMusicCredential(decoded);
  } catch (error) {
    if (error instanceof InvalidMusicCredentialError) throw error;
    throw invalid();
  } finally {
    await handle?.close();
  }
}

// Check DNS inside the connection's lookup, rather than validating then resolving again.
const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(ip, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
blocked.addSubnet("3fff::", 20, "ipv6");
function publicIP(ip: string): boolean {
  const family = isIP(ip);
  return family === 4 ? !blocked.check(ip, "ipv4")
    : family === 6 && globalV6.check(ip, "ipv6") && !blocked.check(ip, "ipv6");
}
function audioURL(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new MusicError("Invalid audio URL."); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443") || !host.includes(".") ||
      (isIP(host) && !publicIP(host))) {
    throw new MusicError("Unsafe audio URL refused.");
  }
  return url;
}

async function api(method: "GET" | "POST", url: string, key: string, signal: AbortSignal, body?: unknown) {
  signal.throwIfAborted();
  const response = await fetch(url, {
    method, signal, redirect: "error",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new MusicError(`GMI request failed (HTTP ${response.status}).`);
  }
  if (!response.body) throw new MusicError("GMI returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new MusicError("GMI response exceeded 1 MiB.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new MusicError("GMI returned an invalid response."); }
}

function findAudio(data: any): string | undefined {
  const outcome = data.outcome;
  if (typeof outcome?.audio_url === "string" && outcome.audio_url) return outcome.audio_url;
  for (const list of [outcome?.medias, outcome?.media_urls, data.medias, data.media_urls]) {
    if (!Array.isArray(list)) continue;
    for (const media of list) {
      if (typeof media === "string" && media) return media;
      if (media && (!media.type || media.type === "audio") && typeof media.url === "string" && media.url) return media.url;
    }
  }
}

async function download(raw: string, signal: AbortSignal, outputDir: string): Promise<string> {
  const url = audioURL(raw);
  signal.throwIfAborted();
  await mkdir(outputDir, { recursive: true });
  const path = resolve(outputDir, `music-${Date.now()}-${randomUUID()}.mp3`);
  const partial = `${path}.part`;
  const file = await open(partial, "wx", 0o600);
  try {
    await new Promise<void>((resolveDownload, reject) => {
      // No bearer header, cookies, redirects, or pooled connections on media requests.
      const request = https.get(url, {
        signal, agent: false,
        lookup(hostname, options, callback) {
          dns.lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error, [] as any);
            if (!addresses.length || addresses.some(({ address }) => !publicIP(address))) {
              return callback(new MusicError("Non-public audio host refused."), [] as any);
            }
            if (typeof options === "object" && options.all) callback(null, addresses as any);
            else callback(null, addresses[0].address, addresses[0].family);
          });
        },
      }, async (response) => {
        try {
          if (response.statusCode !== 200) throw new MusicError(`Audio download failed (HTTP ${response.statusCode ?? 0}); redirects are not followed.`);
          if (Number(response.headers["content-length"]) > maxAudioBytes) throw new MusicError("Audio exceeds 100 MiB.");
          const type = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
          if (type && !type.startsWith("audio/") && type !== "application/octet-stream") throw new MusicError("Audio download returned an unexpected content type.");
          let size = 0;
          for await (const chunk of response) {
            signal.throwIfAborted();
            size += chunk.length;
            if (size > maxAudioBytes) throw new MusicError("Audio exceeds 100 MiB.");
            await file.writeFile(chunk);
          }
          if (!size) throw new MusicError("Audio download was empty.");
          resolveDownload();
        } catch (error) { response.destroy(); reject(error); }
      });
      request.on("error", reject);
    });
    signal.throwIfAborted();
    await file.close();
    await rename(partial, path);
    return path;
  } catch (error) {
    await file.close().catch(() => {});
    await rm(partial, { force: true });
    throw error;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "music_gen",
    label: "生成音乐",
    description: "Generate music from prompt and lyrics using GMI, or retrieve an existing request. Returns a local MP3 path and request ID. Generation is paid.",
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ maxLength: 2000 })),
      lyrics: Type.Optional(Type.String({ minLength: 1, maxLength: 3500 })),
      request_id: Type.Optional(Type.String({ pattern: requestIdPattern.source })),
    }, { additionalProperties: false, oneOf: [
      { required: ["prompt", "lyrics"], not: { required: ["request_id"] } },
      { required: ["request_id"], not: { anyOf: [{ required: ["prompt"] }, { required: ["lyrics"] }] } },
    ] }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let requestId: string | undefined;
      let submitted = false;
      const deadline = AbortSignal.timeout(240_000);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        combined.throwIfAborted();
        if ("request_id" in params) {
          if (typeof params.request_id !== "string" || !requestIdPattern.test(params.request_id) || "lyrics" in params || "prompt" in params) throw new MusicError("Provide request_id alone to retrieve an existing request.");
          requestId = params.request_id;
        } else if (typeof params.lyrics !== "string" || !params.lyrics.trim() || [...params.lyrics].length > 3500 ||
                   typeof params.prompt !== "string" || [...params.prompt].length > 2000) {
          throw new MusicError("Supply lyrics (1–3500 characters) and prompt (0–2000 characters).");
        }
        const key = await resolveMusicApiKey();
        let data: any;
        if (requestId) {
          data = await api("GET", `${endpoint}/${requestId}`, key, combined);
        } else {
          combined.throwIfAborted();
          submitted = true;
          data = await api("POST", endpoint, key, combined, {
            model: "minimax-music-3.0",
            payload: { lyrics: params.lyrics, prompt: params.prompt, sample_rate: 44100, bitrate: 256000, format: "mp3" },
          });
          if (typeof data.request_id !== "string" || !requestIdPattern.test(data.request_id)) throw new MusicError("GMI did not return a valid request ID.");
          requestId = data.request_id;
          onUpdate?.({ content: [{ type: "text", text: `Request ID: ${requestId}` }], details: { request_id: requestId } });
        }
        for (let attempt = 0; attempt <= 40; attempt++) {
          combined.throwIfAborted();
          if (["failed", "error", "cancelled", "canceled"].includes(String(data.status).toLowerCase())) throw new MusicError("GMI music generation failed.");
          const url = findAudio(data);
          if (url) {
            const path = await download(url, combined, resolve(ctx.cwd, "test/gmi-music"));
            return { content: [{ type: "text", text: `Audio: ${path}\nRequest ID: ${requestId}` }], details: { path, request_id: requestId } };
          }
          if (attempt === 40) throw new MusicError("Audio is not available yet.");
          // First retrieval is immediate, including a synchronous success without an outcome.
          if (attempt > 0) await sleep(3000, undefined, { signal: combined });
          data = await api("GET", `${endpoint}/${requestId}`, key, combined);
        }
        throw new MusicError("Audio is not available yet.");
      } catch (error) {
        const message = combined.aborted ? (signal?.aborted ? "Music request cancelled." : "Music request timed out (240 seconds).")
          : error instanceof MusicError ? error.message : "Music request failed (network or local file error).";
        const recovery = requestId ? ` Request ID: ${requestId}. Retrieve with music_gen({request_id: "${requestId}"}); do not resubmit.`
          : submitted ? " Submission may have been accepted, but no request ID was received. Check the GMI console before any new submission; POST was not retried." : "";
        throw new Error(message + recovery);
      }
    },
  });
}
