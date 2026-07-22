/**
 * Structural types for the live agent surface used by rpc-manager.
 * Kept independent of package version churn; OMP AgentSession is the runtime.
 */

export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface ModelLike {
  id: string;
  provider: string;
  compat?: { thinkingFormat?: string };
}

export interface ToolInfo {
  name: string;
  description: string;
}

export interface NavigateTreeResult {
  editorText?: string;
  cancelled: boolean;
  aborted?: boolean;
}

export interface SessionStatsInfo {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsage;
}

export interface SlashCommandSourceInfo {
  path?: string;
  source?: string;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | string;
  sourceInfo?: SlashCommandSourceInfo;
}

interface PromptTemplateLike {
  name: string;
  description?: string;
  sourceInfo?: SlashCommandSourceInfo;
}

interface SkillLike {
  name: string;
  description?: string;
  sourceInfo?: SlashCommandSourceInfo;
  filePath?: string;
}

interface ExtensionRunnerLike {
  getRegisteredCommands(reserved?: ReadonlySet<string>): Array<{
    name: string;
    description?: string;
  }>;
  setUIContext?(uiContext?: unknown, mode?: "tui" | "rpc" | "json" | "print"): void;
}

type DialogOptionsLike = {
  signal?: AbortSignal;
  timeout?: number;
};

type WidgetOptionsLike = {
  placement?: "aboveEditor" | "belowEditor";
};

/** Minimal Theme surface used by extension UI context. */
export interface ThemeLike {
  fg?(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
  italic?(text: string): string;
  underline?(text: string): string;
  inverse?(text: string): string;
  strikethrough?(text: string): string;
}

export interface ExtensionUiContextLike {
  select(title: string, options: string[], opts?: DialogOptionsLike): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: DialogOptionsLike): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: DialogOptionsLike): Promise<string | undefined>;
  editor(title: string, prefill?: string, opts?: DialogOptionsLike): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  onTerminalInput(): () => void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setWorkingVisible(visible: boolean): void;
  setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void;
  setHiddenThinkingLabel(label?: string): void;
  setWidget(key: string, content: string[] | ((...args: never[]) => unknown) | undefined, options?: WidgetOptionsLike): void;
  setFooter(factory: unknown): void;
  setHeader(factory: unknown): void;
  setTitle(title: string): void;
  custom<T = unknown>(...args: unknown[]): Promise<T>;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  addAutocompleteProvider(): void;
  setEditorComponent(): void;
  getEditorComponent(): undefined;
  readonly theme: ThemeLike;
  getAllThemes(): unknown[] | Promise<unknown[]>;
  getTheme(name: string): undefined | Promise<ThemeLike | undefined>;
  setTheme(theme: unknown): { success: boolean; error?: string } | Promise<{ success: boolean; error?: string }>;
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}

/**
 * Structural view of OMP AgentSession methods used by the web RPC wrapper.
 * Runtime object is the real AgentSession from createAgentSession().
 */
export interface AgentSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly autoCompactionEnabled: boolean;
  readonly autoRetryEnabled: boolean;
  readonly model: ModelLike | undefined;
  readonly modelRegistry: { find: (provider: string, modelId: string) => ModelLike | undefined };
  readonly sessionManager: {
    getSessionFile(): string | undefined;
    getSessionDir(): string;
    getCwd(): string;
    getHeader(): { cwd?: string; id?: string } | null;
    getEntry(id: string): { parentId: string | null } | undefined;
    getEntries(): unknown[];
    getSessionName(): string | undefined;
    createBranchedSession(leafId: string): string | undefined;
    newSession(options?: { parentSession?: string }): Promise<string | undefined> | string | undefined;
    ensureOnDisk?(): Promise<void>;
  };
  readonly settings: unknown;
  readonly agent: { state?: { systemPrompt?: string | string[]; thinkingLevel?: string }; waitForIdle?: () => Promise<void> };
  readonly extensionRunner: ExtensionRunnerLike | undefined;
  readonly promptTemplates: readonly PromptTemplateLike[];
  readonly skills: readonly SkillLike[];
  readonly thinkingLevel: string | undefined;
  readonly systemPrompt: string | string[];
  readonly queuedMessageCount: number;

  subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
  dispose(options?: unknown): Promise<void>;
  prompt(text: string, options?: {
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    streamingBehavior?: "steer" | "followUp";
    source?: "interactive" | "rpc";
  }): Promise<boolean | void>;
  abort(options?: { reason?: string }): Promise<void>;
  executeBash(command: string, onChunk?: (chunk: string) => void, options?: { excludeFromContext?: boolean }): Promise<{ output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string }>;
  abortBash(): void;
  readonly isBashRunning: boolean;
  setModel(model: ModelLike, role?: string, options?: unknown): Promise<{ switched: boolean } | void>;
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<NavigateTreeResult>;
  setThinkingLevel(level: string | undefined, persist?: boolean): void;
  compact(customInstructions?: string): Promise<unknown>;
  setSessionName(name: string, source?: "auto" | "user"): Promise<boolean> | void;
  getSessionStats(): Omit<SessionStatsInfo, "sessionName">;
  getLastAssistantText(): string | undefined;
  setAutoCompactionEnabled(enabled: boolean): void;
  setAutoRetryEnabled(enabled: boolean): void;
  steer(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  followUp(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] };
  clearQueue(options?: { forInterrupt?: boolean }): { steering: string[]; followUp: string[] } | void;
  getAllToolNames(): string[];
  getToolByName?(name: string): { name: string; description?: string } | undefined;
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): Promise<void> | void;
  abortCompaction(): void;
  getContextUsage(): ContextUsage | undefined;
  reload(): Promise<void>;
  waitForIdle?(): Promise<void>;
}
