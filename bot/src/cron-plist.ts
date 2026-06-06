export interface CronPlistDef {
  name: string;
  schedule: string;
  type?: "llm" | "script";
  engine?: "pi";
  prompt?: string;
  command?: string;
  agentId: string;
  deliveryChatId?: number;
  timeout?: number;
  enabled?: boolean;
}

export function validateCronForPlist(cron: CronPlistDef): string | undefined {
  const cronType = cron.type ?? "llm";
  if (cronType !== "llm" && cronType !== "script") {
    return `${cron.name} has invalid type "${cron.type}" (must be "llm" or "script")`;
  }
  if (cronType === "llm" && cron.engine !== undefined && cron.engine !== "pi") {
    return `${cron.name} has invalid engine "${cron.engine}" (must be "pi" or omitted)`;
  }
  if (cronType === "script" && (!cron.command || !cron.command.trim())) {
    return `${cron.name} is type "script" but missing required "command" field`;
  }
  if (cronType === "llm" && (!cron.prompt || !cron.prompt.trim())) {
    return `${cron.name} is type "llm" but missing required "prompt" field`;
  }
  return undefined;
}
