import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { executeImageGen, MODEL, MODELS } from "./imagegen.ts";

export default function azureImageGenExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "image_gen",
    label: "Azure GPT Image",
    description:
      "Generate or edit a PNG with Azure GPT Image 2 or GPT Image 2.5 (Sunburst/Flare), using up to five absolute local PNG/JPEG/WebP references. Defaults to low quality for fast iteration; increase when the user requests it or the task warrants higher fidelity. Returns the saved path and an inline image.",
    promptSnippet: "Generate or edit PNG images with Azure GPT Image models and local references",
    promptGuidelines: [
      "Use image_gen for requested raster generation or editing; pass absolute local paths in image_paths when references or edit targets are needed.",
      "Default to quality: low for fast generation and prototyping. Increase quality when the user requests it or you judge it necessary for the task, such as final refinement or precise identity-preserving edits.",
      "Select gpt-image-2.5-sunburst for precision editing or gpt-image-2.5-flare for faster iteration. GPT Image 2.5 also supports xhigh and max quality.",
      "For native transparent PNGs, select a GPT Image 2.5 model and background: transparent. For GPT Image 2, use the skill's chroma-key removal workflow instead.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Detailed image generation or editing prompt." }),
      model: Type.Optional(StringEnum(MODELS, {
        default: MODEL,
        description: "Image model/deployment. Sunburst prioritizes precision; Flare prioritizes speed. Defaults to GPT Image 2.",
      })),
      image_paths: Type.Optional(Type.Array(Type.String({
        description: "Absolute local path to a PNG, JPEG, or WebP input image.",
      }), {
        maxItems: 5,
        description: "Local reference/edit images in prompt index order (maximum 5).",
      })),
      size: Type.Optional(Type.String({
        default: "auto",
        description: "Output size: auto or WIDTHxHEIGHT. Maximum 8,294,400 pixels; maximum square 2880x2880.",
      })),
      quality: Type.Optional(StringEnum(["low", "medium", "high", "xhigh", "max", "auto"] as const, {
        default: "low",
        description: "Rendering quality. Default low; increase when requested by the user or needed for the task. xhigh and max require GPT Image 2.5.",
      })),
      background: Type.Optional(StringEnum(["auto", "opaque", "transparent"] as const, {
        description: "Output background. Native transparency requires GPT Image 2.5. Omit to keep the model default.",
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
