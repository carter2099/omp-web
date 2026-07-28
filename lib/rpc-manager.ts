/**
 * In-process AgentSession lifecycle for pi-web (OMP 17 createAgentSession).
 *
 * Traps preserved from AGENTS.md:
 * - globalThis registry + start locks (Next hot-reload safe)
 * - idle timeout 10m
 * - FORK THEN DESTROY WRAPPER (fork mutates sessionManager in-place)
 * - empty tools → empty system prompt (forced after bind/reload)
 * - running SSE + notifyRunningChange
 * - dual compaction event names accepted client-side; OMP emits auto_compaction_*
 */

import {
  createAgentSession,
  initTheme,
  SessionManager,
  theme,
  type AgentSession,
} from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type {
  RpcSubagentFrame,
  RpcSubagentSubscriptionLevel,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { applyDiscoverySettings, getOmpRuntime } from "./omp-runtime";
import { invalidateModelsCache } from "./models-cache";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type { ExtensionUiRequest, ExtensionUiResponse, ExtensionWidgetItem } from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS } from "./custom-ui-terminal";
import { createIdleTimer, type IdleTimer } from "./session-idle-timer";
import {
  getSubagentMessages,
  getSubagents,
  listSubagentHistoryCommand,
} from "./subagent-commands";
import { hasLiveSubagents } from "./subagent-live";
import {
  isRpcSubagentSubscriptionLevel,
  SubagentCommandError,
} from "./subagent-types";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

/** OMP built-in + legacy aliases — used so withExtensionTools only re-adds MCP/custom tools. */
const CODING_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "ast_grep",
  "ast_edit",
  "ask",
  "debug",
  "eval",
  "github",
  "glob",
  "grep",
  "lsp",
  "inspect_image",
  "browser",
  "checkpoint",
  "rewind",
  "task",
  "hub",
  "todo",
  "web_search",
  "write",
  "memory_edit",
  "retain",
  "recall",
  "reflect",
  "learn",
  "manage_skill",
  // legacy pi ids
  "find",
  "search",
  "ls",
];
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);
/** Parent session idle timeout (10 minutes). Exported for idle/subagent unit tests. */
export const IDLE_MS = 10 * 60 * 1000;

type AgentSessionWrapperOptions = {
  setToolUIContext?: (uiContext: ExtensionUiContextLike, hasUI: boolean) => void;
  eventBus?: EventBus;
  idleMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const extensionToolNames = session
    .getAllToolNames()
    .filter((name) => !codingToolNames.has(name));

  // Non-empty allow-lists always keep `task` so SubAgents can be spawned from the web UI.
  // Empty / preset none stays empty (no task).
  return [...new Set([...toolNames, "task", ...extensionToolNames])];
}

function systemPromptText(session: AgentSessionLike): string {
  const prompt = session.systemPrompt ?? session.agent.state?.systemPrompt;
  if (Array.isArray(prompt)) return prompt.join("\n");
  return typeof prompt === "string" ? prompt : "";
}

function listTools(session: AgentSessionLike): ToolInfo[] {
  return session.getAllToolNames().map((name) => {
    const tool = session.getToolByName?.(name);
    return {
      name,
      description: tool?.description ?? "",
    };
  });
}

/** Map OMP session events to the shapes ChatWindow / useAgentSession already handle. */
function adaptSessionEvent(event: AgentEvent): AgentEvent[] {
  // Client accepts both auto_compaction_* and compaction_*; OMP emits auto_*.
  // Re-emit dual names so either client path stays green.
  if (event.type === "auto_compaction_start") {
    return [event, { ...event, type: "compaction_start" }];
  }
  if (event.type === "auto_compaction_end") {
    return [event, { ...event, type: "compaction_end" }];
  }
  return [event];
}

