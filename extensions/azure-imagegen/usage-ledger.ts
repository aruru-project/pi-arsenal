import { constants } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

interface TokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  input_text_tokens: number | null;
  input_image_tokens: number | null;
  output_text_tokens: number | null;
  output_image_tokens: number | null;
}

export interface ImageGenLedgerEntry extends TokenUsage {
  timestamp: string;
  duration_ms: number;
  model: string;
  operation: "generation" | "edit";
  size: string;
  quality: string;
  background: string | null;
  reference_count: number;
  status: "success" | "failed" | "cancelled";
  error_stage: "request" | "response" | "output" | null;
  http_status: number | null;
  request_id: string | null;
  output_path: string | null;
  // ImagesResponse has no documented billed amount; no channel rate is configured.
  cost: null;
  currency: null;
  cost_source: "unknown";
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Only allowlisted numeric usage fields enter the ledger, never the raw response.
// Contract: https://developers.openai.com/api/reference/resources/images
export function readTokenUsage(payload?: unknown): TokenUsage {
  const usage = object(object(payload).usage);
  const input = object(usage.input_tokens_details);
  const output = object(usage.output_tokens_details);
  return {
    input_tokens: tokenCount(usage.input_tokens),
    output_tokens: tokenCount(usage.output_tokens),
    total_tokens: tokenCount(usage.total_tokens),
    input_text_tokens: tokenCount(input.text_tokens),
    input_image_tokens: tokenCount(input.image_tokens),
    output_text_tokens: tokenCount(output.text_tokens),
    output_image_tokens: tokenCount(output.image_tokens),
  };
}

export function usageLedgerPath(home: string): string {
  return join(home, ".pi", "agent", "imagegen-usage.jsonl");
}

export async function appendUsageEntry(path: string, entry: ImageGenLedgerEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(entry)}\n`, {
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    mode: 0o600,
  });
}
