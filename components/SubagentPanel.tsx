import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { RpcSubagentSnapshot, SubagentMessagesPage } from "@/lib/subagent-types";
import { isLiveSubagentStatus } from "@/lib/subagent-live";

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
      return "进行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "aborted":
      return "已中止";
    default:
      return "未知";
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

function SubagentListRow({
  snapshot,
  onSelect,
}: {
  snapshot: RpcSubagentSnapshot;
  onSelect: (id: string) => void;
}) {
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{snapshot.agent}</span>
        <span style={{ fontSize: 10, fontWeight: 600, color: statusColor(snapshot.status) }}>
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
        {snapshot.description || snapshot.task || "无描述"}
      </div>
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
  const [messages, setMessages] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [nextByte, setNextByte] = useState<number>(0);
  const [eof, setEof] = useState<boolean>(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selected = subagents.find((s) => s.id === selectedSubagentId) ?? null;

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
      setMessages((prev) => (append ? prev + page.content : page.content));
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
      setMessages("");
      setNextByte(0);
      setEof(true);
    }
  }, [selected, loadTranscript]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div
      style={{
        width: 320,
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
        <span style={{ fontSize: 14, fontWeight: 700 }}>子代理</span>
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
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                  {selected.agent}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: "var(--bg-panel)",
                    color: statusColor(selected.status),
                    fontWeight: 600,
                  }}
                >
                  {statusLabel(selected.status)}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4 }}>
                {selected.description || selected.task || "无描述"}
              </div>
              {selected.progress && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-dim)" }}>
                    <span>进度</span>
                    <span>
                      {selected.progress.recentTools && selected.progress.recentTools.length > 0
                        ? `${selected.progress.recentTools.length} 次工具调用`
                        : ""}
                    </span>
                  </div>
                  {selected.progress.requests !== undefined && (
                    <div style={{ fontSize: 10, color: "var(--text-muted)", fontStyle: "italic" }}>
                      请求数: {selected.progress.requests} | 工具调用: {selected.progress.toolCount}
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
                返回列表
              </button>
            </div>

            <div
              ref={scrollRef}
              style={{
                flex: 1,
                padding: 16,
                overflowY: "auto",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.5,
                background: "var(--bg)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {loading && messages.length === 0 && (
                <div style={{ color: "var(--text-dim)", textAlign: "center" }}>加载中…</div>
              )}
              {error && (
                <div style={{ color: "#ef4444", textAlign: "center", padding: 8 }}>{error}</div>
              )}
              {messages || (!loading && "无对话记录")}
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
                  {loading ? "加载中…" : "加载更多"}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
            {active.length === 0 && history.length === 0 ? (
              <div style={{ padding: "16px 12px", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>
                {historyLoading ? "加载历史…" : "暂无子代理"}
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
                      进行中
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
                      历史
                    </span>
                    {historyLoading && (
                      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>加载中…</span>
                    )}
                  </div>
                  {history.length === 0 ? (
                    <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
                      暂无历史记录
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
