const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, SuggestModal, Notice } = obsidian;
// Import requestUrl safely (may not be available in all Obsidian versions)
let requestUrl;
try {
  requestUrl = obsidian.requestUrl;
} catch (_) {
  // requestUrl not available, will use fetch fallback
}

/*
 * SECURITY ANALYSIS & HARDENING PLAN
 * ===================================
 *
 * Trust Boundaries:
 * - Local vault content: TRUSTED (user's own notes)
 * - Remote API response: UNTRUSTED (could contain malicious code/scripts)
 * - Settings storage: SEMI-TRUSTED (user input, but stored locally)
 *
 * Identified Risks:
 * 1. Remote content injection: API responses written directly to notes without sanitization
 *    - Risk: dataviewjs code blocks, HTML <script> tags, executable code
 *    - Mitigation: Sanitize output before writing (strip dangerous code blocks, HTML tags)
 *
 * 2. License key exposure: Visible in plain text in settings UI
 *    - Risk: Shoulder surfing, screen sharing, accidental exposure
 *    - Mitigation: Mask input field as password type, add reveal toggle
 *
 * 3. Origin context leakage: Full note content sent to remote API
 *    - Risk: Privacy concern, but intentional for functionality
 *    - Mitigation: Document clearly in README what data is sent
 *
 * 4. Runaway retries: Retry logic could loop indefinitely
 *    - Risk: Infinite API calls, resource exhaustion
 *    - Mitigation: Cap retry attempts, clean up attemptCounts on success/failure
 *
 * 5. Origin file reset bug: previousFile gets nulled when opening non-md files or null files
 *    - Risk: Loss of origin context, broken functionality
 *    - Mitigation: Only update previousFile for valid markdown files
 *
 * Hardening Plan (Minimal UX Changes):
 * - Sanitize API output (default: strip code blocks + HTML, configurable)
 * - Mask license key in UI (password field + reveal toggle)
 * - Add output length limit (60k chars) to prevent huge writes
 * - Use Obsidian requestUrl() for better integration (fallback to fetch)
 * - Add in-flight locks to prevent double generation
 * - Fix retry cleanup and add attempt caps
 * - Reduce sensitive logging (truncate error bodies)
 */

