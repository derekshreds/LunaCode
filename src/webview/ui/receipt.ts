import type { TurnReceipt } from "../protocol";

export interface ReceiptRenderOptions {
  fmtTokens(value: number): string;
  fmtCost(value: number): string;
  onLayout(): void;
}

const node = (tag: keyof HTMLElementTagNameMap, className: string, text?: string): HTMLElement => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const duration = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

/** Render a durable, grouped end-of-turn activity receipt. */
export function appendTurnReceipt(
  receipt: TurnReceipt,
  messages: HTMLElement,
  options: ReceiptRenderOptions,
) {
  const details = node("details", "turn-receipt enter") as HTMLDetailsElement;
  const elapsed = Math.max(0, receipt.endedAt - receipt.startedAt);
  const totalTokens = receipt.usage.promptTokens + receipt.usage.completionTokens;
  const cache = receipt.usage.promptTokens
    ? Math.round((receipt.usage.cachedTokens / receipt.usage.promptTokens) * 100)
    : 0;
  const changes = receipt.files.reduce((n, file) => n + file.added + file.removed, 0);
  const title = [
    receipt.failures.length ? "Turn completed with issues" : "Turn receipt",
    `${receipt.toolCalls} tools`,
    receipt.files.length ? `${receipt.files.length} files · ${changes} lines` : "no file changes",
    `${options.fmtTokens(totalTokens)} tok · ${cache}% cached`,
    receipt.usage.cost != null ? options.fmtCost(receipt.usage.cost) : "",
    receipt.schemaTokens ? `~${options.fmtTokens(receipt.schemaTokens)} schema` : "",
    duration(elapsed),
  ].filter(Boolean).join(" · ");
  details.appendChild(node("summary", "turn-receipt-summary", title));
  const body = node("div", "turn-receipt-body");

  const section = (label: string, rows: string[], tone = "") => {
    if (!rows.length) return;
    const group = node("div", `receipt-section ${tone}`.trim());
    group.appendChild(node("div", "receipt-label", label));
    for (const row of rows) group.appendChild(node("div", "receipt-row", row));
    body.appendChild(group);
  };
  section("Files changed", receipt.files.map((file) => `${file.path}  +${file.added} −${file.removed}`));
  section("Commands", receipt.commands.map((command) => `${command.ok ? "✓" : "✕"} ${command.command} — ${command.summary}`));
  section("Validation", receipt.evidence.map((evidence) => `✓ ${evidence}`));
  section("Issues", receipt.failures.map((failure) => `✕ ${failure}`), "danger");
  section("Delegation", receipt.subagents.map((report) =>
    `${report.successful}/${report.agents} agents · ${report.toolCalls} calls · ${options.fmtTokens(report.promptTokens + report.completionTokens)} tok${report.cost != null ? ` · ${options.fmtCost(report.cost)}` : ""}`
  ));
  details.appendChild(body);
  messages.appendChild(details);

  // Receipts preserve high-level evidence, so discard old low-level activity
  // nodes before they make a multi-hour session expensive to lay out.
  const toolRows = messages.querySelectorAll<HTMLElement>(".tool-item");
  for (let i = 0; i < toolRows.length - 350; i++) toolRows[i].remove();
  options.onLayout();
}
