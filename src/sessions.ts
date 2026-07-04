import * as vscode from "vscode";
import { ChatMessage } from "./openrouter/types";
import { AgentMode } from "./modes";
import { SessionUsage } from "./webview/protocol";

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
}

export interface StoredSession extends SessionMeta {
  mode: AgentMode;
  messages: ChatMessage[];
  usage?: SessionUsage;
  /** Per-turn file checkpoints for revert (path → before-content, null = new
   * file). Optional; large entries are trimmed before persisting. */
  checkpoints?: Array<Array<[string, string | null]>>;
}

const INDEX_KEY = "lunacode.sessions.index";
const SESSION_PREFIX = "lunacode.session.";
const MAX_SESSIONS = 100;

/**
 * Persists chat sessions in the workspace Memento so they survive reloads and
 * are scoped to the current project.
 */
export class SessionStore {
  constructor(private memento: vscode.Memento) {}

  newId(): string {
    const rand = Math.random().toString(36).slice(2, 8);
    return `s_${Date.now().toString(36)}_${rand}`;
  }

  list(): SessionMeta[] {
    const idx = this.memento.get<SessionMeta[]>(INDEX_KEY, []);
    return [...idx].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): StoredSession | undefined {
    return this.memento.get<StoredSession>(SESSION_PREFIX + id);
  }

  async save(session: StoredSession): Promise<void> {
    await this.memento.update(SESSION_PREFIX + session.id, session);
    const idx = this.memento.get<SessionMeta[]>(INDEX_KEY, []);
    const meta: SessionMeta = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      model: session.model,
    };
    const without = idx.filter((m) => m.id !== session.id);
    without.unshift(meta);
    // Trim the oldest beyond the cap.
    const trimmed = without
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
    const dropped = without.filter((m) => !trimmed.includes(m));
    for (const d of dropped) {
      await this.memento.update(SESSION_PREFIX + d.id, undefined);
    }
    await this.memento.update(INDEX_KEY, trimmed);
  }

  async delete(id: string): Promise<void> {
    await this.memento.update(SESSION_PREFIX + id, undefined);
    const idx = this.memento.get<SessionMeta[]>(INDEX_KEY, []);
    await this.memento.update(
      INDEX_KEY,
      idx.filter((m) => m.id !== id)
    );
  }
}

export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New session";
  const text =
    typeof firstUser.content === "string"
      ? firstUser.content
      : firstUser.content
          .map((p) => (p.type === "text" ? p.text : ""))
          .join(" ");
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "New session";
  return firstLine.trim().slice(0, 70);
}
