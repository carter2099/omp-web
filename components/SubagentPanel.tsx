import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import type { RpcSubagentSnapshot, SubagentMessagesPage } from "@/lib/subagent-types";
import { isLiveSubagentStatus } from "@/lib/subagent-live";
import {
  displayRoleLabel,
  parseSubagentTranscriptDisplay,
  type SubagentDisplayTurn,
} from "@/lib/subagent-transcript-display";
import { MarkdownBody } from "@/components/MarkdownBody";

interface SubagentPanelProps {
  subagents: RpcSubagentSnapshot[];
  selectedSubagentId: string | null;
  onSelectSubagent: (id: string | null) => void;
  loadSubagentMessages: (selector: {
    subagentId?: string;
    sessionFile?: string;
    fromByte?: number;
  }) => Promise<SubagentMessagesPage>;
  fetchColdHistory?: () => Promise<void>;
  onClose: () => void;
}

function statusLabel(status: string): string {
  switch (status) {
    case "pending":
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "aborted":
      return "Aborted";
    default:
      return "Unknown";
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "pending":
    case "running":
      return "var(--accent)";
    case "completed":
      return "#10b981";
    case "failed":
      return "#ef4444";
    case "aborted":
      return "var(--text-muted)";
    default:
      return "var(--text-dim)";
  }
}

function roleAccent(role: SubagentDisplayTurn["role"]): string {
  switch (role) {
    case "user":
      return "var(--accent)";
    case "assistant":
      return "#10b981";
    case "tool":
      return "#f59e0b";
    default:
      return "var(--text-muted)";
  }
}

function agentTypeBadge(agent: string): string {
  return agent.trim() || "unknown";
}

function SubagentListRow({
  snapshot,
  onSelect,
}: {
  snapshot: RpcSubagentSnapshot;
  onSelect: (id: string) => void;
}) {
  const typeLabel = agentTypeBadge(snapshot.agent);
  // When id is a spawn label distinct from the agent type, show both.
  const idTail = snapshot.id.includes("/")
    ? snapshot.id.slice(snapshot.id.lastIndexOf("/") + 1)
    : snapshot.id;
  const showJobId = idTail !== snapshot.agent && idTail.length > 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(snapshot.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(snapshot.id);
        }
      }}
      style={{
        padding: "10px 12px",
        borderRadius: 6,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--bg)";
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              padding: "1px 6px",
              borderRadius: 4,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              color: "var(--accent)",
              flexShrink: 0,
            }}
            title={snapshot.agentSource ? `Source: ${snapshot.agentSource}` : undefined}
          >
            {typeLabel}
          </span>
          {showJobId && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: "var(--text-muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={snapshot.id}
            >
              {idTail}
            </span>
          )}
        </div>
        <span style={{ fontSize: 10, fontWeight: 600, color: statusColor(snapshot.status), flexShrink: 0 }}>
          {statusLabel(snapshot.status)}
        </span>
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {snapshot.description || snapshot.task || "No description"}
      </div>
    </div>
  );
}

