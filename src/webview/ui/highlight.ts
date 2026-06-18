// Per-line syntax highlighting for the diff view, backed by highlight.js.
// We only highlight when the language is known (derived from the file's
// extension) — highlightAuto per line is slow and unreliable, so we fall back
// to escaped plain text otherwise.
import hljs from "highlight.js/lib/common";

export function highlightLine(text: string, language?: string): string {
  if (!text) return "";
  if (language && hljs.getLanguage(language)) {
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(text);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"
  );
}
