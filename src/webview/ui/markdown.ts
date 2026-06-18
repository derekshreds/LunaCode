// Markdown rendering for chat output, backed by `marked` (GFM: tables, lists,
// fenced code, headings, hr, etc.). The webview CSP forbids scripts and inline
// handlers, so marked's HTML output renders safely without an extra sanitizer.
import { marked } from "marked";

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function renderMarkdown(src: string): string {
  try {
    return marked.parse(src, { async: false }) as string;
  } catch {
    // Fall back to escaped plain text if parsing ever throws mid-stream.
    return escapeHtml(src);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"
  );
}
