// Registry of MCP-compatible IDE tools with detection paths and config formats
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

function computeRoot() {
  const repoPath = join(homedir(), "MCP-CLICKUP");
  if (existsSync(join(repoPath, "dist", "index.js"))) return repoPath;
  const scriptRoot = join(__dirname, "..");
  if (existsSync(join(scriptRoot, "dist", "index.js"))) return scriptRoot;
  return scriptRoot;
}

export const ROOT = computeRoot();

export const TARGET_REGISTRY = [
  {
    id: "opencode",
    name: "OpenCode",
    configPath: join(homedir(), ".config", "opencode", "opencode.json"),
    format: "command-array",
    detectPaths: [
      join(homedir(), ".config", "opencode", "opencode.json"),
      join(homedir(), ".config", "opencode", "opencode.jsonc"),
    ],
    writable: true,
  },
  {
    id: "antigravity",
    name: "Antigravity (Google)",
    configPath: join(homedir(), ".gemini", "config", "mcp_config.json"),
    format: "command-string+args",
    detectPaths: [join(homedir(), ".gemini", "config", "mcp_config.json")],
    writable: true,
  },
  {
    id: "cursor",
    name: "Cursor",
    configPath: join(homedir(), ".cursor", "mcp.json"),
    format: "command-string+args",
    detectPaths: [join(homedir(), ".cursor", "mcp.json")],
    writable: true,
  },
  {
    id: "vscode-copilot",
    name: "VS Code Copilot",
    configPath: join(homedir(), ".config", "Code", "User", "globalStorage", "storage.json"),
    format: "servers-key",
    detectPaths: [join(homedir(), ".config", "Code", "User", "globalStorage", "storage.json")],
    writable: true,
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    configPath: join(homedir(), ".config", "claude", "desktop.json"),
    format: "command-string+args",
    detectPaths: [join(homedir(), ".config", "claude", "desktop.json")],
    writable: true,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    configPath: join(homedir(), ".claude", "settings.json"),
    format: "command-string+args",
    detectPaths: [join(homedir(), ".claude", "settings.json")],
    writable: true,
  },
  {
    id: "n8n",
    name: "n8n",
    configPath: null,
    format: "instructions-only",
    detectPaths: [],
    writable: false,
  },
  {
    id: "codex",
    name: "Codex",
    configPath: null,
    format: "instructions-only",
    detectPaths: [],
    writable: false,
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    configPath: join(homedir(), ".config", "chatgpt", "mcp.json"),
    format: "command-string+args",
    detectPaths: [join(homedir(), ".config", "chatgpt", "mcp.json")],
    writable: true,
  },
  {
    id: "augment",
    name: "Augment",
    configPath: join(homedir(), ".augment", "mcp.json"),
    format: "command-string+args",
    detectPaths: [join(homedir(), ".augment", "mcp.json")],
    writable: true,
  },
  {
    id: "auggie",
    name: "Auggie",
    configPath: join(homedir(), ".auggie", "mcp.json"),
    format: "command-string+args",
    detectPaths: [join(homedir(), ".auggie", "mcp.json")],
    writable: true,
  },
  {
    id: "windsurf",
    name: "Windsurf",
    configPath: join(homedir(), ".windsurf", "mcp_config.json"),
    format: "command-string+args",
    detectPaths: [join(homedir(), ".windsurf", "mcp_config.json")],
    writable: true,
  },
  {
    id: "roo-code",
    name: "Roo Code",
    configPath: join(homedir(), ".roo", "mcp.json"),
    format: "command-string+args",
    detectPaths: [join(homedir(), ".roo", "mcp.json")],
    writable: true,
  },
  {
    id: "add-agent",
    name: "Add Agent (generic)",
    configPath: null,
    format: "instructions-only",
    detectPaths: [],
    writable: false,
  },
];

export function detectAllTargets() {
  return TARGET_REGISTRY.map((target) => {
    if (!target.detectPaths || target.detectPaths.length === 0) {
      return { ...target, found: false, path: null };
    }
    const foundPath = target.detectPaths.find(existsSync);
    return { ...target, found: !!foundPath, path: foundPath || null };
  });
}
