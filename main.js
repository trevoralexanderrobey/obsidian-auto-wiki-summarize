const { Plugin, Notice, PluginSettingTab, Setting } = require('obsidian');

class AutoWikiSummarizePlugin extends Plugin {
    async onload() {
        console.log('Auto Wiki Summarize plugin loaded');
        this.newNoteOriginContext = new Map();
        await this.loadSettings?.();
        
        // Track recently created notes to avoid duplicate processing
        this.recentlyCreatedNotes = new Set();
        
        // Listen for file creation events (new notes from wiki-links)
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (file.extension === 'md') {
                    this.handleNewNote(file);
                }
            })
        );
        
        // NEW: Listen for file rename events to catch when "Untitled" notes are renamed
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file.extension === 'md') {
                    this.handleRenamedNote(file, oldPath);
                }
            })
        );

        // Command: Define current note on-demand
        this.addCommand({
            id: 'auto-wiki-summarize-define-current',
            name: 'Define current note (Auto Wiki Summarize)',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile?.();
                if (file && file.extension === 'md') {
                    if (!checking) {
                        this.createSimpleSummary(file);
                    }
                    return true;
                }
                return false;
            }
        });

        // Settings tab
        this.addSettingTab?.(new AutoWikiSummarizeSettingTab(this.app, this));
    }
    
    async handleNewNote(file) {
        console.log(`New note created: ${file.name}`);
        
        // SKIP if the note is called "Untitled" or similar
        if (this.isUntitledNote(file.basename)) {
            console.log(`Skipping "${file.name}" - appears to be an untitled note`);
            return;
        }
        
        // Avoid processing the same note multiple times
        if (this.recentlyCreatedNotes.has(file.path)) {
            return;
        }
        
        this.recentlyCreatedNotes.add(file.path);

        // Try to capture origin context referencing this title early (from open editors/unresolved links)
        setTimeout(async () => {
            try {
                const originContexts = await this.getOriginContextForTitle?.(file.basename);
                if (originContexts && originContexts.length > 0) {
                    this.newNoteOriginContext.set(file.path, originContexts);
                }
            } catch (e) {}
        }, 200);
        
        // Remove from tracking after 10 seconds
        setTimeout(() => {
            this.recentlyCreatedNotes.delete(file.path);
        }, 10000);
        
        // Wait a moment for the file to be ready, then check if it's TRULY a new empty note
        setTimeout(() => {
            this.checkIfReallyNewAndEmpty(file);
        }, 2000); // Increased wait time
    }
    
    async handleRenamedNote(file, oldPath) {
        // Extract the old filename from the old path
        const oldName = oldPath.split('/').pop().replace('.md', '');
        const newName = file.basename;
        
        console.log(`Note renamed from "${oldName}" to "${newName}"`);
        
        // Only process if:
        // 1. The OLD name was "Untitled" or similar
        // 2. The NEW name is NOT "Untitled" or similar
        if (this.isUntitledNote(oldName) && !this.isUntitledNote(newName)) {
            console.log(`Untitled note renamed to "${newName}" - checking if it needs summarization`);
            
            // Add a small delay to ensure the rename is complete
            setTimeout(async () => {
                try {
                    const content = await this.app.vault.read(file);
                    const trimmedContent = content.trim();
                    
                    // Check if the note is empty or nearly empty
                    const isReallyEmpty = 
                        trimmedContent.length === 0 || 
                        trimmedContent === `# ${file.basename}` ||
                        trimmedContent === file.basename ||
                        trimmedContent.length < 20;
                    
                    if (isReallyEmpty) {
                        console.log(`Renamed note "${newName}" is empty - triggering auto-summarize`);
                        await this.createSimpleSummary(file);
                    } else {
                        console.log(`Renamed note "${newName}" already has content - skipping`);
                    }
                } catch (error) {
                    console.error('Error checking renamed note:', error);
                }
            }, 500);
        }
    }
    
    isUntitledNote(basename) {
        // Check if the note name is "Untitled" or a variation like "Untitled 1", "Untitled 2", etc.
        const untitledPattern = /^untitled(\s+\d+)?$/i;
        return untitledPattern.test(basename);
    }
    
    async checkIfReallyNewAndEmpty(file) {
        try {
            // Only proceed if this file was created within the last 45 seconds
            const fileStats = await this.app.vault.adapter.stat(file.path);
            const now = Date.now();
            const fileAge = now - fileStats.ctime;
            
            if (fileAge > 45000) { // More than 45 seconds old
                console.log(`Skipping ${file.name} - too old (${fileAge}ms)`);
                return;
            }
            
            const content = await this.app.vault.read(file);
            const trimmedContent = content.trim();
            
            // Skip if a summary/definition already exists
            if (/Auto-generated summary|Status:\s*Simple summary created|##\s*(Overview|Definition)/i.test(trimmedContent)) {
                console.log(`Skipping ${file.name} - auto summary already present`);
                return;
            }
            
            // Consider short templated notes as candidates too
            const isNearlyEmptyOrTemplate = 
                trimmedContent.length === 0 || 
                trimmedContent === `# ${file.basename}` ||
                trimmedContent === file.basename ||
                trimmedContent.length < 1200;
                
            if (isNearlyEmptyOrTemplate) {
                console.log(`New note appears empty or templated: ${file.name}, appending auto-summarize`);
                await this.createSimpleSummary(file);
            } else {
                console.log(`Skipping ${file.name} - substantial content detected (${trimmedContent.length} chars)`);
            }
        } catch (error) {
            console.error('Error checking note content:', error);
        }
    }
    
    async createSimpleSummary(file) {
        try {
            console.log(`Creating simple summary for: ${file.name}`);
            
            // First, make sure the file is open in the active leaf
            const leaf = this.app.workspace.activeLeaf;
            if (leaf) {
                await leaf.openFile(file);
            }
            
            // Wait a moment for the file to be fully opened
            setTimeout(async () => {
                try {
                    const noteTitle = file.basename;
                    
                    // Look for our custom "auto simple summary" prompt
                    const commands = this.app.commands.commands;
                    let autoSummaryCommand = null;
                    
                    for (const [id, command] of Object.entries(commands)) {
                        if (id.includes('copilot') && 
                            (id.toLowerCase().includes('auto-simple-summary') || 
                             id.toLowerCase().includes('auto simple summary') ||
                             command.name.toLowerCase().includes('auto simple summary'))) {
                            autoSummaryCommand = { id, command };
                            break;
                        }
                    }
                    
                    // Always read existing content so we can append instead of overwrite templates
                    const existing = await this.app.vault.read(file);
                    const definitionHeader = `\n\n## Definition\n\n`;
                    
                    // Try to fetch a real-world definition (Merriam-Webster preferred)
                    const fetched = await this.fetchDefinitionFromWeb(noteTitle);
                    if (fetched && fetched.text) {
                        const definitionBody = `${fetched.text}\n\n*Source: ${fetched.source}${fetched.url ? ` — ${fetched.url}` : ''}*`;
                        await this.appendOrReplaceDefinition(file, existing, definitionHeader, definitionBody);
                        console.log(`Appended fetched definition for ${file.name} from ${fetched.source}`);
                        // Also append contextual usage from origin note(s)
                        await this.appendInContextSection(file, noteTitle);
                        return;
                    }
                    
                    if (autoSummaryCommand) {
                        console.log(`Found auto simple summary command: ${autoSummaryCommand.id}`);
                        
                        // Append a placeholder with the note title, then select it and run the command
                        const placeholderLine = `${noteTitle}`;
                        const body = `${placeholderLine}\n\n---\n*Auto-summary generated via Copilot command*`;
                        await this.appendOrReplaceDefinition(file, existing, definitionHeader, body);
                        
                        const editor = this.app.workspace.activeLeaf.view.editor;
                        if (editor) {
                            // Select the placeholder line we just appended
                            const lastLineIndex = editor.lastLine();
                            let targetLine = lastLineIndex;
                            for (let i = lastLineIndex; i >= 0; i--) {
                                const lineText = editor.getLine(i).trim();
                                if (lineText.length > 0 && lineText !== '---' && !lineText.startsWith('*Auto-summary')) {
                                    targetLine = i;
                                    break;
                                }
                            }
                            const lineLength = editor.getLine(targetLine).length;
                            editor.setSelection({ line: targetLine, ch: 0 }, { line: targetLine, ch: lineLength });
                            console.log(`Selected text for prompt: "${placeholderLine}"`);
                            
                            setTimeout(async () => {
                                console.log(`Executing auto simple summary command for: ${noteTitle}`);
                                await this.app.commands.executeCommandById(autoSummaryCommand.id);
                                console.log(`Successfully triggered auto simple summary for ${file.name}`);
                                // After Copilot writes, try to append context
                                setTimeout(async () => {
                                    try {
                                        await this.appendInContextSection(file, noteTitle);
                                    } catch (e) {
                                        console.warn('Failed to append context after Copilot:', e);
                                    }
                                }, 1000);
                            }, 500);
                        }
                    } else {
                        console.log('Auto simple summary command not found and no definition fetched; skipping generic filler');
                        // Do not add generic content; leave the template as-is when no reliable definition found
                        // Still attempt to add contextual usage if available
                        try {
                            await this.appendInContextSection(file, noteTitle);
                        } catch (e) {
                            console.warn('Failed to append context with no definition:', e);
                        }
                    }
                } catch (error) {
                    console.error('Error creating simple summary:', error);
                }
            }, 800);
            
        } catch (error) {
            console.error('Error in createSimpleSummary:', error);
        }
    }

    // Insert or replace the Definition section
    async appendOrReplaceDefinition(file, existingContent, definitionHeader, definitionBody) {
        const definitionHeaderPattern = /^##\s+Definition\s*$/mi;
        const sectionHeaderPattern = /^##\s+.+$/m;
        let newContent;
        if (definitionHeaderPattern.test(existingContent)) {
            // Replace the existing Definition section up to the next H2 or end of file
            const lines = existingContent.split(/\n/);
            let startIndex = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].match(/^##\s+Definition\s*$/i)) {
                    startIndex = i;
                    break;
                }
            }
            if (startIndex !== -1) {
                let endIndex = lines.length;
                for (let j = startIndex + 1; j < lines.length; j++) {
                    if (lines[j].match(/^##\s+.+$/)) {
                        endIndex = j;
                        break;
                    }
                }
                const before = lines.slice(0, startIndex).join('\n');
                const after = lines.slice(endIndex).join('\n');
                const replacement = `${definitionHeader}${definitionBody}`;
                newContent = `${before}${before ? '\n' : ''}${replacement}${after ? '\n' : ''}${after}`;
            } else {
                newContent = existingContent + definitionHeader + definitionBody;
            }
        } else {
            newContent = existingContent + definitionHeader + definitionBody;
        }
        await this.app.vault.modify(file, newContent);
    }

    // Settings helpers
    async loadSettings() {
        const data = await this.loadData();
        this.settings = Object.assign({
            merriamApiKey: '',
            merriamDictionary: 'collegiate',
            maxContextSources: 2
        }, data || {});
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }

    // Append or replace an "In Context" section based on backlink origin
    async appendInContextSection(file, noteTitle) {
        try {
            const contexts = await this.findOriginContexts(file, noteTitle, 2);
            if (!contexts || contexts.length === 0) return;
            const header = `\n\n## In Context\n\n`;
            const body = contexts.map((c) => `- In [[${c.sourceBasename}]]:${c.blockquote ? `\n\n> ${c.blockquote}` : ''}`).join('\n\n');
            const existing = await this.app.vault.read(file);
            await this.appendOrReplaceSection(file, existing, /^##\s+In Context\s*$/mi, header, body);
            console.log(`Appended In Context for ${file.name} from ${contexts.length} source(s)`);
        } catch (e) {
            console.warn('appendInContextSection failed:', e);
        }
    }

    async appendOrReplaceSection(file, existingContent, headerRegex, headerText, bodyText) {
        let newContent;
        if (headerRegex.test(existingContent)) {
            const lines = existingContent.split(/\n/);
            let startIndex = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].match(headerRegex)) { startIndex = i; break; }
            }
            if (startIndex !== -1) {
                let endIndex = lines.length;
                for (let j = startIndex + 1; j < lines.length; j++) {
                    if (lines[j].match(/^##\s+.+$/)) { endIndex = j; break; }
                }
                const before = lines.slice(0, startIndex).join('\n');
                const after = lines.slice(endIndex).join('\n');
                const replacement = `${headerText}${bodyText}`;
                newContent = `${before}${before ? '\n' : ''}${replacement}${after ? '\n' : ''}${after}`;
            } else {
                newContent = existingContent + headerText + bodyText;
            }
        } else {
            newContent = existingContent + headerText + bodyText;
        }
        await this.app.vault.modify(file, newContent);
    }

    // Find source notes and snippets that referenced this new note
    async findOriginContexts(newFile, noteTitle, maxSources = 1) {
        const contexts = [];
        try {
            // Preferred: use metadataCache backlinks if available
            const backlinksApi = this.app.metadataCache.getBacklinksForFile?.(newFile);
            if (backlinksApi && backlinksApi.data) {
                for (const [sourcePath, links] of Object.entries(backlinksApi.data)) {
                    if (contexts.length >= maxSources) break;
                    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
                    if (!sourceFile || sourceFile.extension !== 'md') continue;
                    try {
                        const content = await this.app.vault.read(sourceFile);
                        const lines = content.split(/\n/);
                        // Take first link occurrence position if available
                        const pos = Array.isArray(links) && links.length > 0 ? links[0].position : null;
                        let snippet = '';
                        if (pos && typeof pos.start?.line === 'number') {
                            const start = Math.max(0, pos.start.line - 1);
                            const end = Math.min(lines.length - 1, pos.end?.line ?? pos.start.line + 1);
                            snippet = lines.slice(start, end + 1).join(' ').trim();
                        } else {
                            // Fallback: search for [[Title]] in text
                            const match = content.match(new RegExp(`\\[\\[${this.escapeRegex(noteTitle)}(\\|[^\\]]+)?\\]\\]`));
                            if (match) {
                                const idx = content.indexOf(match[0]);
                                snippet = this.extractSentenceAround(content, idx);
                            }
                        }
                        contexts.push({
                            sourcePath,
                            sourceBasename: sourceFile.basename,
                            blockquote: snippet
                        });
                    } catch {}
                }
                return contexts.slice(0, maxSources);
            }
        } catch {}

        try {
            // Fallback: use resolvedLinks to find candidate sources, then read and extract
            const resolved = this.app.metadataCache.resolvedLinks || {};
            for (const [sourcePath, targets] of Object.entries(resolved)) {
                if (contexts.length >= maxSources) break;
                if (!targets || typeof targets !== 'object') continue;
                if (!targets[newFile.path]) continue;
                const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
                if (!sourceFile || sourceFile.extension !== 'md') continue;
                try {
                    const content = await this.app.vault.read(sourceFile);
                    const match = content.match(new RegExp(`\\[\\[${this.escapeRegex(noteTitle)}(\\|[^\\]]+)?\\]\\]`));
                    let snippet = '';
                    if (match) {
                        const idx = content.indexOf(match[0]);
                        snippet = this.extractSentenceAround(content, idx);
                    }
                    contexts.push({
                        sourcePath,
                        sourceBasename: sourceFile.basename,
                        blockquote: snippet
                    });
                } catch {}
            }
        } catch {}
        return contexts.slice(0, maxSources);
    }

    escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    extractSentenceAround(text, index) {
        const start = text.lastIndexOf('\n', index - 1);
        const end = text.indexOf('\n', index);
        const para = text.slice(start + 1, end === -1 ? text.length : end);
        // Try to get the sentence that contains the index
        const sentenceMatch = para.match(/[^.!?]*[[\]()\w\W]*?[^.!?]*[.!?]/);
        if (sentenceMatch) return sentenceMatch[0].trim();
        return para.trim();
    }
    
    // Attempt to fetch a concise definition from preferred sources
    async fetchDefinitionFromWeb(term) {
        if (this.settings?.merriamApiKey) {
            try {
                const mw = await this.fetchFromMerriamWebster(term, this.settings.merriamDictionary || 'collegiate', this.settings.merriamApiKey);
                if (mw) return mw;
            } catch (e) {
                console.warn('Merriam-Webster fetch failed:', e);
                new Notice('Auto Wiki Summarize: Merriam-Webster fetch failed; check API key/plan.');
            }
        }
        try {
            const wikipedia = await this.fetchFromWikipedia(term);
            if (wikipedia) return wikipedia;
        } catch (e) {
            console.warn('Wikipedia fetch failed:', e);
        }
        try {
            const ddg = await this.fetchFromDuckDuckGo(term);
            if (ddg) return ddg;
        } catch (e) {
            console.warn('DuckDuckGo fetch failed:', e);
        }
        return null;
    }

    async fetchFromMerriamWebster(term, dictionary, apiKey) {
        const dictPath = dictionary === 'learners' ? 'learners' : 'collegiate';
        const url = `https://www.dictionaryapi.com/api/v3/references/${dictPath}/json/${encodeURIComponent(term)}?key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return null;
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        const entries = data.filter((d) => d && typeof d === 'object' && Array.isArray(d.shortdef) && d.shortdef.length > 0);
        if (entries.length === 0) return null;
        const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        const target = norm(term);
        let entry = entries.find((e) => norm(e.hwi?.hw || e.meta?.id || '') === target) || entries[0];
        const partOfSpeech = entry.fl ? `${entry.fl}. ` : '';
        const text = `${partOfSpeech}${entry.shortdef[0]}`;
        const hw = (entry.hwi?.hw || term).replace(/\*/g, '');
        const sourceUrl = `https://www.merriam-webster.com/dictionary/${encodeURIComponent(hw.replace(/\s+/g, '-'))}`;
        return { text, source: 'Merriam-Webster', url: sourceUrl };
    }
    
    async fetchFromWikipedia(term) {
        const title = encodeURIComponent(term.replace(/\s+/g, '_'));
        const urls = [
            `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`,
        ];
        for (const url of urls) {
            const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
            if (!res.ok) continue;
            const data = await res.json();
            if (data.type === 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found') continue;
            if (data.type === 'disambiguation') continue;
            const description = (data.description || '').trim();
            const extract = (data.extract || '').trim();
            let text = '';
            if (description) {
                text = this.capitalizeFirst(description.replace(/\.$/, '')) + '.';
            } else if (extract) {
                text = this.firstSentence(extract);
            }
            if (text) {
                return { text, source: 'Wikipedia', url: `https://en.wikipedia.org/wiki/${title}` };
            }
        }
        return null;
    }
    
    async fetchFromDuckDuckGo(term) {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(term)}&format=json&no_html=1&skip_disambig=1`;
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return null;
        const data = await res.json();
        const text = (data.AbstractText || '').trim();
        if (text) {
            return { text: this.firstSentence(text), source: 'DuckDuckGo', url: (data.AbstractURL || '') };
        }
        return null;
    }
    
    firstSentence(paragraph) {
        const match = paragraph.match(/^[^.!?]*[.!?]/);
        return match ? match[0].trim() : paragraph.split('\n')[0].trim();
    }
    
    capitalizeFirst(s) {
        if (!s) return s;
        return s.charAt(0).toUpperCase() + s.slice(1);
    }
    
    onunload() {
        console.log('Auto Wiki Summarize plugin unloaded');
    }
}

module.exports = AutoWikiSummarizePlugin;

class AutoWikiSummarizeSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Auto Wiki Summarize Settings' });

        new Setting(containerEl)
            .setName('Merriam-Webster API Key')
            .setDesc('Required to fetch authoritative definitions. Create a key at dictionaryapi.com')
            .addText((text) => text
                .setPlaceholder('Enter API Key')
                .setValue(this.plugin.settings?.merriamApiKey || '')
                .onChange(async (value) => {
                    this.plugin.settings.merriamApiKey = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Merriam-Webster Dictionary')
            .setDesc('Choose which dictionary to use')
            .addDropdown((dd) => dd
                .addOption('collegiate', 'Collegiate')
                .addOption('learners', 'Learner\'s')
                .setValue(this.plugin.settings?.merriamDictionary || 'collegiate')
                .onChange(async (value) => {
                    this.plugin.settings.merriamDictionary = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Max context sources')
            .setDesc('How many origin notes to include in "In Context"')
            .addSlider((slider) => slider
                .setLimits(1, 5, 1)
                .setValue(this.plugin.settings?.maxContextSources || 2)
                .onChange(async (value) => {
                    this.plugin.settings.maxContextSources = value;
                    await this.plugin.saveSettings();
                })
                .setDynamicTooltip());
    }
}