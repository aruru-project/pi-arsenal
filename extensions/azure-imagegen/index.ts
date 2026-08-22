import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { executeImageGen } from "./imagegen.ts";

export default function azureImageGenExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "image_gen",
    label: "Azure GPT Image 2",
    description:
      "Generate a new PNG with Azure GPT Image 2, or edit using up to five absolute local PNG/JPEG/WebP image paths. Returns the saved path and an inline image.",
    promptSnippet: "Generate or edit PNG images with Azure GPT Image 2 and local reference files",
    promptGuidelines: [
      "Use image_gen for requested GPT Image 2 raster generation or editing; pass absolute local paths in image_paths when references or edit targets are needed.",
      "For transparency with image_gen, request a flat chroma-key background and follow the azure-imagegen skill's local removal workflow because GPT Image 2 has no native transparent output.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Detailed image generation or editing prompt." }),
      image_paths: Type.Optional(Type.Array(Type.String({
        description: "Absolute local path to a PNG, JPEG, or WebP input image.",
      }), {
        maxItems: 5,
        description: "Local reference/edit images in prompt index order (maximum 5).",
      })),
      size: Type.Optional(Type.String({
        default: "auto",
        description: "Output size: auto or GPT Image 2 WIDTHxHEIGHT dimensions.",
      })),
      quality: Type.Optional(StringEnum(["low", "medium", "high", "auto"] as const, {
        default: "auto",
        description: "Rendering quality.",
      })),
      output_path: Type.Optional(Type.String({
        description: "Destination .png path, absolute or relative to the current working directory. Must not exist.",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeImageGen(params, ctx.cwd, signal);
    },
  });
}
