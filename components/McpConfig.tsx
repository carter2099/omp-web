"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import type {
  McpServerInfo,
  McpListResponse,
  McpServerConfigInput,
  McpProbeResult,
} from "@/lib/api-types";

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function serverKey(server: McpServerInfo): string {
  return `${server.scope}\0${server.name}\0${server.sourcePath}`;
}

function statusColor(server: McpServerInfo): string {
  if (server.effectiveForRuntime) return "#10b981"; // Green - active
  if (server.configuredEnabled && server.shadowed) return "#f59e0b"; // Orange - shadowed
  return "var(--text-dim)"; // Gray - disabled
}

function buttonStyle(disabled?: boolean, danger?: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: danger ? "rgba(239,68,68,0.08)" : "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: danger ? "#ef4444" : "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    opacity: disabled ? 0.5 : 1,
  };
}

function Toggle({
  enabled,
  loading,
  onToggle,
  label,
}: {
  enabled: boolean;
  loading: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      title={label}
      aria-label={label}
      aria-pressed={enabled}
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
        opacity: loading ? 0.65 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: enabled ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  );
}

function ScopeTag({ scope }: { scope: "user" | "project" | "external" }) {
  let label = "外部";
  let bg = "rgba(120,120,120,0.12)";
  let color = "var(--text-dim)";
  if (scope === "project") {
    label = "项目";
    bg = "rgba(99,102,241,0.12)";
    color = "rgba(99,102,241,0.85)";
  } else if (scope === "user") {
    label = "全局";
    bg = "rgba(16,185,129,0.12)";
    color = "rgba(16,185,129,0.85)";
  }
  return (
    <span
      style={{
        fontSize: 10,
        padding: "1px 5px",
        borderRadius: 3,
        flexShrink: 0,
        background: bg,
        color: color,
      }}
    >
      {label}
    </span>
  );
}

function StatusTags({ server }: { server: McpServerInfo }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {server.configuredEnabled ? (
        <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: "rgba(16,185,129,0.12)", color: "#10b981" }}>
          已启用
        </span>
      ) : (
        <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: "rgba(239,68,68,0.12)", color: "#ef4444" }}>
          已禁用
        </span>
      )}
      
      {server.effectiveForRuntime ? (
        <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: "rgba(16,185,129,0.12)", color: "#10b981" }}>
          运行时生效
        </span>
      ) : server.shadowed ? (
        <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: "rgba(245,158,11,0.12)", color: "#d97706" }}>
          被遮蔽
        </span>
      ) : null}
    </div>
  );
}

function ProbeDetail({ result }: { result: McpProbeResult }) {
  const statusColor = result.status === "ok" ? "#10b981" : "#ef4444";
  const statusLabel = {
    ok: "成功",
    fail: "失败",
    timeout: "超时",
    fail_clean: "干净失败",
  }[result.status] || result.status;

  return (
    <div style={{ marginTop: 12, border: "1px solid var(--border)", borderRadius: 6, padding: 12, background: "var(--bg-panel)" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
        最后测试结果 (测试连接)
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: "6px 12px", fontSize: 12 }}>
        <div style={{ color: "var(--text-dim)" }}>状态</div>
        <div style={{ color: statusColor, fontWeight: 600 }}>{statusLabel}</div>
        
        {result.toolCount !== undefined && (
          <>
            <div style={{ color: "var(--text-dim)" }}>工具数量</div>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{result.toolCount}</div>
          </>
        )}
        
        {result.tools && result.tools.length > 0 && (
          <>
            <div style={{ color: "var(--text-dim)" }}>提供工具</div>
            <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, wordBreak: "break-all" }}>
              {result.tools.join(", ")}
            </div>
          </>
        )}

        {result.error && (
          <>
            <div style={{ color: "var(--text-dim)" }}>错误信息</div>
            <div style={{ color: "#ef4444", fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "pre-wrap", gridColumn: "1 / -1", marginTop: 4, background: "rgba(239,68,68,0.04)", padding: 8, borderRadius: 4, border: "1px dashed rgba(239,68,68,0.2)" }}>
              {result.error}
            </div>
          </>
        )}
        
        <div style={{ color: "var(--text-dim)" }}>耗时</div>
        <div style={{ color: "var(--text-muted)" }}>{result.durationMs} ms</div>
      </div>
    </div>
  );
}

