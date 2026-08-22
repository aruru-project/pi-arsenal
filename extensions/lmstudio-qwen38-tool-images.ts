import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const IMAGE_MARKER = "Attached image(s) from tool result:";
const IMAGE_PLACEHOLDER = "[Tool returned image(s).]";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    if (
      ctx.model?.provider !== "localllm" ||
      ctx.model?.api !== "openai-responses" ||
      ctx.model?.id !== "qwen/qwen3.8-27b"
    ) {
      return undefined;
    }

    if (!isObject(event.payload) || !Array.isArray(event.payload.input)) {
      return undefined;
    }

    const hasToolImages = event.payload.input.some(
      (item) =>
        isObject(item) &&
        item.type === "function_call_output" &&
        Array.isArray(item.output) &&
        item.output.some((block) => isObject(block) && block.type === "input_image"),
    );
    if (!hasToolImages) return undefined;

    const input: unknown[] = [];
    let pendingImages: JsonObject[] = [];

    const flushImages = () => {
      if (pendingImages.length === 0) return;
      input.push({
        role: "user",
        content: [{ type: "input_text", text: IMAGE_MARKER }, ...pendingImages],
      });
      pendingImages = [];
    };

    for (const item of event.payload.input) {
      const isToolOutput = isObject(item) && item.type === "function_call_output";
      if (!isToolOutput) flushImages();

      if (isToolOutput && Array.isArray(item.output)) {
        const images = item.output.filter(
          (block): block is JsonObject => isObject(block) && block.type === "input_image",
        );
        if (images.length > 0) {
          const text = item.output
            .filter(
              (block): block is JsonObject & { text: string } =>
                isObject(block) && block.type === "input_text" && typeof block.text === "string",
            )
            .map((block) => block.text)
            .join("\n");
          input.push({ ...item, output: text || IMAGE_PLACEHOLDER });
          pendingImages.push(...images);
          continue;
        }
      }

      input.push(item);
    }
    flushImages();

    return { ...event.payload, input };
  });
}
