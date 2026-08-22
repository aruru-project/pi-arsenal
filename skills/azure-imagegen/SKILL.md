---
name: azure-imagegen
description: Use Azure GPT Image 2 / Image 2 to generate or edit raster images with the image_gen tool. Trigger for image generation, local reference images, image editing, logos, illustrations, product or UI mockups, and transparent-background cutouts.
license: Apache-2.0; see LICENSE.txt
compatibility: Requires the global azure-imagegen Pi extension; chroma-key removal requires Python 3 and Pillow.
---

# Azure GPT Image 2

> **Modification notice:** This guidance is adapted from OpenAI Codex's Apache-2.0
> imagegen skill and substantially modified for Pi's `image_gen` tool, Azure's
> GPT Image 2 v1 endpoint, local-path inputs, and chroma-key-only transparency.
> See [NOTICE.md](NOTICE.md) and [LICENSE.txt](LICENSE.txt).

Use `image_gen` for AI-created bitmap assets. It creates one PNG per call and can
use up to five absolute local PNG, JPEG, or WebP paths. Invoke the paid external
service only when the user requested or confirmed image creation/editing.

## Decide generate or edit

- **Generate:** no source is needed. Call with `prompt`; omit `image_paths`.
- **Generate from references:** pass local references and state each role in the
  prompt. The tool uses Azure's edit endpoint whenever any image is supplied.
- **Edit:** pass the image to change and state exactly what changes and what must
  remain invariant.
- Do not use this tool for remote image URLs, images only present in conversation
  history, SVG/vector source editing, or deterministic HTML/CSS/canvas output.

For every local input, use an absolute path and label it in prompt order:
`Image 1: edit target`, `Image 2: style reference`, `Image 3: compositing insert`.
Do not assume every supplied image is an edit target.

## Executable workflow

1. Determine whether the deliverable is a new raster image, reference-guided
   generation, or an edit.
2. Collect the intended use, required subject, exact text, composition, style,
   constraints, and avoid list. Ask only when a missing detail blocks success.
3. Structure the prompt in this order:

   ```text
   Asset type: <logo, illustration, mockup, photo, cutout, etc.>
   Primary request: <the user's goal>
   Input images: <Image 1: role; Image 2: role> (when used)
   Scene/backdrop: <setting>
   Subject: <main subject>
   Style/medium: <photo, illustration, 3D, etc.>
   Composition/framing: <viewpoint and placement>
   Text (verbatim): "<exact text>"
   Constraints: <must preserve and must include>
   Avoid: <unwanted elements, extra text, watermark>
   ```

   Omit irrelevant lines. Preserve a detailed user prompt rather than inventing
   extra characters, slogans, colors, or story elements.
4. Call `image_gen`:
   - `prompt` is required.
   - `image_paths` is optional, absolute-only, and limited to five files.
   - `size` defaults to `auto`; use `1024x1024`, `1536x1024`, or
     `1024x1536` when a common explicit canvas is useful.
   - `quality` defaults to `auto`; use `low` for quick drafts and `medium` or
     `high` when dense details, small text, or identity preservation matter.
   - Set `output_path` to a non-existing `.png` path when the destination is
     known. Otherwise the file is uniquely saved under
     `~/.pi/agent/generated-images/`.
5. Inspect the inline result. Check subject, composition, exact text,
   preservation constraints, and avoid items.
6. Iterate with one targeted change per call and restate edit invariants.
7. Report the final saved path and the final prompt. Put project-consumed assets
   inside the project rather than leaving them only in the global output folder.

## Reference preservation

For edits, say `change only X; keep Y unchanged` and name the invariants:
identity, pose, framing, proportions, typography, background, lighting, or
product label. Repeat them in every iteration. For compositing, specify which
subject moves into which base and require matching perspective, scale, light,
and shadows.

## Transparent cutouts: flat key plus local removal

Azure GPT Image 2 does **not** provide native transparent output. Generate a
flat chroma-key source, then use the bundled local helper. This works best for
opaque subjects with clean silhouettes; hair, fur, glass, smoke, liquids,
reflections, and soft shadows may not key cleanly.

1. Pick a key absent from the subject: normally `#00ff00`, or `#ff00ff` for a
   green subject.
2. Add this to the generation prompt:

   ```text
   Place the subject on a perfectly flat solid #00ff00 chroma-key background.
   The background must have no shadow, gradient, texture, reflection, floor
   plane, or lighting variation. Keep crisp edges and generous padding. Do not
   use #00ff00 in the subject. No cast shadow, watermark, or extra text.
   ```

3. Remove the key locally from the skill directory:

   ```bash
   python scripts/remove_chroma_key.py \
     --input /absolute/path/source.png \
     --out /absolute/path/final.png \
     --auto-key border \
     --soft-matte \
     --transparent-threshold 12 \
     --opaque-threshold 220 \
     --despill
   ```

4. Verify the output has an alpha channel, transparent corners, intact subject
   coverage, and no key-colored fringe. If a thin fringe remains, retry once
   with `--edge-contract 1`. Add `--edge-feather 0.25` only for visibly jagged
   non-reflective edges.
5. Never overwrite accidentally: the helper refuses an existing output unless
   `--force` is explicitly supplied. Use `--force` only after confirming that
   replacement is intended.

## Concrete examples

New logo exploration:

```text
Asset type: logo exploration
Primary request: a compact sleeping fox mark for a tea shop
Style/medium: simple raster mark with a strong vector-friendly silhouette
Composition/framing: centered, balanced negative space
Constraints: no text, no watermark, readable at small size
```

Reference-guided edit with `image_paths` ordered as supplied:

```text
Asset type: product mockup
Primary request: place the bottle from Image 2 into the scene in Image 1
Input images: Image 1: base scene; Image 2: product insert
Constraints: change only the inserted product; keep Image 1 framing unchanged;
match perspective and lighting; preserve the bottle label verbatim
Avoid: extra products, altered label text, watermark
```

## Anti-patterns

- ❌ Pass `https://.../reference.png` or a relative input path. The tool accepts
  only absolute local image paths; download an authorized file locally first.
- ❌ Say `make it better` for an edit. Name the single change and repeat what
  must stay unchanged, or the model may drift identity, framing, and text.
- ❌ Ask GPT Image 2 for `transparent PNG` and ship the returned opaque image.
  Request a perfectly flat key color, run `scripts/remove_chroma_key.py`, and
  validate alpha before delivery.
- ❌ Reuse an existing `output_path`. Both the tool and helper are intentionally
  non-overwriting; select a new versioned path unless replacement was confirmed.
