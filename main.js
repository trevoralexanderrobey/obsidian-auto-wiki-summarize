const { Plugin, PluginSettingTab, Setting, SuggestModal } = require('obsidian');

module.exports = class ContextualWikiDefinitions extends Plugin {
  async onload() {
    await this.loadSettings();
    this.previousFile = this.app.workspace.getActiveFile();

    this.registerEvent(
      this.app.workspace.on('file-open', async (file) => {
        const origin = this.previousFile;
        this.previousFile = file;
        if (!file || !origin) return;

        // Only process brand new empty markdown notes
        if (file.extension !== 'md') return;
        const stat = file.stat;
        if (stat && stat.size === 0) {
          const context = await this.app.vault.read(origin);
          const term = file.basename;
          const prompt = this.buildPrompt(term, context);
          const definition = await this.queryCopilot(prompt);
          if (definition) {
            await this.app.vault.modify(file, definition);
          }
        }
      })
    );

    this.addSettingTab(new ContextualDefinitionSettingTab(this.app, this));

    this.addCommand({
      id: 'regenerate-definition',
      name: 'Regenerate definition for current note',
      callback: async () => {
        await this.regenerateForCurrentNote();
      },
    });

    this.addCommand({
      id: 'pick-origin-and-regenerate',
      name: 'Pick origin note, then regenerate',
      callback: async () => {
        const target = this.app.workspace.getActiveFile();
        if (!target || target.extension !== 'md') return;

        const files = this.app.vault.getMarkdownFiles();
        const modal = new OriginNoteSuggestModal(this.app, files, async (origin) => {
          try {
            const context = await this.app.vault.read(origin);
            const term = target.basename;
            const prompt = this.buildPrompt(term, context);
            const definition = await this.queryCopilot(prompt);
            if (definition) {
              await this.app.vault.modify(target, definition);
            }
          } catch (e) {
            console.error('Failed to regenerate with picked origin', e);
          }
        });
        modal.open();
      },
    });
  }

  buildPrompt(term, context) {
    return `Role: You create precise, context-grounded definitions for a selected [[Wiki Link]] using only the originating note's context and closely related vault context the model already has. Prioritize clarity, correctness, and semantic linkage.

Instructions:
- Infer the intended meaning of the selected [[Wiki Link]] from the active note's surrounding sentences and headings.
- When multiple senses exist, pick the one best supported by the note context.
- Use concise, high-signal prose. Keep formatting clean markdown.
- Prefer [[wiki links]] for related concepts already present in the vault context.

Output strictly in this template:
## Term - The term being defined: [[${term}]]
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

Originating note context:
${context}`;
  }

  async regenerateForCurrentNote() {
    const target = this.app.workspace.getActiveFile();
    if (!target || target.extension !== 'md') return;

    const origin = (this.previousFile && this.previousFile.path !== target.path)
      ? this.previousFile
      : null;
    let context = '';
    try {
      if (origin) {
        context = await this.app.vault.read(origin);
      } else {
        // Fallback: use current note content if no distinct origin is known
        context = await this.app.vault.read(target);
      }
    } catch (_) {}

    const term = target.basename;
    const prompt = this.buildPrompt(term, context);
    const definition = await this.queryCopilot(prompt);
    if (definition) {
      await this.app.vault.modify(target, definition);
    }
  }

  async queryCopilot(prompt) {
    const licenseKey = this.settings.licenseKey;
    if (!licenseKey) return null;
    try {
      const res = await fetch('https://api.brevilabs.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${licenseKey}`,
        },
        body: JSON.stringify({
          model: 'copilot-plus-flash',
          messages: [
            { role: 'user', content: prompt }
          ]
        })
      });
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
      console.error('Copilot request failed', e);
      return null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({ licenseKey: '' }, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

class ContextualDefinitionSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Contextual Wiki Definitions Settings' });

    new Setting(containerEl)
      .setName('Copilot License Key')
      .setDesc('Believer or Plus license key used for definition generation')
      .addText(text => text
        .setPlaceholder('enter your Copilot key')
        .setValue(this.plugin.settings.licenseKey)
        .onChange(async (value) => {
          this.plugin.settings.licenseKey = value.trim();
          await this.plugin.saveSettings();
        }));
  }
}

class OriginNoteSuggestModal extends SuggestModal {
  constructor(app, files, onChoose) {
    super(app);
    this.files = files || [];
    this.onChoose = onChoose;
    this.setPlaceholder('Type to search origin note…');
  }

  getSuggestions(query) {
    const q = (query || '').toLowerCase();
    return this.files
      .filter((f) => f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .slice(0, 100);
  }

  renderSuggestion(file, el) {
    el.createEl('div', { text: file.basename });
    el.createEl('small', { text: file.path, cls: 'mod-muted' });
  }

  onChooseSuggestion(file) {
    if (typeof this.onChoose === 'function') {
      this.onChoose(file);
    }
  }
}