function TranscriptTurn({ turn }: { turn: SubagentDisplayTurn }) {
  const label =
    turn.role === "tool" && turn.toolName
      ? `${displayRoleLabel(turn.role)} · ${turn.toolName}`
      : displayRoleLabel(turn.role);

  return (
    <div
      style={{
        marginBottom: 12,
        padding: "10px 12px",
        borderRadius: 8,
        background: turn.role === "user" ? "var(--user-bg, var(--bg-hover))" : "var(--bg-panel)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.3,
          color: roleAccent(turn.role),
          marginBottom: 6,
        }}
      >
        {label}
      </div>

      {turn.role === "tool" ? (
        <pre
          style={{
            margin: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--text-muted)",
            maxHeight: 240,
            overflow: "auto",
          }}
        >
          {turn.text}
        </pre>
      ) : turn.text ? (
        <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text)" }}>
          <MarkdownBody>{turn.text}</MarkdownBody>
        </div>
      ) : null}

      {turn.toolCalls && turn.toolCalls.length > 0 && (
        <div style={{ marginTop: turn.text ? 8 : 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {turn.toolCalls.map((call, i) => (
            <div
              key={`${turn.id}-tc-${i}`}
              style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                padding: "4px 8px",
                borderRadius: 4,
                background: "var(--tool-bg, var(--bg))",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={call.summary}
            >
              🔧 {call.name}
              {call.summary ? ` — ${call.summary}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SubagentPanel({
  subagents,
  selectedSubagentId,
  onSelectSubagent,
  loadSubagentMessages,
  fetchColdHistory,
  onClose,
}: SubagentPanelProps) {
  const t = useTranslations('subagentPanel');
  const [rawTranscript, setRawTranscript] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [nextByte, setNextByte] = useState<number>(0);
  const [eof, setEof] = useState<boolean>(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selected = subagents.find((s) => s.id === selectedSubagentId) ?? null;

  const turns = useMemo(
    () => parseSubagentTranscriptDisplay(rawTranscript),
    [rawTranscript],
  );

  const { active, history } = useMemo(() => {
    const activeRows: RpcSubagentSnapshot[] = [];
    const historyRows: RpcSubagentSnapshot[] = [];
    for (const row of subagents) {
      if (isLiveSubagentStatus(row.status)) {
        activeRows.push(row);
      } else {
        historyRows.push(row);
      }
    }
    return { active: activeRows, history: historyRows };
  }, [subagents]);

  useEffect(() => {
    if (!fetchColdHistory) return;
    let cancelled = false;
    setHistoryLoading(true);
    void fetchColdHistory()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchColdHistory]);

  const loadTranscript = useCallback(async (
    target: RpcSubagentSnapshot,
    fromByte = 0,
    append = false,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const page = await loadSubagentMessages(
        target.sessionFile
          ? { sessionFile: target.sessionFile, fromByte }
          : { subagentId: target.id, fromByte },
      );
      setRawTranscript((prev) => (append ? prev + page.content : page.content));
      setNextByte(page.nextByte);
      setEof(page.eof);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [loadSubagentMessages]);

  useEffect(() => {
    if (selected) {
      void loadTranscript(selected, 0, false);
    } else {
      setRawTranscript("");
      setNextByte(0);
      setEof(true);
    }
  }, [selected, loadTranscript]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns.length]);

  return (
    <div
      style={{
        width: 380,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-panel)",
        borderLeft: "1px solid var(--border)",
        color: "var(--text)",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700 }}>{t('subAgents')}</span>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 18,
            padding: 4,
          }}
        >
          ×
        </button>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {selected ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid var(--border)",
                background: "var(--bg)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: "var(--font-mono)",
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: "var(--bg-panel)",
                      border: "1px solid var(--border)",
                      color: "var(--accent)",
                    }}
                    title={selected.agentSource ? `Source: ${selected.agentSource}` : t('agentType')}
                  >
                    {agentTypeBadge(selected.agent)}
                  </span>
                  {selected.id !== selected.agent && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={selected.id}
                    >
                      {selected.id.includes("/")
                        ? selected.id.slice(selected.id.lastIndexOf("/") + 1)
                        : selected.id}
                    </span>
                  )}
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: "var(--bg-panel)",
                    color: statusColor(selected.status),
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  {statusLabel(selected.status)}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>
                {selected.description || selected.task || t('noDescription')}
              </div>
              {selected.progress && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-dim)" }}>
                    <span>{t('progress')}</span>
                    <span>
                      {selected.progress.recentTools && selected.progress.recentTools.length > 0
                        ? `${selected.progress.recentTools.length} ${t('toolCalls')}`
                        : ""}
                    </span>
                  </div>
                  {selected.progress.requests !== undefined && (
                    <div style={{ fontSize: 10, color: "var(--text-muted)", fontStyle: "italic" }}>
                      {t('requestsAndToolCalls', { requests: selected.progress.requests, toolCount: selected.progress.toolCount })}
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => onSelectSubagent(null)}
                style={{
                  marginTop: 10,
                  width: "100%",
                  height: 28,
                  fontSize: 11,
                  background: "var(--border)",
                  border: "none",
                  borderRadius: 4,
                  color: "var(--text)",
                  cursor: "pointer",
                }}
              >
                {t('backToList')}
              </button>
            </div>

            <div
              ref={scrollRef}
              style={{
                flex: 1,
                padding: 12,
                overflowY: "auto",
                background: "var(--bg)",
              }}
            >
              {loading && turns.length === 0 && (
                <div style={{ color: "var(--text-dim)", textAlign: "center", padding: 16 }}>{t('loading')}</div>
              )}
              {error && (
                <div style={{ color: "#ef4444", textAlign: "center", padding: 8 }}>{error}</div>
              )}
              {!loading && !error && turns.length === 0 && (
                <div style={{ color: "var(--text-dim)", textAlign: "center", padding: 16 }}>
                  {t('noConversationRecords')}
                </div>
              )}
              {turns.map((turn) => (
                <TranscriptTurn key={turn.id} turn={turn} />
              ))}
              {!eof && (
                <button
                  type="button"
                  onClick={() => void loadTranscript(selected, nextByte, true)}
                  disabled={loading}
                  style={{
                    display: "block",
                    margin: "12px auto 0",
                    padding: "4px 12px",
                    fontSize: 11,
                    background: "var(--border)",
                    border: "none",
                    borderRadius: 4,
                    color: "var(--text)",
                    cursor: "pointer",
                  }}
                >
                  {loading ? t('loading') : t('loadMore')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
            {active.length === 0 && history.length === 0 ? (
              <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
                {historyLoading ? t('loadingHistory') : t('noSubAgents')}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {active.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: "var(--text-muted)",
                        padding: "4px 8px",
                        letterSpacing: 0.3,
                      }}
                    >
                      {t('running')}
                    </div>
                    {active.map((s) => (
                      <SubagentListRow key={s.id} snapshot={s} onSelect={onSelectSubagent} />
                    ))}
                  </div>
                )}

                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "4px 8px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: "var(--text-muted)",
                        letterSpacing: 0.3,
                      }}
                    >
                      {t('history')}
                    </span>
                    {historyLoading && (
                      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t('loading')}</span>
                    )}
                  </div>
                  {history.length === 0 ? (
                    <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
                      {t('noHistory')}
                    </div>
                  ) : (
                    history.map((s) => (
                      <SubagentListRow key={s.id} snapshot={s} onSelect={onSelectSubagent} />
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
