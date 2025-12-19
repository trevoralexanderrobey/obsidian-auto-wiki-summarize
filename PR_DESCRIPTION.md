# Security Hardening & Bug Fixes - v1.1.8

## Summary
This PR hardens security and fixes critical bugs while preserving all existing functionality. No breaking UX changes.

## Changes by Phase

### Phase 0: Security Analysis
- Added comprehensive security analysis comment block at top of main.js
- Identified trust boundaries and risks
- Documented hardening plan

### Phase 1: Correctness Fixes
1. **Fixed previousFile nulling bug**: Only update `previousFile` for valid markdown files, preventing loss of origin context when opening non-md files or null files.
2. **Applied context truncation consistently**: `pick-origin-and-regenerate` now uses `_truncateContext()` like other code paths.
3. **Replaced window.setTimeout**: Changed to `setTimeout` for better compatibility.

### Phase 2: Security Hardening
4. **Masked license key in settings UI**:
   - License key field is now password type (masked by default)
   - Added "Reveal/Hide" toggle button
   - Key is never logged to console
5. **Output sanitization**:
   - Default: Strips ALL fenced code blocks (including dataviewjs, javascript, typescript, bash, etc.)
   - Default: Strips dangerous HTML tags (`<script>`, `<iframe>`, `<object>`, `<embed>`)
   - Settings: "Allow code blocks in output" (default OFF)
   - Settings: "Allow raw HTML in output" (default OFF)
   - Sanitization preserves template structure and required sections
6. **Output length safety limit**: Caps output at 60k chars (configurable), truncates with clear note if exceeded

### Phase 3: Networking Robustness
7. **Prefer Obsidian requestUrl()**: Uses `requestUrl()` when available (better integration, mobile support), gracefully falls back to `fetch()`.
8. **Reduced sensitive logging**: Error responses log only status + first 300 chars of body, never full body.

### Phase 4: Resilience & Idempotency
9. **Per-file in-flight lock**: Prevents double generation - if generation is already running for a file, don't start another.
10. **Safe retry logic**:
    - Retries capped at 1 attempt (prevents infinite loops)
    - `attemptCounts` cleaned up on success, failure, and errors
    - In-flight locks cleaned up in all code paths

### Phase 5: Documentation & Versioning
11. **Version bump**: manifest.json version 1.1.7 → 1.1.8
12. **README updates**:
    - Added "Privacy & Security" section documenting what data is sent to API
    - Documented output sanitization defaults and how to change them
    - Explained requestUrl/fetch behavior and mobile considerations
    - Added note about license key masking in Setup section

## Security Changes Explained

### Output Sanitization (Critical)
**Why**: Remote API responses are untrusted content. Without sanitization, malicious code blocks (especially `dataviewjs`) could execute when Obsidian renders notes, potentially accessing vault data or performing unwanted actions.

**What**: By default, all fenced code blocks and dangerous HTML tags are stripped before writing to notes. Users can opt-in to allow code blocks/HTML via settings if they trust the API.

### License Key Masking
**Why**: Prevents shoulder surfing, accidental exposure during screen sharing, and reduces risk of key leakage.

**What**: License key field is password type by default, with optional reveal toggle.

### In-Flight Locks
**Why**: Prevents race conditions where multiple generations could start for the same file, causing double insertions or conflicts.

**What**: Tracks files currently being generated, prevents concurrent generation attempts.

## Acceptance Tests (Manual Checklist)

- [ ] **Basic functionality**: Clicking a new `[[Wiki Link]]` creates a note and inserts the template exactly once (no double insertion)
- [ ] **Origin preservation**: Switching to a non-file view (graph/settings) doesn't break the next link click - origin should still be preserved
- [ ] **Large origin handling**: "Pick origin note, then regenerate" works on a very large origin note (>20k chars) without failing due to size - should truncate context appropriately
- [ ] **License key masking**: License key field is masked (password type) by default in settings
- [ ] **Reveal toggle**: "Reveal" button shows the key, "Hide" button masks it again
- [ ] **Code block sanitization**: Model output containing ` ```dataviewjs ... ``` ` is stripped by default and does NOT appear in the note
- [ ] **HTML sanitization**: Model output containing `<script>...</script>` or `<iframe>...</iframe>` is stripped by default
- [ ] **Source Context preservation**: Source Context section always contains `- From: [[Origin]]` even after sanitization
- [ ] **Output length limit**: Very long API responses (>60k chars) are truncated with a clear note
- [ ] **Settings persistence**: Sanitization settings (allow code blocks, allow HTML, max length) persist across Obsidian restarts
- [ ] **Retry behavior**: If API fails once, retry happens exactly once (not infinite retries)
- [ ] **Error logging**: Failed API calls log only status + short snippet (not full error body)

## Testing Notes

1. Test with a note containing dataviewjs code blocks in the API response - verify they're stripped
2. Test with very large origin notes (>50k chars) - verify context truncation works
3. Test rapid clicking of wiki links - verify no double insertions occur
4. Test API failure scenarios - verify retry logic and cleanup work correctly
5. Test on mobile Obsidian (if available) - verify requestUrl fallback works

## Breaking Changes
None. All changes are backward compatible. Default sanitization is more restrictive (safer), but users can opt-in to allow code blocks/HTML if needed.

## Files Changed
- `main.js` - All security fixes and bug fixes
- `manifest.json` - Version bump to 1.1.8
- `README.md` - Security documentation updates