function SegmentedScope({
  value,
  onChange,
}: {
  value: "user" | "project";
  onChange: (scope: "user" | "project") => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--border)",
        borderRadius: 7,
        overflow: "hidden",
        height: 30,
      }}
    >
      {(["user", "project"] as const).map((scope) => {
        const active = value === scope;
        return (
          <button
            key={scope}
            type="button"
            onClick={() => onChange(scope)}
            style={{
              width: 76,
              border: "none",
              borderRight: scope === "user" ? "1px solid var(--border)" : "none",
              background: active ? "var(--bg-selected)" : "none",
              color: active ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {scope === "user" ? "全局" : "项目"}
          </button>
        );
      })}
    </div>
  );
}

function SegmentedTransport({
  value,
  onChange,
}: {
  value: "stdio" | "http";
  onChange: (transport: "stdio" | "http") => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--border)",
        borderRadius: 7,
        overflow: "hidden",
        height: 30,
      }}
    >
      {(["stdio", "http"] as const).map((t) => {
        const active = value === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            style={{
              width: 76,
              border: "none",
              borderRight: t === "stdio" ? "1px solid var(--border)" : "none",
              background: active ? "var(--bg-selected)" : "none",
              color: active ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {t === "stdio" ? "stdio" : "http"}
          </button>
        );
      })}
    </div>
  );
}

