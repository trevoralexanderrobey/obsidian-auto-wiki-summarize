const { Plugin, PluginSettingTab, Setting, SuggestModal, Notice } = require('obsidian');

module.exports = class ContextualWikiDefinitions extends Plugin {
  async onload() {
    await this.loadSettings();
    this.previousFile = this.app.workspace.getActiveFile();
    this._recentlyProcessed = new Set();
    this._attemptCounts = new Map();

    this.registerEvent(
      this.app.workspace.on('file-open', async (file) => {
        const origin = this.previousFile;
        this.previousFile = file;
        if (!file || !origin) return;

        if (file.extension !== 'md') return;

        // Defer slightly to let other plugins (e.g., Templater) run first
        window.setTimeout(async () => {
          try {
            const stat = file.stat;
            const raw = await this.app.vault.read(file);
            const content = (raw || '').trim();
            const looksEmpty = !content || content.length < 10;
            const templaterError = /templater/i.test(content) && /error|abort/i.test(content);
            const alreadyPopulated = content.includes('## Term - The term being defined:');

            if (alreadyPopulated) return;
            if (!(stat && stat.size === 0) && !looksEmpty && !templaterError) return;
            if (this._isRecentlyProcessed(file.path)) return;
            this._markProcessed(file.path);

            const context = await this.app.vault.read(origin);
            const term = file.basename;
            const prompt = this.buildPrompt(term, this._truncateContext(context));
            new Notice('Generating definition…');
            const definition = await this.queryCopilot(prompt);
            if (definition) {
              await this.app.vault.modify(file, definition);
              this._attemptCounts.delete(file.path);
              new Notice('Definition inserted.');
            } else {
              // Do not show an error yet; retry once after a short delay
              const key = file.path;
              const count = (this._attemptCounts.get(key) || 0) + 1;
              this._attemptCounts.set(key, count);
              if (count <= 1) {
                setTimeout(async () => {
                  try {
                    const freshCtx = await this.app.vault.read(origin);
                    const retryPrompt = this.buildPrompt(term, this._truncateContext(freshCtx));
                    const second = await this.queryCopilot(retryPrompt);
                    if (second) {
                      await this.app.vault.modify(file, second);
                      this._attemptCounts.delete(key);
                      new Notice('Definition inserted.');
                    } else {
                      new Notice('Definition generation failed (see console).');
                    }
                  } catch (e) {
                    console.error('Retry generation failed', e);
                    new Notice('Definition generation failed (see console).');
                  }
                }, 1000);
              } else {
                new Notice('Definition generation failed (see console).');
              }
            }
          } catch (err) {
            console.error('Contextual Wiki Definitions: file-open handler failed', err);
          }
        }, 300);
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

    this.addCommand({
      id: 'test-api-roundtrip-log-only',
      name: 'Test API roundtrip (log only)',
      callback: async () => {
        try {
          const file = this.app.workspace.getActiveFile();
          if (!file) { new Notice('Open a note to test.'); return; }
          const ctx = await this.app.vault.read(file);
          const prompt = this.buildPrompt(file.basename, this._truncateContext(ctx));
          new Notice('Testing API…');
          const out = await this.queryCopilot(prompt);
          console.log('[Contextual Wiki Definitions] Test output:', out);
          new Notice(out ? 'API OK — see console' : 'API failed — see console');
        } catch (err) {
          console.error('Test API failed', err);
          new Notice('Test failed (see console)');
        }
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
    const prompt = this.buildPrompt(term, this._truncateContext(context));
    new Notice('Generating definition…');
    const definition = await this.queryCopilot(prompt);
    if (definition) {
      await this.app.vault.modify(target, definition);
      new Notice('Definition inserted.');
    } else {
      new Notice('Definition generation failed (see console).');
    }
  }

  async queryCopilot(prompt) {
    const licenseKey = this.settings.licenseKey;
    if (!licenseKey) return null;
    // Helper to call endpoint
    const call = async ({ model, stream, accept }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await fetch('https://api.brevilabs.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': accept || 'application/json',
            'Authorization': `Bearer ${licenseKey}`,
          },
          body: JSON.stringify({
            model,
            stream: !!stream,
            temperature: 0.2,
            messages: [ { role: 'user', content: prompt } ]
          }),
          signal: controller.signal
        });
        clearTimeout(timeout);
        return res;
      } catch (e) {
        clearTimeout(timeout);
        throw e;
      }
    };

    try {
      // Attempt 1: JSON, non-stream, flash model
      let res = await call({ model: 'copilot-plus-flash', stream: false, accept: 'application/json' });
      if (!res.ok) {
        console.error('Copilot non-OK response (1)', res.status, await res.text());
      } else {
        const ct1 = (res.headers.get('content-type') || '').toLowerCase();
        const text1 = await res.text();
        try {
          const data1 = JSON.parse(text1);
          const msg1 = data1 && data1.choices && data1.choices[0] && data1.choices[0].message;
          if (msg1 && msg1.content) return msg1.content.trim();
          throw new TypeError('Missing choices in JSON payload');
        } catch (e1) {
          if (ct1.includes('text/event-stream') || text1.startsWith('data:')) {
            let out = '';
            for (const rawLine of text1.split('\n')) {
              const line = rawLine.trim();
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const evt = JSON.parse(payload);
                const choice = evt.choices && evt.choices[0];
                const delta = choice && (choice.delta || choice.message);
                const chunk = delta && (delta.content || '');
                if (chunk) out += chunk;
              } catch (_) {}
            }
            if (out.trim()) return out.trim();
          }
          console.warn('Copilot parse failed (1)', e1, 'Raw:', text1);
        }
      }

      // Attempt 2: SSE stream, flash model
      try {
        res = await call({ model: 'copilot-plus-flash', stream: true, accept: 'text/event-stream,*/*' });
        const text2 = await res.text();
        let out2 = '';
        for (const rawLine of text2.split('\n')) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            const choice = evt.choices && evt.choices[0];
            const delta = choice && (choice.delta || choice.message);
            const chunk = delta && (delta.content || '');
            if (chunk) out2 += chunk;
          } catch (_) {}
        }
        if (out2.trim()) return out2.trim();
      } catch (e2) {
        console.warn('Copilot SSE attempt failed (2)', e2);
      }

      // Attempt 3: JSON, non-stream, non-flash model
      try {
        res = await call({ model: 'copilot-plus', stream: false, accept: 'application/json' });
        const text3 = await res.text();
        try {
          const data3 = JSON.parse(text3);
          const msg3 = data3 && data3.choices && data3.choices[0] && data3.choices[0].message;
          if (msg3 && msg3.content) return msg3.content.trim();
        } catch (_) {}
      } catch (e3) {
        console.warn('Copilot non-flash attempt failed (3)', e3);
      }

      return null;
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
  _truncateContext(text) {
    const max = 20000; // chars
    if (!text) return '';
    return text.length > max ? text.slice(0, max) : text;
  }

  _isRecentlyProcessed(path) {
    return this._recentlyProcessed.has(path);
  }

  _markProcessed(path) {
    this._recentlyProcessed.add(path);
    setTimeout(() => this._recentlyProcessed.delete(path), 5000);
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
