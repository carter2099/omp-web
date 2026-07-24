export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

export type SkillInstallScope = "global" | "project";

export interface SkillInstallInfo {
  package: string;
  scope: SkillInstallScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  canCheckForUpdates: boolean;
}

export type SkillUpdateState =
  | "up-to-date"
  | "update-available"
  | "unsupported"
  | "error";

export interface SkillUpdateResult {
  package: string;
  scope: SkillInstallScope;
  state: SkillUpdateState;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  install?: SkillInstallInfo;
}

export type PluginScope = "global" | "project";
export type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";

export interface PluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface PluginDiagnostic {
  type: "warning" | "error";
  message: string;
  source?: string;
  path?: string;
}

export interface PluginResourceInfo {
  kind: PluginResourceKind;
  name: string;
  path: string;
  relativePath: string;
}

export interface PluginPackageInfo {
  source: string;
  scope: PluginScope;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
  status: "loaded" | "installed" | "missing" | "disabled";
}

export interface PathExtensionInfo {
  path: string;
  configuredPath: string;
  packageName?: string;
  version?: string;
  entrypoints: string[];
  exists: boolean;
  status: "loaded" | "missing" | "invalid";
}

export interface PluginsResponse {
  packages: PluginPackageInfo[];
  pathExtensions: PathExtensionInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
}

/** Identity for one MCP inventory row (may share name with shadowed peers). */
export type McpRowId = {
  name: string;
  scope: "user" | "project" | "external";
  sourcePath: string;
  providerId: string;
  shadowed: boolean;
};

export type McpTransportType = "stdio" | "http" | "sse";

/** Redacted outbound MCP server DTO — never includes raw secrets. */
export type McpServerInfo = McpRowId & {
  transport: McpTransportType;
  command?: string;
  args?: string[];
  argsRedacted: boolean;
  cwd?: string;
  url?: string;
  urlRedacted: boolean;
  envKeys: string[];
  hasEnv: boolean;
  headerKeys: string[];
  hasHeaders: boolean;
  hasAuth: boolean;
  hasOauth: boolean;
  timeout?: number;
  /** Configured as enabled (not denylisted / settings-disabled / enabled:false). */
  configuredEnabled: boolean;
  /** Would connect at runtime (false when shadowed). */
  effectiveForRuntime: boolean;
  lastProbe?: McpProbeResult;
};

export type McpProbeStatus = "ok" | "fail" | "timeout" | "fail_clean";

export type McpProbeResult = {
  status: McpProbeStatus;
  toolCount?: number;
  tools?: string[];
  error?: string;
  durationMs: number;
};

export type McpWritableScope = "user" | "project";

export type McpServerConfigInput = {
  type?: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: {
    type: "oauth" | "apikey";
    credentialId?: string;
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
    resource?: string;
  };
  oauth?: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    callbackPort?: number;
    callbackPath?: string;
    prompt?: string;
  };
  enabled?: boolean;
  timeout?: number;
};

export type McpAction =
  | "add"
  | "update"
  | "remove"
  | "enable"
  | "disable"
  | "probe";

export type McpListResponse = {
  servers: McpServerInfo[];
  diagnostics: PluginDiagnostic[];
};