export function McpConfig({
  cwd,
  onClose,
}: {
  cwd: string;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const [data, setData] = useState<McpListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  
  // Form and action states
  const [formMode, setFormMode] = useState<"add" | "edit" | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"user" | "project">("project");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [envText, setEnvText] = useState("");
  
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const servers = useMemo(() => data?.servers ?? [], [data?.servers]);
  const selectedServer = useMemo(() => {
    return servers.find((s) => serverKey(s) === selected) ?? null;
  }, [servers, selected]);

  const groupedServers = useMemo(() => {
    return ([
      { scope: "project", label: "项目" },
      { scope: "user", label: "全局" },
      { scope: "external", label: "外部" },
    ] as const)
      .map((g) => ({
        ...g,
        servers: servers.filter((s) => s.scope === g.scope),
      }))
      .filter((g) => g.servers.length > 0);
  }, [servers]);

  const loadMcpServers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/mcp?cwd=${encodeURIComponent(cwd)}`);
      const next = (await res.json()) as McpListResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setSelected((current) => {
        if (current && next.servers.some((s) => serverKey(s) === current)) return current;
        return next.servers[0] ? serverKey(next.servers[0]) : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadMcpServers();
  }, [loadMcpServers]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleToggleEnable = useCallback(async (server: McpServerInfo) => {
    const key = serverKey(server);
    const action = server.configuredEnabled ? "disable" : "enable";
    setBusyKey(`${action}:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          cwd,
          name: server.name,
          sourcePath: server.sourcePath,
        }),
      });
      const next = (await res.json()) as McpListResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setActionMessage(action === "enable" ? "服务器已启用。" : "服务器已禁用。");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [cwd]);

  const handleRemove = useCallback(async (server: McpServerInfo) => {
    if (!window.confirm(`确定要删除服务器 "${server.name}" 吗？`)) return;
    const key = serverKey(server);
    setBusyKey(`remove:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "remove",
          cwd,
          name: server.name,
          scope: server.scope === "user" ? "user" : "project",
        }),
      });
      const next = (await res.json()) as McpListResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setActionMessage("服务器已成功删除。");
      setSelected(next.servers[0] ? serverKey(next.servers[0]) : null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [cwd]);

  const handleProbe = useCallback(async (server: McpServerInfo) => {
    const key = serverKey(server);
    setBusyKey(`probe:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "probe",
          cwd,
          name: server.name,
          sourcePath: server.sourcePath,
        }),
      });
      const next = (await res.json()) as McpListResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setActionMessage("连接测试完成。");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [cwd]);

  const startAdd = useCallback(() => {
    setName("");
    setScope("project");
    setTransport("stdio");
    setCommand("");
    setArgs("");
    setUrl("");
    setEnvText("");
    setActionError(null);
    setActionMessage(null);
    setFormMode("add");
  }, []);

  const startEdit = useCallback((server: McpServerInfo) => {
    setName(server.name);
    setScope(server.scope === "user" ? "user" : "project");
    setTransport(server.transport === "http" || server.transport === "sse" ? "http" : "stdio");
    setCommand(server.command ?? "");
    setArgs(server.args?.join(" ") ?? "");
    setUrl(server.url ?? "");
    setEnvText("");
    setActionError(null);
    setActionMessage(null);
    setFormMode("edit");
  }, []);

  const handleSave = useCallback(async () => {
    if (!name.trim()) return;
    const isAdd = formMode === "add";
    setBusyKey(isAdd ? "add" : "update");
    setActionError(null);
    setActionMessage(null);
    try {
      const config: McpServerConfigInput = {
        type: transport,
      };
      if (transport === "stdio") {
        config.command = command.trim();
        config.args = args.trim() ? args.trim().split(/\s+/) : [];
        if (isAdd && envText.trim()) {
          const env: Record<string, string> = {};
          const lines = envText.split("\n");
          for (const line of lines) {
            const idx = line.indexOf("=");
            if (idx !== -1) {
              const k = line.substring(0, idx).trim();
              const v = line.substring(idx + 1).trim();
              if (k) env[k] = v;
            }
          }
          config.env = env;
        }
      } else {
        config.url = url.trim();
      }

      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: isAdd ? "add" : "update",
          cwd,
          name: name.trim(),
          scope,
          config,
          sourcePath: isAdd ? undefined : selectedServer?.sourcePath,
        }),
      });
      const next = (await res.json()) as McpListResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setActionMessage(isAdd ? "服务器添加成功。" : "服务器配置更新成功。");
      setFormMode(null);
      const targetName = name.trim();
      const added = next.servers.find((s) => s.name === targetName && s.scope === scope);
      if (added) setSelected(serverKey(added));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [formMode, name, scope, transport, command, args, envText, cwd, selectedServer]);

  const busy = busyKey !== null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 860,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "76vh",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>
              MCP 服务器
            </span>
            <code
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {shortenPath(cwd)}
            </code>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 20,
              lineHeight: 1,
              padding: "2px 6px",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          {/* Left list panel */}
          <div
            style={{
              width: isMobile ? "100%" : 245,
              maxHeight: isMobile ? "40vh" : undefined,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              borderBottom: isMobile ? "1px solid var(--border)" : "none",
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
              background: "var(--bg-panel)",
            }}
          >
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {loading ? (
                <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                  加载中…
                </div>
              ) : error ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "#ef4444" }}>
                  {error}
                </div>
              ) : servers.length === 0 ? (
                <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                  未配置 MCP 服务器
                </div>
              ) : (
                groupedServers.map((group) => (
                  <div key={group.scope} style={{ marginBottom: 6 }}>
                    <div
                      style={{
                        padding: "4px 8px 3px",
                        fontSize: 10,
                        fontWeight: 600,
                        color: "var(--text-dim)",
                        textTransform: "uppercase",
                      }}
                    >
                      {group.label}
                    </div>
                    {group.servers.map((server) => {
                      const key = serverKey(server);
                      const isSelected = formMode === null && selected === key;
                      return (
                        <div
                          key={key}
                          onClick={() => {
                            setSelected(key);
                            setFormMode(null);
                            setActionError(null);
                            setActionMessage(null);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            padding: "8px 8px",
                            borderRadius: 5,
                            cursor: "pointer",
                            background: isSelected ? "var(--bg-selected)" : "none",
                          }}
                          onMouseEnter={(e) => {
                            if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            if (!isSelected) e.currentTarget.style.background = "none";
                          }}
                        >
                          <span
                            style={{
                              flexShrink: 0,
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              background: statusColor(server),
                            }}
                          />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: isSelected ? 600 : 400,
                                color: "var(--text)",
                                fontFamily: "var(--font-mono)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {server.name}
                            </div>
                            <div
                              style={{
                                fontSize: 10,
                                color: "var(--text-dim)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                marginTop: 2,
                              }}
                            >
                              {server.transport === "stdio" ? "stdio" : "http"} · {shortenPath(server.sourcePath)}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
            
            {/* Add server button */}
            <div style={{ padding: "8px 6px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
              <button
                type="button"
                onClick={startAdd}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 8px",
                  borderRadius: 5,
                  border: "none",
                  width: "100%",
                  cursor: "pointer",
                  background: formMode === "add" ? "var(--bg-selected)" : "none",
                  color: formMode === "add" ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 12,
                }}
                onMouseEnter={(e) => {
                  if (formMode !== "add") e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (formMode !== "add") e.currentTarget.style.background = "none";
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                添加服务器
              </button>
            </div>
          </div>

          {/* Right panel */}
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {formMode === "add" || formMode === "edit" ? (
              /* Add or Edit Form */
              <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 660, minHeight: "100%" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                    {formMode === "add" ? "添加 MCP 服务器" : "编辑 MCP 服务器"}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                    {formMode === "add" ? "配置本地执行环境或外部连接" : `编辑 "${name}" 的属性配置`}
                  </div>
                </div>

                {/* Name field (disabled for Edit) */}
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <label htmlFor="mcp-name" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
                    名称
                  </label>
                  <input
                    id="mcp-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={formMode === "edit"}
                    placeholder="e.g. filesystem"
                    style={{
                      width: "100%",
                      height: 36,
                      padding: "0 11px",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      background: "var(--bg-panel)",
                      color: formMode === "edit" ? "var(--text-dim)" : "var(--text)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 13,
                      outline: "none",
                    }}
                  />
                </div>

                {/* Scope (segmented selector, disabled for Edit) */}
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
                    作用域
                  </span>
                  {formMode === "edit" ? (
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {scope === "user" ? "全局 (user)" : "项目 (project)"}
                    </div>
                  ) : (
                    <SegmentedScope value={scope} onChange={setScope} />
                  )}
                </div>

                {/* Transport type (segmented selector) */}
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
                    传输类型
                  </span>
                  <SegmentedTransport value={transport} onChange={setTransport} />
                </div>

                {/* Conditional Transport Config */}
                {transport === "stdio" ? (
                  <>
                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      <label htmlFor="mcp-command" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
                        命令 (Command)
                      </label>
                      <input
                        id="mcp-command"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder="npx, python3, node..."
                        style={{
                          width: "100%",
                          height: 36,
                          padding: "0 11px",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          background: "var(--bg-panel)",
                          color: "var(--text)",
                          fontFamily: "var(--font-mono)",
                          fontSize: 13,
                          outline: "none",
                        }}
                      />
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                      <label htmlFor="mcp-args" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
                        参数 (Args，空格分隔)
                      </label>
                      <input
                        id="mcp-args"
                        value={args}
                        onChange={(e) => setArgs(e.target.value)}
                        placeholder="-y @modelcontextprotocol/server-everything"
                        style={{
                          width: "100%",
                          height: 36,
                          padding: "0 11px",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          background: "var(--bg-panel)",
                          color: "var(--text)",
                          fontFamily: "var(--font-mono)",
                          fontSize: 13,
                          outline: "none",
                        }}
                      />
                    </div>

                    {formMode === "add" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                        <label htmlFor="mcp-env" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
                          环境变量 (Env，每行 KEY=VALUE，可选)
                        </label>
                        <textarea
                          id="mcp-env"
                          value={envText}
                          onChange={(e) => setEnvText(e.target.value)}
                          placeholder="PATH=/usr/local/bin&#10;NODE_ENV=production"
                          rows={3}
                          style={{
                            width: "100%",
                            padding: "8px 11px",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            background: "var(--bg-panel)",
                            color: "var(--text)",
                            fontFamily: "var(--font-mono)",
                            fontSize: 13,
                            outline: "none",
                            resize: "vertical",
                          }}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <label htmlFor="mcp-url" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
                      URL (HTTP/SSE 连接地址)
                    </label>
                    <input
                      id="mcp-url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="http://localhost:3000/sse"
                      style={{
                        width: "100%",
                        height: 36,
                        padding: "0 11px",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        background: "var(--bg-panel)",
                        color: "var(--text)",
                        fontFamily: "var(--font-mono)",
                        fontSize: 13,
                        outline: "none",
                      }}
                    />
                  </div>
                )}

                {/* Form Actions */}
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={busy || !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())}
                    style={{
                      ...buttonStyle(busy),
                      background: "var(--accent)",
                      color: "white",
                      borderColor: "var(--accent)",
                    }}
                  >
                    {busy ? "保存中…" : "确定"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormMode(null)}
                    disabled={busy}
                    style={buttonStyle(busy)}
                  >
                    取消
                  </button>
                </div>

                {actionError && (
                  <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>
                    {actionError}
                  </div>
                )}
              </div>
            ) : selectedServer ? (
              /* Detail View */
              <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 680 }}>
                {/* Header Row */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, minWidth: 0, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1 }}>
                    <Toggle
                      enabled={selectedServer.configuredEnabled}
                      loading={busy}
                      onToggle={() => handleToggleEnable(selectedServer)}
                      label={selectedServer.configuredEnabled ? "禁用服务器" : "启用服务器"}
                    />
                    <ScopeTag scope={selectedServer.scope} />
                    <StatusTags server={selectedServer} />
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        color: "var(--text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {selectedServer.name}
                    </span>
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {selectedServer.scope !== "external" && (
                      <button
                        onClick={() => startEdit(selectedServer)}
                        disabled={busy}
                        style={buttonStyle(busy)}
                      >
                        编辑
                      </button>
                    )}
                    <button
                      onClick={() => handleProbe(selectedServer)}
                      disabled={busy}
                      style={buttonStyle(busy)}
                    >
                      {busyKey === `probe:${serverKey(selectedServer)}` ? "测试中…" : "测试连接"}
                    </button>
                    {selectedServer.scope !== "external" && (
                      <button
                        onClick={() => handleRemove(selectedServer)}
                        disabled={busy}
                        style={buttonStyle(busy, true)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>

                {/* Details Grid */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
                    gap: "9px 14px",
                    fontSize: 12,
                    lineHeight: 1.45,
                  }}
                >
                  <div style={{ color: "var(--text-dim)" }}>提供者 (Provider)</div>
                  <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                    {selectedServer.providerId}
                  </div>

                  <div style={{ color: "var(--text-dim)" }}>传输类型</div>
                  <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                    {selectedServer.transport}
                  </div>

                  {selectedServer.transport === "stdio" ? (
                    <>
                      <div style={{ color: "var(--text-dim)" }}>命令 (Command)</div>
                      <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                        {selectedServer.command ?? "无"}
                      </div>
                      
                      <div style={{ color: "var(--text-dim)" }}>参数 (Args)</div>
                      <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                        {selectedServer.args?.length ? selectedServer.args.join(" ") : "无"}
                      </div>

                      {selectedServer.envKeys.length > 0 && (
                        <>
                          <div style={{ color: "var(--text-dim)" }}>环境变量</div>
                          <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                            {selectedServer.envKeys.join(", ")}
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <div style={{ color: "var(--text-dim)" }}>URL</div>
                      <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                        {selectedServer.url ?? "无"}
                      </div>
                    </>
                  )}

                  <div style={{ color: "var(--text-dim)" }}>配置文件路径</div>
                  <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
                    {shortenPath(selectedServer.sourcePath)}
                  </div>
                </div>

                {/* Probe details if available */}
                {selectedServer.lastProbe && (
                  <ProbeDetail result={selectedServer.lastProbe} />
                )}

                {actionMessage && (
                  <div style={{ fontSize: 12, color: "#16a34a" }}>
                    {actionMessage}
                  </div>
                )}
                {actionError && (
                  <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>
                    {actionError}
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-dim)",
                  fontSize: 13,
                }}
              >
                选择或添加一个服务器
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 18px",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0, flex: 1, fontSize: 11, color: "var(--text-dim)", overflow: "hidden" }}>
            {data?.diagnostics.length ? (
              <span
                title={data.diagnostics.map((d) => `${d.type}: ${d.source ? `${d.source}: ` : ""}${d.message}`).join("\n")}
                style={{ color: data.diagnostics.some((d) => d.type === "error") ? "#ef4444" : "#d97706" }}
              >
                {data.diagnostics.length} 项诊断
              </span>
            ) : (
              <span>
                {data ? `已连接 ${servers.filter((s) => s.effectiveForRuntime).length} 个 MCP 服务 (共 ${servers.length} 个配置)` : ""}
              </span>
            )}
          </div>
          <button onClick={() => void loadMcpServers()} disabled={loading || busy} style={buttonStyle(loading || busy)}>
            刷新
          </button>
          <button onClick={onClose} style={buttonStyle(false)}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
