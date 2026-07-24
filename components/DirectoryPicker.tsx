"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";

type BrowseEntry = { name: string; path: string };

type BrowseResponse = {
  path?: string;
  parent?: string | null;
  home?: string;
  entries?: BrowseEntry[];
  error?: string;
};

interface Props {
  /** Starting directory; falls back to server home */
  initialPath?: string;
  selecting?: boolean;
  error?: string | null;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

const listBtn: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "5px 8px",
  background: "none",
  border: "none",
  borderRadius: 4,
  color: "var(--text)",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
};

function FolderIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, color: "var(--text-muted)" }}
    >
      <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
    </svg>
  );
}

export function DirectoryPicker({
  initialPath,
  selecting = false,
  error = null,
  onSelect,
  onCancel,
}: Props) {
  const [currentPath, setCurrentPath] = useState(initialPath ?? "");
  const [parent, setParent] = useState<string | null>(null);
  const [home, setHome] = useState("");
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValue, setManualValue] = useState("");

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setBrowseError(null);
    try {
      const qs = path ? `?path=${encodeURIComponent(path)}` : "";
      const res = await fetch(`/api/cwd/browse${qs}`);
      const data = (await res.json().catch(() => ({}))) as BrowseResponse;
      if (!res.ok || data.error) {
        setBrowseError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setCurrentPath(data.path ?? path ?? "");
      setParent(data.parent ?? null);
      setHome(data.home ?? "");
      setEntries(data.entries ?? []);
    } catch (e) {
      setBrowseError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initialPath);
  }, [initialPath, load]);

  const displayPath = (p: string) => {
    if (home && p.startsWith(home)) return "~" + p.slice(home.length);
    return p;
  };

  return (
    <div
      style={{ padding: "6px 8px" }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: "var(--text-dim)",
          marginBottom: 4,
          fontWeight: 600,
          letterSpacing: "0.02em",
        }}
      >
        浏览目录
      </div>

      {/* Current path + up */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          marginBottom: 6,
        }}
      >
        <button
          type="button"
          title="上级目录"
          disabled={!parent || loading || selecting}
          onClick={() => parent && void load(parent)}
          style={{
            ...listBtn,
            width: "auto",
            padding: "4px 6px",
            border: "1px solid var(--border)",
            background: "var(--bg-hover)",
            opacity: !parent || loading || selecting ? 0.45 : 1,
            cursor: !parent || loading || selecting ? "not-allowed" : "pointer",
            flexShrink: 0,
          }}
        >
          ↑
        </button>
        {home && (
          <button
            type="button"
            title="主目录"
            disabled={loading || selecting || currentPath === home}
            onClick={() => void load(home)}
            style={{
              ...listBtn,
              width: "auto",
              padding: "4px 6px",
              border: "1px solid var(--border)",
              background: "var(--bg-hover)",
              opacity: loading || selecting || currentPath === home ? 0.45 : 1,
              cursor:
                loading || selecting || currentPath === home
                  ? "not-allowed"
                  : "pointer",
              flexShrink: 0,
              fontSize: 10,
            }}
          >
            ~
          </button>
        )}
        <div
          title={currentPath}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            padding: "4px 6px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 4,
          }}
        >
          {currentPath ? displayPath(currentPath) : "…"}
        </div>
      </div>

      {/* Directory list */}
      <div
        style={{
          maxHeight: 180,
          overflowY: "auto",
          border: "1px solid var(--border)",
          borderRadius: 5,
          background: "var(--bg)",
          marginBottom: 6,
        }}
      >
        {loading && (
          <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
            加载中…
          </div>
        )}
        {!loading && entries.length === 0 && (
          <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
            此目录下没有子文件夹
          </div>
        )}
        {!loading &&
          entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              disabled={selecting}
              onClick={() => void load(entry.path)}
              onDoubleClick={() => void load(entry.path)}
              style={{
                ...listBtn,
                borderBottom: "1px solid var(--border)",
                borderRadius: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
              }}
            >
              <FolderIcon />
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {entry.name}
              </span>
            </button>
          ))}
      </div>

      {(browseError || error) && (
        <div
          style={{
            marginBottom: 6,
            color: "#dc2626",
            fontSize: 11,
            lineHeight: 1.35,
            overflowWrap: "anywhere",
          }}
        >
          {error ?? browseError}
        </div>
      )}

      <div style={{ display: "flex", gap: 5, marginBottom: 4 }}>
        <button
          type="button"
          onClick={() => currentPath && onSelect(currentPath)}
          disabled={selecting || !currentPath || loading}
          style={{
            flex: 1,
            padding: "5px 0",
            background: "var(--accent)",
            border: "none",
            borderRadius: 5,
            color: "#fff",
            fontSize: 11,
            fontWeight: 600,
            cursor:
              selecting || !currentPath || loading ? "not-allowed" : "pointer",
            opacity: selecting || !currentPath || loading ? 0.65 : 1,
          }}
        >
          {selecting ? "正在打开…" : "选择此目录"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={selecting}
          style={{
            flex: 1,
            padding: "5px 0",
            background: "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            color: "var(--text-muted)",
            fontSize: 11,
            cursor: selecting ? "not-allowed" : "pointer",
          }}
        >
          取消
        </button>
      </div>

      {/* Advanced: manual path (collapsed) */}
      <button
        type="button"
        onClick={() => setManualOpen((v) => !v)}
        style={{
          background: "none",
          border: "none",
          padding: "2px 0",
          fontSize: 10,
          color: "var(--text-dim)",
          cursor: "pointer",
          textDecoration: "underline",
          textUnderlineOffset: 2,
        }}
      >
        {manualOpen ? "收起手动输入" : "手动输入路径…"}
      </button>
      {manualOpen && (
        <div style={{ marginTop: 4, display: "flex", gap: 4 }}>
          <input
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const p = manualValue.trim();
                if (p) void load(p);
              }
            }}
            placeholder="~/projects/foo"
            style={{
              flex: 1,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              padding: "4px 6px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              outline: "none",
              background: "var(--bg)",
              color: "var(--text)",
              minWidth: 0,
            }}
          />
          <button
            type="button"
            onClick={() => {
              const p = manualValue.trim();
              if (p) void load(p);
            }}
            style={{
              padding: "4px 8px",
              fontSize: 10,
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: "var(--bg-hover)",
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            跳转
          </button>
        </div>
      )}
    </div>
  );
}
