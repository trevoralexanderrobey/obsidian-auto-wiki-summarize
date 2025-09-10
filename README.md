# Contextual Wiki Definitions

This Obsidian plugin automatically populates new notes created from wiki links with a context-aware definition template. When you click a wiki link to a note that does not yet exist, the plugin:

1. Detects the origin note and captures its content.
2. Sends the wiki-linked term and origin context to the Copilot API.
3. Inserts the returned definition template into the newly created note.

## Setup
- Provide your Copilot believer or plus license key in the plugin settings.
- Enable the plugin in Obsidian.

## How it works
- When a new note is opened and it is empty, the plugin uses the previously active note as context.
- It requests a definition following a strict template and writes the result into the new note.

## Privacy
Only the origin note content and the wiki-linked term are sent to the Copilot API.

## License
MIT
