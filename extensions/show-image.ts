import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Image } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

interface ShowImageDetails {
  error?: "file_not_found" | "unsupported_format";
  path: string;
  ext?: string;
  base64?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "show_image",
    label: "Show Image",
    description:
      "Display an image file in the TUI. The image will be rendered inline in " +
      "terminals that support Kitty or iTerm2 graphics protocols, or shown as a " +
      "fallback text placeholder otherwise.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path to the image file" }),
    }),
    promptSnippet: "Display an image in the conversation",

    async execute(_toolCallId, params, _signal): Promise<AgentToolResult<ShowImageDetails>> {
      const { path } = params;

      if (!existsSync(path)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${path}` }],
          details: { error: "file_not_found", path },
        };
      }

      const ext = extname(path).toLowerCase();
      const mimeType = MIME_MAP[ext];
      if (!mimeType) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unsupported image format: "${ext}". Supported: .jpg, .jpeg, .png, .gif, .webp`,
            },
          ],
          details: { error: "unsupported_format", path, ext },
        };
      }

      const data = readFileSync(path);
      const base64 = data.toString("base64");

      return {
        content: [{ type: "text" as const, text: path }],
        details: {
          base64,
          mimeType,
          path,
          sizeBytes: data.length,
        },
      };
    },

    renderResult(result, _options, theme, _context) {
      if (result.details?.error) {
        // Error case: just render the text content
        const text = result.content[0]?.type === "text" ? result.content[0].text : "Error";
        return {
          render(w) {
            return [theme.fg("error", text).slice(0, w)];
          },
          invalidate() {},
        };
      }

      const { base64, mimeType, path: imagePath } = result.details || {};
      if (!base64 || !mimeType) {
        return {
          render(w) {
            return [theme.fg("muted", "No image data").slice(0, w)];
          },
          invalidate() {},
        };
      }

      return new Image(
        base64,
        mimeType as string,
        { fallbackColor: (s: string) => theme.fg("toolOutput", s) },
        { maxWidthCells: 60, filename: imagePath as string | undefined },
      );
    },
  });
}
