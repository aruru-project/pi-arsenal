# Attribution and modification notice

This skill's prompting guidance and `scripts/remove_chroma_key.py` are derived
from the OpenAI Codex `imagegen` skill, distributed under the Apache License 2.0.
The upstream source was located at:

- https://github.com/openai/codex/tree/main/codex-rs/ext/image-generation
- the installed Codex imagegen skill supplied with this environment

Modifications for this distribution include:

- replaced Codex built-in/CLI execution modes with Pi's global `image_gen` tool;
- targeted Azure GPT Image 2 and absolute local filesystem image inputs;
- removed OpenAI API key, model fallback, batch, and Codex-only instructions;
- retained and documented flat chroma-key removal because GPT Image 2 does not
  expose native transparent output here;
- made the helper's dependency message environment-neutral.

See `LICENSE.txt` for the full Apache License 2.0 text.
