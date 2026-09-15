---
name: azure-imagegen
description: Use Azure GPT Image 2 or GPT Image 2.5 (Sunburst/Flare) to generate or edit raster images with the image_gen tool. Trigger for image generation, local reference images, image editing, logos, illustrations, product or UI mockups, transparent-background cutouts, and local image-generation usage history.
license: Apache-2.0; see LICENSE.txt
compatibility: Requires the global azure-imagegen Pi extension; chroma-key removal requires Python 3 and Pillow.
---

# Azure GPT Image 2

> **Modification notice:** This guidance is adapted from OpenAI Codex's Apache-2.0
> imagegen skill and substantially modified for Pi's `image_gen` tool, Azure's
> GPT Image v1 endpoint, local-path inputs, and model-specific transparency.
> See [NOTICE.md](NOTICE.md) and [LICENSE.txt](LICENSE.txt).

Use `image_gen` for AI-created bitmap assets. It creates one PNG per call and can
use up to five absolute local PNG, JPEG, or WebP paths. Invoke the paid external
service only when the user requested or confirmed image creation/editing.

The default model remains `gpt-image-2`. Select `gpt-image-2.5-sunburst` for
precision editing/final assets or `gpt-image-2.5-flare` for faster iteration.
Both 2.5 models support `xhigh`, `max`, and native transparent PNG backgrounds.

Default to `quality: "low"` for fast generation and prototype iteration. Increase
quality when the user requests it or you judge it necessary for the current task
(for example, final refinement or precise identity-preserving edits). An explicit
high-quality task remains high-quality even though the plugin default is low.

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
   - `model` is optional: `gpt-image-2` (default), `gpt-image-2.5-flare`, or `gpt-image-2.5-sunburst`.
   - `image_paths` is optional, absolute-only, and limited to five files.
   - `size` defaults to `auto`; use `1024x1024`, `1536x1024`, or
     `1024x1536` when a common explicit canvas is useful.
   - Maximum edge is 3840px and maximum pixel count is 8,294,400; the largest square is `2880x2880`. Dimensions must be multiples of 16. Resolutions above `2560x1440` are experimental per the API guide.
   - `quality` defaults to `low`; `low`, `medium`, and `high` work with all supported models. Increase when requested or necessary for the task. GPT Image 2.5 additionally supports `xhigh` and `max`; higher settings can take longer.
   - `background` is optional: `auto`, `opaque`, or `transparent`. Use a 2.5 model for `transparent`; omission preserves the model default.
   - Set `output_path` to a non-existing `.png` path when the destination is
     known. Otherwise the file is uniquely saved under
     `~/.pi/agent/generated-images/`.
5. Inspect the inline result. Check subject, composition, exact text,
   preservation constraints, and avoid items.
6. Iterate with one targeted change per call and restate edit invariants.
7. Report the final saved path and the final prompt. Put project-consumed assets
   inside the project rather than leaving them only in the global output folder.

## Windows and POSIX

Local Windows paths, default output saving, reference edits and the usage ledger
are supported. Output files on Windows inherit the containing directory's NTFS
permissions; POSIX output ownership/mode checks remain enabled on Linux/macOS.

Credentials may come from the existing `AZURE_IMAGE_API_KEY` environment setting
or `~/.config/alu-imagegen/env`. The file format remains a literal
`export AZURE_IMAGE_API_KEY='…'` assignment, not an executed shell script.
On Windows, the credential directory and file must have private ACLs: access for
the current user, SYSTEM and Administrators only. The plugin uses built-in
Windows PowerShell to inspect ACL metadata; it never changes those permissions.
Broad inherited permissions are rejected rather than silently accepted. On POSIX,
the existing owner and 0700/0600 checks remain unchanged.

## Usage ledger

Each API attempt appends one JSON line when it finishes to
`~/.pi/agent/imagegen-usage.jsonl`, including success, failure and cancellation.
Local validation failures that never reach the API are not counted. Records start
with calls made after this update is loaded; earlier calls are not backfilled.

Records contain UTC ISO time, elapsed milliseconds, requested model/size/quality/
background, generation/edit, reference count, status, failure stage, HTTP status,
provider request ID, token counts (including text/image breakdowns when supplied)
and the saved output path. Missing usage is `null`, not zero. Convert timestamps
to the user's timezone when counting calls by local day.

The standard ImagesResponse does not provide a billed amount and no channel rate
is configured, so this version records `cost: null`, `currency: null` and
`cost_source: "unknown"`. Do not treat failures or unknown costs as free requests.
No prompts, reference contents, Base64, raw responses or error bodies are logged.

The ledger is append-only and has no automatic expiry or rotation. It is created
with restrictive POSIX modes; on Windows it inherits the directory's NTFS ACL. If it cannot be written, the tool warns without discarding an already
created image. A forcibly killed process may not reach the final append.

## Reference preservation

For edits, say `change only X; keep Y unchanged` and name the invariants:
identity, pose, framing, proportions, typography, background, lighting, or
product label. Repeat them in every iteration. For compositing, specify which
subject moves into which base and require matching perspective, scale, light,
and shadows.

## Transparent cutouts

With GPT Image 2.5, pass `background: "transparent"` and a 2.5 `model` explicitly.
Inspect the saved PNG's alpha channel and edges; requesting transparency only
in the prompt is not a substitute for the parameter. Azure support still needs
verification on the deployed model.

For legacy GPT Image 2, use a flat chroma-key source and the bundled local helper
below. This works best for opaque subjects with clean silhouettes; hair, fur,
glass, smoke, liquids, reflections, and soft shadows may not key cleanly.

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
- ❌ Request transparency only in the prompt and assume the result has alpha.
  With GPT Image 2.5, set `background: "transparent"`; with legacy GPT Image 2,
  use the chroma-key helper. Validate alpha before delivery.
- ❌ Reuse an existing `output_path`. Both the tool and helper are intentionally
  non-overwriting; select a new versioned path unless replacement was confirmed.
