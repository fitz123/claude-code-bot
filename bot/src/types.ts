// Core types for the Minime bot

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AgentConfig {
  id: string;
  workspaceCwd: string;
  model: string;
  fallbackModel?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  maxTurns?: number;
  effort?: "low" | "medium" | "high";
}

export interface TopicOverride {
  topicId: number;
  agentId?: string;
  requireMention?: boolean;
}

export interface TelegramBinding {
  chatId: number;
  agentId: string;
  kind: "dm" | "group";
  topicId?: number;
  label?: string;
  requireMention?: boolean;
  topics?: TopicOverride[];
  voiceTranscriptEcho?: boolean;
  streamingUpdates?: boolean;
  typingIndicator?: boolean;
}

export interface DiscordChannelOverride {
  channelId: string;
  agentId?: string;
  label?: string;
  requireMention?: boolean;
  streamingUpdates?: boolean;
  typingIndicator?: boolean;
}

export interface DiscordBinding {
  channelId?: string;
  guildId: string;
  agentId: string;
  kind: "dm" | "channel";
  label?: string;
  requireMention?: boolean;
  streamingUpdates?: boolean;
  typingIndicator?: boolean;
  channels?: DiscordChannelOverride[];
}

export interface DiscordConfig {
  token: string;
  bindings: DiscordBinding[];
}

export interface CronJob {
  name: string;
  schedule: string;
  type: "llm" | "script";
  prompt?: string;
  command?: string;
  agentId: string;
  deliveryChatId: number;
  deliveryThreadId?: number;
  timeout?: number;
  enabled?: boolean;
}

export interface SessionState {
  sessionId: string;
  chatId: string;
  agentId: string;
  lastActivity: number;
}

export interface SessionDefaults {
  idleTimeoutMs: number;
  maxConcurrentSessions: number;
  maxMessageAgeMs: number;
}

export interface BotConfig {
  telegramToken?: string;
  agents: Record<string, AgentConfig>;
  bindings: TelegramBinding[];
  sessionDefaults: SessionDefaults;
  logLevel?: LogLevel;
  metricsPort?: number;
  discord?: DiscordConfig;
  adminChatId?: number;
  defaultDeliveryChatId?: number;
  defaultDeliveryThreadId?: number;
}

/**
 * Platform-agnostic message I/O interface.
 * Each platform (Telegram, Discord) provides an adapter implementing this interface.
 * stream-relay and message-queue depend only on this — no platform-specific imports.
 */
export interface PlatformContext {
  /** Send a new message, returns a platform-specific message ID for later editing. */
  sendMessage(text: string): Promise<string>;

  /** Edit a previously sent message by its ID. */
  editMessage(messageId: string, text: string): Promise<void>;

  /** Delete a previously sent message by its ID. Best-effort — failures are silently ignored by callers. */
  deleteMessage(messageId: string): Promise<void>;

  /** Send a typing/action indicator. */
  sendTyping(): Promise<void>;

  /** Send a file (image or document). */
  sendFile(filePath: string, isImage: boolean): Promise<void>;

  /** Send an error reply to the user. */
  replyError(text: string): Promise<void>;

  /** Maximum message length for this platform. */
  readonly maxMessageLength: number;

  /** Minimum interval between message edits (ms). */
  readonly editDebounceMs: number;

  /** Interval between typing indicator resends (ms). */
  readonly typingIntervalMs: number;

  /** Whether to send progressive streaming edits (default true). */
  readonly streamingUpdates: boolean;

  /** Whether to send typing indicators (default true). */
  readonly typingIndicator: boolean;

  /** Pre-stream typing timer set by message queue, cleared by relayStream on handoff. */
  preStreamTypingTimer?: ReturnType<typeof setInterval>;
}

// CLI Protocol types

export interface StreamMessageUser {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

export interface SystemInit {
  type: "system";
  subtype: "init";
  session_id: string;
  [key: string]: unknown;
}

export interface StreamEvent {
  type: "stream_event";
  event: {
    delta?: {
      type: string;
      text?: string;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AssistantMessage {
  type: "assistant";
  subtype?: undefined;
  message: {
    role: "assistant";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
  session_id: string;
  [key: string]: unknown;
}

export interface ToolProgress {
  type: "assistant";
  subtype: "tool_progress";
  [key: string]: unknown;
}

export interface ToolUseSummary {
  type: "assistant";
  subtype: "tool_use_summary";
  [key: string]: unknown;
}

export interface ControlRequest {
  type: "assistant";
  subtype: "control_request";
  [key: string]: unknown;
}

export interface RateLimitEvent {
  type: "assistant";
  subtype: "rate_limit_event";
  [key: string]: unknown;
}

export interface ResultMessage {
  type: "result";
  result: string;
  session_id: string;
  cost_usd?: number;
  duration_ms?: number;
  [key: string]: unknown;
}

export type StreamLine =
  | SystemInit
  | StreamEvent
  | AssistantMessage
  | ToolProgress
  | ToolUseSummary
  | ControlRequest
  | RateLimitEvent
  | ResultMessage;

export interface CliCapabilities {
  version: string;
  flags: Set<string>;
  hasStreamJson: boolean;
  hasIncludePartialMessages: boolean;
  hasFallbackModel: boolean;
  hasAddDir: boolean;
  hasAppendSystemPrompt: boolean;
  hasDangerouslySkipPermissions: boolean;
  hasMaxTurns: boolean;
  hasTools: boolean;
}
