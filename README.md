# Luna Code — AI Coding Agent for VS Code

Luna Code is a Claude Code-style **agentic coding assistant** that runs entirely on
[OpenRouter](https://openrouter.ai). Point it at any model OpenRouter supports
with **just an API key and a model id** — no other configuration required.

It's built for fast codebase navigation, efficient agentic sessions, and
**prompt-cache hit optimization** so long sessions stay cheap and fast.

![Luna Code](media/icon.png)

## Features

- **One-line setup.** Paste an OpenRouter API key, pick a model, go.
- **Three modes**
  - **Standard** — approve each file edit and shell command before it runs.
  - **Auto** — runs edits and commands autonomously without prompting (commands
    in `lunacode.alwaysDenyCommands` are still hard-blocked).
  - **Plan** — read-only research + planning. The agent investigates the code and
    proposes a concrete plan, but can't edit files or run mutating commands.
- **Session history.** Every conversation is saved per-workspace. Click the
  history button in the header to browse, reload, or delete prior sessions.
- **Usage & cost analytics.** A live meter shows **session-total cost** plus the
  last turn's tokens and cache-hit rate. The usage window (bar-chart button)
  reports spend and tokens over the last **30 / 60 / 90 days**, with a daily cost
  chart, daily token chart, and a per-model cost/usage breakdown.
- **Refined "thinking" UX.** While the model reasons, an animated **Thinking…**
  indicator sits just above the composer; when it finishes it collapses to a
  quiet **"Thought for Ns"** marker — no noisy, expandable reasoning blocks.
- **Agentic tool loop.** Reads files, lists/globs/greps the workspace, runs
  builds & tests, checks language-server diagnostics, and edits code — looping
  until the task is done.
- **Cache-hit optimized.** A stable system-prompt prefix plus rolling
  `cache_control` breakpoints maximize provider prompt caching (Anthropic /
  Gemini via OpenRouter; automatic for OpenAI). The composer shows a live
  **cache hit %** and token/cost meter.
- **Context management.** Automatically compacts older tool output and turns to
  stay within a configurable token budget.
- **Modern UI.** A clean neutral-dark interface with purple accents, streaming
  responses, collapsible reasoning, tool cards, and inline diff approvals.
- **Open anywhere.** Use Luna Code in the Activity Bar sidebar or pop it out into an
  **editor tab** (button in the panel title bar). To dock it on the right like
  Claude Code, drag the Luna Code icon into the **Secondary Side Bar** — VS Code
  remembers the placement. All surfaces share one live session.
- **Private by default.** Every request sends OpenRouter `provider.data_collection: "deny"`,
  so traffic is only routed to providers that do **not** store or train on your
  prompts. An optional stricter Zero-Data-Retention (ZDR) mode is available.
- **Secure.** Your API key is stored in VS Code's encrypted `SecretStorage`,
  never in settings or files.

## Getting started

1. Build the extension:
   ```
   npm install
   npm run compile
   ```
2. Press <kbd>F5</kbd> in VS Code to launch the **Extension Development Host**.
3. Click the **Luna Code** icon in the Activity Bar.
4. Click **Set OpenRouter API Key** and paste your key (`sk-or-v1-…`).
5. Click the model chip in the header to pick a model (or browse all OpenRouter
   models).
6. Type a request and hit **Enter**.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + Shift + L` | Focus the Luna Code chat |
| `Ctrl/Cmd + Shift + K` | Add the current editor selection to chat |

## Configuration

All settings live under the `lunacode.*` namespace (Settings → Extensions → Luna Code):

| Setting | Default | Description |
| --- | --- | --- |
| `lunacode.model` | `deepseek/deepseek-v4-flash` | OpenRouter model id (use the picker / Browse all for current ids). |
| `lunacode.baseUrl` | `https://openrouter.ai/api/v1` | API base URL (override for proxies). |
| `lunacode.defaultMode` | `standard` | `standard` \| `auto` \| `plan`. |
| `lunacode.maxTokens` | `0` | Max tokens per turn. `0` = use the model's full output limit (avoids truncating large `write_file` calls). |
| `lunacode.temperature` | `0` | Sampling temperature. |
| `lunacode.enablePromptCaching` | `true` | Insert `cache_control` breakpoints. |
| `lunacode.dataCollection` | `deny` | `deny` routes only to providers that don't store/train on prompts; `allow` permits all. |
| `lunacode.zeroDataRetention` | `false` | Stricter: only route to Zero-Data-Retention endpoints. |
| `lunacode.maxContextTokens` | `180000` | Budget before older context is compacted. |
| `lunacode.autoApproveCommands` | common read-only cmds | Auto-approved even in Standard mode. |
| `lunacode.alwaysDenyCommands` | destructive cmds | Always blocked, any mode. |

## Tools the agent can use

| Tool | Mutating | Purpose |
| --- | --- | --- |
| `read_file` | no | Read a file (with paging). |
| `list_dir` | no | List a directory. |
| `glob` | no | Find files by glob pattern. |
| `grep` | no | Regex search across the workspace. |
| `get_diagnostics` | no | Read language-server errors/warnings. |
| `write_file` | yes | Create/overwrite a file. |
| `edit_file` | yes | Exact-string targeted edit. |
| `run_command` | yes | Run a shell command (PowerShell on Windows, sh elsewhere). |

Mutating tools are hidden entirely in **Plan** mode and gated by approval in
**Standard** mode.

## How cache optimization works

OpenRouter forwards `cache_control` breakpoints to providers that support prompt
caching. Luna Code:

1. Keeps the **system prompt + tool definitions** byte-stable across a session
   and marks the end of the system prompt as a cache breakpoint.
2. Places a **rolling breakpoint** on the latest message each request so the
   entire accumulated conversation becomes a cached prefix for the next call.
3. Only ever **appends** to the message list, never reorders, so prefixes stay
   valid for cache reuse.

For OpenAI models, caching is automatic and these hints are safely ignored.

## Project structure

```
src/
  extension.ts            activation + commands
  config.ts               settings + SecretStorage for the API key
  modes.ts                Standard / Auto / Plan definitions
  openrouter/
    client.ts             streaming Chat Completions client
    types.ts              message + cache_control types
  agent/
    agent.ts              the agentic tool loop
    systemPrompt.ts       system prompt (stable cache prefix)
    contextManager.ts     cache breakpoints + context compaction
    tools/                read/write/edit/list/glob/grep/run/diagnostics
  webview/
    provider.ts           webview host + approval bridge
    protocol.ts           host <-> webview message types
    ui/                   the webview front-end (main.ts, markdown.ts)
media/
  webview.css             the dark-purple theme
```

## License

MIT