module.exports = class ContextualWikiDefinitions extends Plugin {
  async onload() {
    await this.loadSettings();
    this.previousFile = this.app.workspace.getActiveFile();
    this._recentlyProcessed = new Set();
    this._attemptCounts = new Map();
    this._inFlightGenerations = new Set(); // Track files currently being generated

    this.registerEvent(
      this.app.workspace.on('file-open', async (file) => {
        const origin = this.previousFile;
        // SECURITY FIX: Only update previousFile for valid markdown files
        // This prevents nulling the origin when opening non-md files or null files
        if (file && file.extension === 'md') {
          this.previousFile = file;
        }
        if (!file || !origin) {
          return;
        }

        if (file.extension !== 'md') {
          return;
        }

        // SECURITY FIX: Prevent double generation with in-flight lock
        if (this._inFlightGenerations.has(file.path)) {          // #endregion
          return;
        }        this._inFlightGenerations.add(file.path);

        // Defer slightly to let other plugins (e.g., Templater) run first
        setTimeout(async () => {
          try {
            const stat = file.stat;
            const raw = await this.app.vault.read(file);
            const content = (raw || '').trim();
            const looksEmpty = !content || content.length < 10;
            const templaterError = /templater/i.test(content) && /error|abort/i.test(content);
            const alreadyPopulated = content.includes('## Term - The term being defined:');

            if (alreadyPopulated) {
              // BUG FIX: Clean up in-flight lock on early return
              this._inFlightGenerations.delete(file.path);
              return;
            }
            if (!(stat && stat.size === 0) && !looksEmpty && !templaterError) {
              // BUG FIX: Clean up in-flight lock on early return
              this._inFlightGenerations.delete(file.path);
              return;
            }
            if (this._isRecentlyProcessed(file.path)) {
              // BUG FIX: Clean up in-flight lock on early return
              this._inFlightGenerations.delete(file.path);
              return;
            }
            this._markProcessed(file.path);

            const context = await this.app.vault.read(origin);
            const term = file.basename;
            const originLink = this._computeOriginLinktext(origin, file);
            const prompt = this.buildPrompt(term, this._truncateContext(context), originLink);
            new Notice('Generating definition…');
            let definition = await this.queryCopilot(prompt);
            if (definition) {              definition = this._sanitizeOutput(definition);              definition = this._ensureSourceContextFromLine(definition, originLink);              await this.app.vault.modify(file, definition);
              this._attemptCounts.delete(file.path);              this._inFlightGenerations.delete(file.path);
              new Notice('Definition inserted.');
            } else {
              // Do not show an error yet; retry once after a short delay
              const key = file.path;
              const count = (this._attemptCounts.get(key) || 0) + 1;
              this._attemptCounts.set(key, count);
              // SECURITY FIX: Cap retries at 1 attempt to prevent infinite loops
              if (count <= 1) {
                setTimeout(async () => {
                  try {
                    const freshCtx = await this.app.vault.read(origin);
                    const retryOriginLink = this._computeOriginLinktext(origin, file);
                    const retryPrompt = this.buildPrompt(term, this._truncateContext(freshCtx), retryOriginLink);
                    let second = await this.queryCopilot(retryPrompt);
                    if (second) {
                      second = this._sanitizeOutput(second);
                      second = this._ensureSourceContextFromLine(second, retryOriginLink);
                      await this.app.vault.modify(file, second);
                      this._attemptCounts.delete(key);
                      this._inFlightGenerations.delete(file.path);
                      new Notice('Definition inserted.');
                    } else {
                      this._attemptCounts.delete(key); // Clean up on permanent failure
                      this._inFlightGenerations.delete(file.path);
                      new Notice('Definition generation failed (see console).');
                    }
                  } catch (e) {
                    console.error('Retry generation failed', e);
                    this._attemptCounts.delete(key); // Clean up on error
                    this._inFlightGenerations.delete(file.path);
                    new Notice('Definition generation failed (see console).');
                  }
                }, 1000);
              } else {
                // Fallback: insert a minimal local template so user gets the From link
                try {
                  const fallback = this._buildLocalTemplate(term, originLink, this._truncateContext(context));
                  await this.app.vault.modify(file, fallback);
                  this._attemptCounts.delete(key); // Clean up on fallback
                  this._inFlightGenerations.delete(file.path);
                  new Notice('Inserted local fallback definition (API failed).');
                } catch (e) {
                  console.error('Failed to insert fallback template', e);
                  this._attemptCounts.delete(key); // Clean up on error
                  this._inFlightGenerations.delete(file.path);
                  new Notice('Definition generation failed (see console).');
                }
              }
            }
          } catch (err) {
            console.error('Contextual Wiki Definitions: file-open handler failed', err);            this._inFlightGenerations.delete(file.path);
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
            const originLink = this._computeOriginLinktext(origin, target);
            // BUG FIX: Apply context truncation consistently (same as elsewhere)
            const prompt = this.buildPrompt(term, this._truncateContext(context), originLink);
            let definition = await this.queryCopilot(prompt);
            if (definition) {
              definition = this._sanitizeOutput(definition);
              definition = this._ensureSourceContextFromLine(definition, originLink);
              await this.app.vault.modify(target, definition);
            } else {
              try {
                const fallback = this._buildLocalTemplate(term, originLink, this._truncateContext(context));
                await this.app.vault.modify(target, fallback);
                new Notice('Inserted local fallback definition (API failed).');
              } catch (e) {
                console.error('Failed to insert fallback template (picker)', e);
              }
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
          const originLink = this._computeOriginLinktext(file, file);
          const prompt = this.buildPrompt(file.basename, this._truncateContext(ctx), originLink);
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

  buildPrompt(term, context, originLink) {
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
- From: ${originLink}
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
    const originFile = origin || target;
    const originLink = this._computeOriginLinktext(originFile, target);
    const prompt = this.buildPrompt(term, this._truncateContext(context), originLink);
    new Notice('Generating definition…');
    let definition = await this.queryCopilot(prompt);
    if (definition) {
      definition = this._sanitizeOutput(definition);
      definition = this._ensureSourceContextFromLine(definition, originLink);
      await this.app.vault.modify(target, definition);
      new Notice('Definition inserted.');
    } else {
      try {
        const fallback = this._buildLocalTemplate(term, originLink, this._truncateContext(context));
        await this.app.vault.modify(target, fallback);
        new Notice('Inserted local fallback definition (API failed).');
      } catch (e) {
        console.error('Failed to insert fallback template (regen)', e);
        new Notice('Definition generation failed (see console).');
      }
    }
  }

  _computeOriginLinktext(originFile, targetFile) {
    try {
      if (!originFile) return '[[Unknown Origin]]';
      const sourcePath = targetFile && targetFile.path ? targetFile.path : '';
      const linktext = this.app.metadataCache.fileToLinktext(originFile, sourcePath, false);
      return `[[${linktext}]]`;
    } catch (_) {
      return originFile && originFile.basename ? `[[${originFile.basename}]]` : '[[Unknown Origin]]';
    }
  }

  _ensureSourceContextFromLine(text, originLink) {
    try {
      if (!text) return text;
      const lines = text.split('\n');
      const headerIndex = lines.findIndex((l) => l.trim().toLowerCase() === '## source context (from the note)'.toLowerCase());
      if (headerIndex === -1) {
        // Append a minimal Source Context section if missing
        return `${text.trim()}\n\n## Source Context (From the Note)\n- From: ${originLink}\n`;
      }
      // Check next few lines for a "- From:" entry; insert if missing
      const insertionIndex = headerIndex + 1;
      const alreadyHasFrom = lines.slice(insertionIndex, insertionIndex + 3).some((l) => /^-\s*From\s*:/i.test(l.trim()));
      if (!alreadyHasFrom) {
        lines.splice(insertionIndex, 0, `- From: ${originLink}`);
      }
      return lines.join('\n');
    } catch (_) {
      return text;
    }
  }

  _buildLocalTemplate(term, originLink, context) {
    const safeContext = context || '';
    return `## Term - The term being defined: [[${term}]]
## One‑Sentence Definition
- <pending>
## Full Definition (Context‑Aware)
- <pending>
## Real‑World Applications
- <pending>
## Related Concepts (Semantic Neighbors)
- <pending>
## Illustration (Analogy or Micro‑Example)
- <pending>
## Boundaries (What It’s Not)
- <pending>
## Source Context (From the Note)
- From: ${originLink}
> Quote or paraphrase the 1–3 most relevant lines from the originating note that justify this definition.

Originating note context:
${safeContext}`;
  }

  /**
   * NETWORKING: HTTP request wrapper using Obsidian requestUrl with fetch fallback
   * Prefers requestUrl for better Obsidian integration, falls back to fetch if unavailable
   */
  async _makeRequest(url, options) {    // Prefer Obsidian requestUrl if available (better integration, mobile support)
    if (typeof requestUrl !== 'undefined' && requestUrl) {
      try {        // requestUrl doesn't support AbortController, so use Promise.race for timeout
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Request timeout')), 30000);
        });

        const requestPromise = requestUrl({
          url: url,
          method: options.method || 'POST',
          headers: options.headers || {},
          body: options.body || '',
          throw: false // Don't throw on non-2xx, return response object
        });

        const response = await Promise.race([requestPromise, timeoutPromise]);        // requestUrl returns { status, statusText, headers, text, json, arrayBuffer }
        // text is a string property containing the response body (or null/undefined if empty)
        // Convert to fetch-like Response object for compatibility
        let responseText = '';
        if (response) {
          if (typeof response.text === 'string') {
            responseText = response.text;
          } else if (response.text != null) {
            // Handle case where text might be a number or other type
            responseText = String(response.text);
          }
          // If response.text is null/undefined, responseText stays as ''
        }        return {
          ok: response && response.status >= 200 && response.status < 300,
          status: response?.status || 0,
          statusText: response?.statusText || '',
          headers: {
            get: (name) => {
              const headerName = name.toLowerCase();
              const headers = response?.headers || {};
              // Headers might be object or Map-like
              if (typeof headers.get === 'function') {
                return headers.get(headerName) || headers.get(name) || null;
              }
              return headers[headerName] || headers[name] || null;
            }
          },
          text: async () => {
            // BUG FIX: Ensure we never return null - always return a string
            return responseText || '';
          },
          json: async () => {
            try {
              if (response && typeof response.json === 'function') {
                return response.json();
              }
              const text = responseText || '';
              if (!text) return {};
              return JSON.parse(text);
            } catch {
              return {};
            }
          }
        };
      } catch (e) {        // Fallback to fetch if requestUrl fails or times out
        if (e.message === 'Request timeout') throw e;
        // Continue to fetch fallback on other errors
      }
    }

    // Fallback to fetch (for compatibility or if requestUrl unavailable)    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeout);
      return res;
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
  }

  async queryCopilot(prompt) {
    const licenseKey = this.settings.licenseKey;
    if (!licenseKey) return null;
    // Helper to call endpoint using our request wrapper
    const call = async ({ model, stream, accept }) => {
      try {
        const body = JSON.stringify({
          model,
          stream: !!stream,
          temperature: 0.2,
          messages: [ { role: 'user', content: prompt } ]
        });

        const res = await this._makeRequest('https://api.brevilabs.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': accept || 'application/json',
            'Authorization': `Bearer ${licenseKey}`,
          },
          body: body
        });
        return res;
      } catch (e) {
        throw e;
      }
    };

    try {
      // Attempt 1: JSON, non-stream, flash model
      let res = await call({ model: 'copilot-plus-flash', stream: false, accept: 'application/json' });
      if (!res.ok) {
        // SECURITY: Reduce sensitive logging - only log status + short snippet
        const errorText = await res.text();
        const snippet = errorText ? errorText.slice(0, 300) : '';
        console.error('Copilot non-OK response (1)', res.status, snippet + (errorText && errorText.length > 300 ? '...' : ''));
      } else {
        const ct1 = (res.headers.get('content-type') || '').toLowerCase();
        const text1 = await res.text();
        // BUG FIX: Handle null/undefined text responses
        if (!text1) {
          // Silently continue to next attempt
        } else {
          try {
            const data1 = JSON.parse(text1);
            const msg1 = data1 && data1.choices && data1.choices[0] && data1.choices[0].message;
            if (msg1 && msg1.content) return msg1.content.trim();
            // Silently continue to next attempt - don't log warnings for expected fallback behavior
          } catch (e1) {
            if (ct1.includes('text/event-stream') || (text1 && text1.startsWith('data:'))) {
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
            // Silently continue to next attempt - don't log parse errors for expected fallback behavior
          }
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
        // Silently continue to next attempt
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
        // Silently continue - only log if all attempts fail
      }

      // Only log error if ALL attempts failed
      console.warn('Copilot: All API attempts failed. Check your license key and network connection.');
      return null;
    } catch (e) {
      console.error('Copilot request failed', e);
      return null;
    }
  }

  async loadSettings() {
    const loaded = await this.loadData();    this.settings = Object.assign({
      licenseKey: '',
      allowCodeBlocks: false, // SECURITY: Default OFF - strip all code blocks
      allowRawHTML: false, // SECURITY: Default OFF - strip HTML tags
      maxOutputLength: 60000 // SECURITY: Cap output to prevent huge writes
    }, loaded);  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * SECURITY: Sanitize remote API output before writing to notes
   * Strips dangerous executable surfaces (code blocks, HTML tags) unless explicitly allowed
   */
  _sanitizeOutput(text) {
    if (!text) return text;
    let sanitized = text;
    const originalLength = text.length;
    const hadCodeBlocks = /```[\s\S]*?```/.test(text);
    const hadScriptTags = /<script[\s\S]*?<\/script>/gi.test(text);

    // SECURITY: Remove fenced code blocks (especially dataviewjs, javascript, etc.)
    if (!this.settings.allowCodeBlocks) {
      // Match code blocks with any language identifier or no identifier
      sanitized = sanitized.replace(/```[\s\S]*?```/g, '');
      // Also remove inline code that might be dangerous (conservative approach)
      // But keep inline code for now as it's less risky - only fenced blocks are executable
    }

    // SECURITY: Remove dangerous HTML tags
    if (!this.settings.allowRawHTML) {
      // Remove script, iframe, object, embed tags and their content
      sanitized = sanitized.replace(/<script[\s\S]*?<\/script>/gi, '');
      sanitized = sanitized.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
      sanitized = sanitized.replace(/<object[\s\S]*?<\/object>/gi, '');
      sanitized = sanitized.replace(/<embed[\s\S]*?>/gi, '');
      // Remove other potentially dangerous tags
      sanitized = sanitized.replace(/<style[\s\S]*?<\/style>/gi, '');
    }

    // SECURITY: Cap output length to prevent huge writes
    const maxLen = this.settings.maxOutputLength || 60000;
    const wasTruncated = sanitized.length > maxLen;
    if (sanitized.length > maxLen) {
      sanitized = sanitized.slice(0, maxLen) + '\n\n*(Output truncated for safety)*';
    }    return sanitized;
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
    this.showLicenseKey = false; // Track reveal state for license key
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Contextual Wiki Definitions Settings' });

    // SECURITY: Mask license key with password field + reveal toggle
    const licenseKeySetting = new Setting(containerEl)
      .setName('Copilot License Key')
      .setDesc('Believer or Plus license key used for definition generation');

    let licenseKeyInput;
    licenseKeySetting.addText(text => {
      licenseKeyInput = text;
      text.inputEl.type = 'password'; // SECURITY: Mask by default
      text.setPlaceholder('enter your Copilot key')
        .setValue(this.plugin.settings.licenseKey)
        .onChange(async (value) => {
          this.plugin.settings.licenseKey = value.trim();
          await this.plugin.saveSettings();
        });
    });

    // Add reveal/hide toggle button
    licenseKeySetting.addButton(button => {
      button.setButtonText(this.showLicenseKey ? 'Hide' : 'Reveal')
        .setCta(false)
        .onClick(() => {
          this.showLicenseKey = !this.showLicenseKey;
          licenseKeyInput.inputEl.type = this.showLicenseKey ? 'text' : 'password';
          button.setButtonText(this.showLicenseKey ? 'Hide' : 'Reveal');
        });
    });

    // SECURITY: Output sanitization settings
    new Setting(containerEl)
      .setName('Allow code blocks in output')
      .setDesc('If enabled, code blocks (including dataviewjs, javascript, etc.) will be preserved in generated definitions. Default: OFF for security.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.allowCodeBlocks)
        .onChange(async (value) => {
          this.plugin.settings.allowCodeBlocks = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Allow raw HTML in output')
      .setDesc('If enabled, HTML tags will be preserved in generated definitions. Default: OFF for security.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.allowRawHTML)
        .onChange(async (value) => {
          this.plugin.settings.allowRawHTML = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Maximum output length')
      .setDesc('Maximum characters allowed in generated definitions (default: 60000). Longer outputs will be truncated.')
      .addText(text => text
        .setPlaceholder('60000')
        .setValue(String(this.plugin.settings.maxOutputLength || 60000))
        .onChange(async (value) => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.maxOutputLength = num;
            await this.plugin.saveSettings();
          }
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