// ============================================================================
// AgentSessionWrapper
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: IdleTimer;
  private onDestroyCallback: (() => void) | null = null;
  private _alive = true;
  private setToolUIContext: ((uiContext: ExtensionUiContextLike, hasUI: boolean) => void) | null = null;
  /** Captured EventBus from createAgentSession; kept across inner.reload(). */
  private eventBus: EventBus | null = null;
  /**
   * OMP RpcSubagentRegistry bound to eventBus.
   * Recreated only on new createAgentSession — never on same-session reload.
   */
  private subagentRegistry: RpcSubagentRegistry | null = null;
  /**
   * Client-facing SSE subscription level. Independent of the registry internal
   * level: registry always stays at least `progress` so live-set transitions
   * still reset idle and call notifyRunningChange when the UI level is `off`.
   */
  private subagentSseLevel: RpcSubagentSubscriptionLevel = "progress";
  /** Tracks whether any live child was present for notifyRunningChange edge. */
  private hadLiveSubagents = false;

  constructor(
    public readonly inner: AgentSessionLike,
    options?: AgentSessionWrapperOptions,
  ) {
    this.setToolUIContext = options?.setToolUIContext ?? null;
    this.eventBus = options?.eventBus ?? null;
    this.idleTimer = createIdleTimer({
      idleMs: options?.idleMs ?? IDLE_MS,
      isRunning: () => this.isRunning(),
      onIdle: () => this.destroy(),
      setTimeoutFn: options?.setTimeoutFn,
      clearTimeoutFn: options?.clearTimeoutFn,
    });
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    if (!this._alive) return false;
    if (
      this.promptRunning
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.inner.isBashRunning
    ) {
      return true;
    }
    // Detached SubAgents keep the parent wrapper alive (Oracle idle lock).
    return hasLiveSubagents(this.subagentRegistry?.getSubagents() ?? []);
  }

  start(): void {
    if (this.eventBus && !this.subagentRegistry) {
      this.attachSubagentRegistry(this.eventBus);
    }

    this.unsubscribe = this.inner.subscribe((raw) => {
      this.resetIdleTimer();
      const event = raw as AgentEvent;
      if (event.type === "agent_end") {
        invalidateSessionListCache();
      }
      for (const adapted of adaptSessionEvent(event)) {
        this.emit(adapted);
      }
      notifyRunningChange();
    });
    this.resetIdleTimer();
    notifyRunningChange();
  }

  /**
   * Attach OMP RpcSubagentRegistry to the session EventBus.
   * Default subscription level is "progress".
   */
  private attachSubagentRegistry(eventBus: EventBus): void {
    this.subagentRegistry = new RpcSubagentRegistry(eventBus, (frame) => {
      this.handleSubagentFrame(frame);
    });
    this.subagentRegistry.setSubscriptionLevel("progress");
    this.hadLiveSubagents = hasLiveSubagents(this.subagentRegistry.getSubagents());
  }

  private handleSubagentFrame(frame: RpcSubagentFrame): void {
    // Any registry frame (even when client SSE level is off) resets idle and
    // drives running-badge edges from the live child set.
    this.resetIdleTimer();
    const live = hasLiveSubagents(this.subagentRegistry?.getSubagents() ?? []);
    if (live !== this.hadLiveSubagents) {
      this.hadLiveSubagents = live;
      notifyRunningChange();
    }

    // SSE frames suppressed at client level `off`; events only when requested.
    if (this.subagentSseLevel === "off") return;
    if (frame.type === "subagent_event" && this.subagentSseLevel !== "events") {
      return;
    }
    this.emit({
      type: frame.type,
      payload: frame.payload,
    });
  }

  /**
   * Apply client subscription level. Registry stays ≥ progress for internal
   * live tracking; only SSE emit is gated by subagentSseLevel.
   */
  private applySubagentSseSubscription(
    level: RpcSubagentSubscriptionLevel,
  ): { level: RpcSubagentSubscriptionLevel } {
    this.subagentSseLevel = level;
    const registry = this.requireSubagentRegistry();
    // Keep registry emitting frames so idle/notify keep working at SSE off.
    registry.setSubscriptionLevel(level === "off" ? "progress" : level);
    return { level: this.subagentSseLevel };
  }

  private requireSubagentRegistry(): RpcSubagentRegistry {
    if (!this.subagentRegistry) {
      throw new SubagentCommandError("Subagent event bus is unavailable", 500);
    }
    return this.subagentRegistry;
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.applyForcedEmptySystemPrompt();
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[pi-web] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
      this.applyForcedEmptySystemPrompt();
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      this.setToolUIContext?.(uiContext, true);

      // OMP: initializeExtensions wires runner actions + emits session_start.
      await initializeExtensions(this.inner as unknown as AgentSession, {
        reportSendError: (action, err) => {
          this.emit({
            type: "extension_error",
            extensionPath: action,
            event: "send",
            error: err.message,
          });
        },
        reportRuntimeError: (err) => {
          this.emit({
            type: "extension_error",
            extensionPath: err.extensionPath,
            event: err.event,
            error: err.error,
          });
        },
        onShutdown: () => {
          this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: "Extension requested shutdown, but shutdown is not supported in Pi Web.",
          } as ExtensionUiRequest as AgentEvent);
        },
        uiContext: uiContext as never,
      });

      this.extensionsBound = true;
      this.applyForcedEmptySystemPrompt();
      console.log(`[pi-web] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt" || type === "steer" || type === "follow_up" || type === "get_commands";
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      notifyRunningChange();
    }
  }

  private applyForcedEmptySystemPrompt(): void {
    if (!this.forceEmptySystemPrompt) return;
    if (this.inner.agent.state) {
      // OMP systemPrompt is string[]; empty array = no system prompt blocks.
      this.inner.agent.state.systemPrompt = [];
    }
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  private resetIdleTimer(): void {
    this.idleTimer.reset();
  }

  private async persistBashOnlySession(): Promise<void> {
    const manager = this.inner.sessionManager;
    let sessionFile = manager.getSessionFile();
    if (!sessionFile || !existsSync(sessionFile)) {
      if (typeof manager.ensureOnDisk === "function") {
        await manager.ensureOnDisk();
      }
      sessionFile = manager.getSessionFile();
    }
    if (sessionFile) {
      cacheSessionPath(this.inner.sessionId, sessionFile);
    }
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();

    switch (type) {
      case "prompt": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot send a prompt while a shell command is running");
        }
        const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        this.promptRunning = true;
        notifyRunningChange();
        this.inner.prompt(command.message as string, {
          ...(promptImages?.length ? { images: promptImages } : {}),
          ...(streamingBehavior ? { streamingBehavior } : {}),
          source: "rpc",
        }).then(() => {
          this.promptRunning = false;
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
          notifyRunningChange();
        }).catch((error) => {
          this.promptRunning = false;
          invalidateSessionListCache();
          this.emit({
            type: "prompt_error",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
          notifyRunningChange();
        });
        return null;
      }

      case "abort":
        await this.withFinalRunningNotification(() => this.inner.abort());
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        const queued = this.inner.getQueuedMessages();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.promptRunning,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: this.inner.queuedMessageCount,
          queuedMessages: {
            steering: [...queued.steering],
            followUp: [...queued.followUp],
          },
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: systemPromptText(this.inner),
          thinkingLevel: this.inner.thinkingLevel ?? this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
        };
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const model = this.inner.modelRegistry.find(provider, modelId);
        if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
        await this.inner.setModel(model);
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider };
      }

      case "fork": {
        // FORK THEN DESTROY WRAPPER — AgentSession.fork / createBranchedSession
        // mutate the underlying SessionManager. Destroy this wrapper under the old
        // id so the next request reloads a clean AgentSession from the original file.
        if (this.promptRunning || this.inner.isStreaming || this.inner.isCompacting) {
          throw new Error("Cannot fork while a prompt is running");
        }
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!currentSessionFile) return { cancelled: true };

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          const created = await newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = created ?? (newManager.getSessionFile() as string);
          if (!newSessionFile) throw new Error("Failed to create empty forked session");
          await newManager.close?.();
        } else {
          // Fork after history: copy path up to (but not including) the fork point.
          // Open a separate manager so the live wrapper's manager is not mutated.
          const sourceManager = await SessionManager.open(currentSessionFile, sessionDir);
          try {
            const forkedPath = sourceManager.createBranchedSession(entry.parentId);
            if (!forkedPath) throw new Error("Failed to create forked session");
            newSessionFile = forkedPath;
          } finally {
            await sourceManager.close();
          }
        }

        const reopened = await SessionManager.open(newSessionFile, sessionDir);
        try {
          const newSessionId = reopened.getSessionId();
          cacheSessionPath(newSessionId, newSessionFile);
          invalidateSessionListCache();
          this.destroy();
          return { cancelled: false, newSessionId };
        } finally {
          await reopened.close();
        }
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.inner.setThinkingLevel(level);
        // Preserve deepseek-compat xhigh when the model maps it.
        if (
          level === "xhigh"
          && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek"
          && this.inner.agent?.state
        ) {
          this.inner.agent.state.thinkingLevel = "xhigh";
        }
        invalidateSessionListCache();
        return null;
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        await this.inner.setSessionName(name, "user");
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        return this.inner.clearQueue() ?? { steering: [], followUp: [] };
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all = listTools(this.inner);
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "get_commands": {
        const commands: Array<{
          name: string;
          description?: string;
          source: string;
          sourceInfo?: { path?: string; source?: string };
        }> = [];
        const runner = this.inner.extensionRunner;
        if (runner) {
          for (const registered of runner.getRegisteredCommands()) {
            commands.push({
              name: registered.name,
              description: registered.description,
              source: "extension",
            });
          }
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo ?? (skill.filePath ? { path: skill.filePath } : undefined),
          });
        }
        return { commands };
      }

      case "set_tools": {
        // null/undefined = OMP natural default (activate every registered tool).
        // [] = no tools. non-empty = allow-list (+ task + non-builtin extensions).
        const toolNames = command.toolNames as string[] | null | undefined;
        if (toolNames === null || toolNames === undefined) {
          this.setForceEmptySystemPrompt(false);
          await this.inner.setActiveToolsByName(this.inner.getAllToolNames());
          this.applyForcedEmptySystemPrompt();
          return null;
        }
        this.setForceEmptySystemPrompt(toolNames.length === 0);
        await this.inner.setActiveToolsByName(withExtensionTools(this.inner, toolNames));
        this.applyForcedEmptySystemPrompt();
        return null;
      }

      case "reload": {
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.extensionWidgets.clear();
        await this.inner.reload();
        this.extensionsBound = false;
        this.extensionBindingPromise = null;
        this.beginExtensionBinding({ forceEmptySystemPrompt: this.forceEmptySystemPrompt });
        await this.waitForExtensionsBound();
        this.applyForcedEmptySystemPrompt();
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          { excludeFromContext: command.excludeFromContext as boolean | undefined },
        );
        notifyRunningChange();
        try {
          const result = await execution;
          await this.persistBashOnlySession();
          return result;
        } finally {
          invalidateSessionListCache();
          notifyRunningChange();
        }
      }

      case "abort_bash": {
        this.inner.abortBash();
        return null;
      }

      case "set_subagent_subscription": {
        if (!isRpcSubagentSubscriptionLevel(command.level)) {
          throw new SubagentCommandError(
            `Invalid subagent subscription level: ${String(command.level)}`,
            400,
          );
        }
        return this.applySubagentSseSubscription(command.level);
      }

      case "get_subagents": {
        return getSubagents(this.requireSubagentRegistry());
      }

      case "get_subagent_messages": {
        const parentSessionFile = this.sessionFile;
        if (!parentSessionFile) {
          throw new SubagentCommandError("Parent session file is unavailable", 404);
        }
        return getSubagentMessages(
          this.requireSubagentRegistry(),
          parentSessionFile,
          command,
        );
      }

      case "list_subagent_history": {
        return listSubagentHistoryCommand(this.sessionFile);
      }

      default: {
        const err = new SubagentCommandError(`Unsupported command: ${type}`, 400);
        throw err;
      }
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    this.idleTimer.clear();
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    // Registry bus listeners must go before inner session dispose (lifecycle lock).
    if (this.subagentRegistry) {
      this.subagentRegistry.dispose();
      this.subagentRegistry = null;
    }
    this.hadLiveSubagents = false;
    // Dispose OMP session (async teardown); do not await in destroy callers.
    void this.inner.dispose().catch((err) => {
      console.error("[pi-web] session dispose failed:", err instanceof Error ? err.message : err);
    });
    this.onDestroyCallback?.();
    notifyRunningChange();
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };

      Promise.resolve()
        .then(() => (factory as (...args: unknown[]) => unknown)(tui, theme, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
      };
      const settle = (value: T) => {
        cleanup();
        resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.extensionWidgets.delete(key);
        } else {
          this.extensionWidgets.set(key, {
            key,
            lines: content,
            placement: options?.placement ?? "aboveEditor",
          });
        }
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return theme; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in Pi Web extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __piRunningListeners: Set<(ids: string[]) => void> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__piRunningListeners) globalThis.__piRunningListeners = new Set();
  return globalThis.__piRunningListeners;
}

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers. Cheap to call often.
 */
export function notifyRunningChange(): void {
  const ids = getRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of getRunningListeners()) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), OMP generates its own id.
 * Pass toolNames to pre-configure active tools (empty array = all tools disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    // Extensions may access the global theme.
    await initTheme();
    const runtime = await getOmpRuntime();
    const settings = await runtime.getSettingsForCwd(cwd);
    applyDiscoverySettings(settings);

    const sessionManager = sessionFile
      ? await SessionManager.open(sessionFile)
      : SessionManager.create(cwd);

    const emptyTools = toolNames !== undefined && toolNames.length === 0;

    const {
      session: inner,
      setToolUIContext,
      eventBus,
    } = await createAgentSession({
      cwd,
      agentDir: runtime.agentDir,
      authStorage: runtime.authStorage,
      modelRegistry: runtime.modelRegistry,
      settings,
      sessionManager,
      hasUI: true,
      ...(emptyTools
        ? {
            toolNames: [],
            restrictToolNames: true,
            enableMCP: false,
            enableLsp: false,
            enableIrc: false,
          }
        : {}),
    });

    // Non-empty allow-list: activate requested coding tools + extension tools.
    if (toolNames && toolNames.length > 0) {
      await inner.setActiveToolsByName(withExtensionTools(inner as unknown as AgentSessionLike, toolNames));
    }

    const wrapper = new AgentSessionWrapper(inner as unknown as AgentSessionLike, {
      setToolUIContext: setToolUIContext as unknown as (
        uiContext: ExtensionUiContextLike,
        hasUI: boolean,
      ) => void,
      eventBus,
    });
    if (emptyTools) {
      wrapper.setForceEmptySystemPrompt(true);
    }
    wrapper.start();

    const realSessionId = inner.sessionId;
    const realSessionFile = inner.sessionFile;
    if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

    wrapper.onDestroy(() => registry.delete(realSessionId));
    registry.set(realSessionId, wrapper);
    wrapper.beginExtensionBinding({ forceEmptySystemPrompt: emptyTools });

    return { session: wrapper, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
