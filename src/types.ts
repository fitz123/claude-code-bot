// Core types for the OpenClaw Telegram bot

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
}

export interface CronJob {
  name: string;
  schedule: string;
  prompt: string;
  agentId: string;
  deliveryChatId: number;
  timeout?: number;
  maxBudget?: number;
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
}

export interface BotConfig {
  telegramToken: string;
  agents: Record<string, AgentConfig>;
  bindings: TelegramBinding[];
  sessionDefaults: SessionDefaults;
  logLevel?: LogLevel;
  metricsPort?: number;
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
  hasMaxBudgetUsd: boolean;
  hasMaxTurns: boolean;
  hasTools: boolean;
}
