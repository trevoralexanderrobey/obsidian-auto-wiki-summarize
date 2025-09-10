# Contextual Wiki Definitions (Obsidian Plugin)

Automatically creates precise, context-grounded definitions when you follow a new `[[Wiki Link]]`. The plugin infers meaning from the originating note and inserts a clean Markdown definition template into the new note.

## What happens when you click a wiki link
- If the target note doesn’t exist, Obsidian creates and opens an empty note.
- This plugin detects that event, grabs the previously active note as the “origin note,” and uses its content as context.
- It asks the Copilot API (using your license) to produce a definition following a strict template.
- The returned content replaces the empty note contents (one-time insertion).

## Definition template
The model receives this exact template and must produce output that matches it:

Role: You create precise, context-grounded definitions for a selected [[Wiki Link]] using only the originating note's context and closely related vault context the model already has. Prioritize clarity, correctness, and semantic linkage.

Instructions:
- Infer the intended meaning of the selected [[Wiki Link]] from the active note's surrounding sentences and headings.
- When multiple senses exist, pick the one best supported by the note context.
- Use concise, high-signal prose. Keep formatting clean markdown.
- Prefer [[wiki links]] for related concepts already present in the vault context.

Output strictly in this template:
## Term - The term being defined: [[<resolved term title>]]
## One‑Sentence Definition
- A single, precise sentence that captures the essence in this note’s context.
## Full Definition (Context‑Aware)
- 3–5 sentences grounded in the originating note. Clarify scope, key properties, and purpose.
## Real‑World Applications
- Short bullets (3–6) showing practical uses relevant to the note’s domain.
## Related Concepts (Semantic Neighbors)
- [[Concept A]] — brief relation (how/why it connects)
- [[Concept B]] — brief relation
- [[Concept C]] — brief relation
## Illustration (Analogy or Micro‑Example)
- A vivid analogy, metaphor, or short scenario that makes the concept intuitive.
## Boundaries (What It’s Not)
- Contrast with near‑miss ideas to avoid confusion.
## Source Context (From the Note)
> Quote or paraphrase the 1–3 most relevant lines from the originating note that justify this definition.

Guidelines:
- Keep sections succinct; do not add extra sections.
- Use the note’s vocabulary; avoid introducing new jargon unless necessary.
- Maintain [[wiki links]] where useful for future graph connections.

## Setup
1) Enable community plugins in Obsidian.
2) Install/enable “Contextual Wiki Definitions”.
3) Open Settings → Contextual Wiki Definitions → paste your Copilot believer/plus license key.

## Usage
- Type a wiki link like `[[Your Term]]` in a note, then click it.
- When the empty note opens, the plugin inserts a completed definition template using the origin note as context.
- To regenerate for an existing note: Command palette → "Regenerate definition for current note". The plugin uses the previously active note as origin when available; otherwise it falls back to the current note content.
- Pick a specific origin note: Command palette → "Pick origin note, then regenerate" to choose context explicitly via a note picker.

## How it works (technical)
- Listens to `file-open` events; when an empty Markdown file opens, it treats the previously active note as the origin context.
- Sends a single prompt (with the template + origin content) to the Copilot API and writes the returned Markdown into the new note.

## Privacy
- Only the origin note content and the `[[term]]` are sent to the API.
- No other vault files are transmitted by this plugin.

## Troubleshooting
- Nothing happens: ensure the new note is empty and you clicked a freshly created wiki link.
- API errors: verify your Copilot license key in settings and that you have network access.
- Double insertion: if you undo/redo and the note becomes empty again, the plugin may re-trigger on reopen.

## License
MIT
