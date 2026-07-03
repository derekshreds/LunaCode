// OpenAI-compatible types as accepted by the OpenRouter Chat Completions API,
// extended with the `cache_control` breakpoints OpenRouter forwards to providers
// (Anthropic / Gemini) for prompt caching.

export interface CacheControl {
  type: "ephemeral";
}

export interface TextPart {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
  cache_control?: CacheControl;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded
  };
}

export interface SystemMessage {
  role: "system";
  content: string | ContentPart[];
}

export interface UserMessage {
  role: "user";
  content: string | ContentPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string | ContentPart[];
}

export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ChatCompletionRequest {
  model: string;
  /** OpenRouter fallback routing: models tried in order. */
  models?: string[];
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  // OpenRouter passthrough — controls provider usage accounting in stream.
  usage?: { include: boolean };
  // OpenRouter provider routing preferences (e.g. { data_collection: "deny" }).
  provider?: Record<string, unknown>;
  // Per-request Zero Data Retention enforcement.
  zdr?: boolean;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  // OpenRouter / Anthropic cache accounting (present when available).
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cost?: number;
}

// Discriminated events emitted by the streaming client.
export type StreamEvent =
  | { type: "model"; id: string } // served by a fallback model
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_delta"; index: number; argsDelta: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: string | null }
  | { type: "error"; message: string };
