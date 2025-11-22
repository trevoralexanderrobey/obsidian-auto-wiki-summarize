function ensureSourceContextFromLine(text, originLink) {
  try {
    if (!text) return text;
    const lines = text.split('\n');
    const headerIndex = lines.findIndex((l) => l.trim().toLowerCase() === '## source context (from the note)'.toLowerCase());
    if (headerIndex === -1) {
      return `${text.trim()}\n\n## Source Context (From the Note)\n- From: ${originLink}\n`;
    }
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

function buildPrompt(term, context, originLink) {
  return `## Term - The term being defined: [[${term}]]\n## Source Context (From the Note)\n> Quote or paraphrase...\n\nOriginating note context:\n${context}`;
}

// Simulate outputs that might be missing the From line
const origin = '[[Origin Note]]';
const base = buildPrompt('Sample', 'Context lines here', origin);
const injected = ensureSourceContextFromLine(base, origin);
console.log('--- injected ---');
console.log(injected);
console.log('Has From line:', /\n- From: \[\[/.test(injected));


