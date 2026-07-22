import {
  Agent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
} from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

const TITLE_TIMEOUT_MS = 90_000;
const MAX_TITLE_LENGTH = 80;

const TITLE_PROMPT = `Create a concise title for this session based on the conversation above.

Requirements:
- Match the primary language used by the user.
- Describe the user's concrete goal or the outcome, not the act of chatting.
- Use 4-12 words for space-separated languages, or 8-24 characters for CJK text when practical.
- Do not call any tools.
- Return only the title as plain text, with no quotes, label, markdown, or explanation.`;

export interface GeneratedSessionTitle {
  title: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/**
 * Structural source for title-agent cloning.
 * Real OMP `Agent` keeps convertToLlm/transformContext private; tests and
 * wrappers may still expose them as own properties for prefix preservation.
 */
type SessionTitleAgentSource = {
  state: Agent["state"];
  convertToLlm?: AgentOptions["convertToLlm"];
  transformContext?: AgentOptions["transformContext"];
  streamFn?: AgentOptions["streamFn"];
  /** Legacy earendil field name; accepted then mapped to streamFn. */
  streamFunction?: AgentOptions["streamFn"];
  getApiKey?: AgentOptions["getApiKey"];
  onPayload?: AgentOptions["onPayload"];
  onResponse?: AgentOptions["onResponse"];
  sessionId?: string;
  thinkingBudgets?: AgentOptions["thinkingBudgets"];
  maxRetryDelayMs?: number;
  steeringMode?: AgentOptions["steeringMode"];
  followUpMode?: AgentOptions["followUpMode"];
  getSteeringMode?: () => AgentOptions["steeringMode"];
  getFollowUpMode?: () => AgentOptions["followUpMode"];
};

function createShadowTools(tools: AgentTool[]): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async () => {
      throw new Error("Tools cannot be executed while generating a session title");
    },
  }));
}

function readSteeringMode(source: SessionTitleAgentSource): AgentOptions["steeringMode"] {
  if (typeof source.getSteeringMode === "function") return source.getSteeringMode();
  return source.steeringMode;
}

function readFollowUpMode(source: SessionTitleAgentSource): AgentOptions["followUpMode"] {
  if (typeof source.getFollowUpMode === "function") return source.getFollowUpMode();
  return source.followUpMode;
}

/**
 * Build a temporary Agent configuration whose provider-facing prefix matches
 * the source Agent. Tool implementations are replaced without changing their
 * names, descriptions, or schemas, so a naming run cannot mutate the project.
 */
export function buildSessionTitleAgentOptions(source: SessionTitleAgentSource | Agent): AgentOptions {
  const src = source as SessionTitleAgentSource;
  const state = src.state;
  return {
    initialState: {
      systemPrompt: state.systemPrompt,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      tools: createShadowTools(state.tools),
      messages: state.messages,
    },
    convertToLlm: src.convertToLlm,
    transformContext: src.transformContext,
    streamFn: src.streamFn ?? src.streamFunction,
    getApiKey: src.getApiKey,
    onPayload: src.onPayload,
    onResponse: src.onResponse,
    steeringMode: readSteeringMode(src),
    followUpMode: readFollowUpMode(src),
    sessionId: src.sessionId,
    thinkingBudgets: src.thinkingBudgets,
    maxRetryDelayMs: src.maxRetryDelayMs,
  };
}

/**
 * A running source session usually ends in the user message currently being
 * answered. Fold the title request into a copy of that message so the title
 * request does not send two consecutive user messages to the provider.
 */
export function appendTitleRequestToTrailingUser(messages: AgentMessage[]): AgentMessage[] {
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== "user") return messages;

  const content = typeof lastMessage.content === "string"
    ? `${lastMessage.content}\n\n${TITLE_PROMPT}`
    : [...lastMessage.content, { type: "text" as const, text: TITLE_PROMPT }];

  return [
    ...messages.slice(0, -1),
    { ...lastMessage, content },
  ];
}

function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["\u201c", "\u201d"],
    ["\u300c", "\u300d"],
    ["\u300e", "\u300f"],
  ];
  for (const [start, end] of pairs) {
    if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) {
      return value.slice(start.length, -end.length).trim();
    }
  }
  return value;
}

export function parseGeneratedSessionTitle(raw: string): string {
  let value = raw.trim();
  const fenced = value.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1].trim();

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { title?: unknown };
      if (typeof parsed.title === "string") value = parsed.title.trim();
    } catch {
      // Fall back to plain-text cleanup below.
    }
  }

  value = value.split(/\r?\n/, 1)[0] ?? "";
  value = value.replace(/^(?:session\s+title|title|标题)\s*[:：-]\s*/i, "");
  value = stripWrappingQuotes(value).replace(/\s+/g, " ").trim();
  value = value.replace(/[。.!]+$/u, "").trim();

  if (!/[\p{L}\p{N}]/u.test(value)) {
    throw new Error("The model did not return a usable session title");
  }

  const characters = Array.from(value);
  if (characters.length > MAX_TITLE_LENGTH) {
    value = characters.slice(0, MAX_TITLE_LENGTH).join("").trim();
  }
  return value;
}

function getAssistantResult(agent: Agent, historyLength: number): GeneratedSessionTitle {
  const generatedMessages = agent.state.messages.slice(historyLength);
  for (let i = generatedMessages.length - 1; i >= 0; i--) {
    const message = generatedMessages[i];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      throw new Error(message.errorMessage || "The title model request failed");
    }
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) continue;
    return {
      title: parseGeneratedSessionTitle(text),
      ...(message.usage ? {
        usage: {
          input: message.usage.input,
          output: message.usage.output,
          cacheRead: message.usage.cacheRead,
          cacheWrite: message.usage.cacheWrite,
          total: message.usage.totalTokens,
        },
      } : {}),
    };
  }
  throw new Error("The model did not return a session title");
}

export async function generateSessionTitle(source: AgentSession): Promise<GeneratedSessionTitle> {
  const sourceAgent = source.agent;
  await sourceAgent.waitForIdle();

  const historyLength = sourceAgent.state.messages.length;
  if (!sourceAgent.state.messages.some((message) => message.role === "user")) {
    throw new Error("The session has no user messages to name");
  }

  const options = buildSessionTitleAgentOptions(sourceAgent);
  const continuesFromTrailingUser = sourceAgent.state.messages.at(-1)?.role === "user";
  if (continuesFromTrailingUser) {
    options.initialState!.messages = appendTitleRequestToTrailingUser(sourceAgent.state.messages);
  }

  const temporaryAgent = new Agent(options);
  const runPromise = continuesFromTrailingUser
    ? temporaryAgent.continue()
    : temporaryAgent.prompt(TITLE_PROMPT);
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          temporaryAgent.abort();
          reject(new Error("Session title generation timed out"));
        }, TITLE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    temporaryAgent.abort();
    await runPromise.catch(() => {});
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  return getAssistantResult(temporaryAgent, historyLength);
}
