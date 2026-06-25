// Safe JSON read-modify-write MCP config updater with injectable deps
import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  mkdirSync as fsMkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";

const Dim = "\x1b[2m";
const Reset = "\x1b[0m";

const FORMAT_KEYS = {
  "command-array": "mcp",
  "command-string+args": "mcpServers",
  "servers-key": "servers",
};

const FORMAT_SERVER_ENTRY = {
  "command-array": (cmd) => ({
    command: cmd.command,
    args: cmd.args,
    type: "local",
    description: "MCP server para ClickUp — crear tareas y descubrir estructura",
  }),
  "command-string+args": (cmd) => cmd,
  "servers-key": (cmd) => cmd,
};

/**
 * Upsert the clickup MCP entry into a tool's config file.
 *
 * @param {object} target - TARGET_REGISTRY entry (must have configPath, format, writable)
 * @param {string} root - Project root path where dist/index.js lives
 * @param {object} [deps] - Injectable fs overrides for testing (defaults to node:fs)
 * @param {Function} [deps.existsSync]
 * @param {Function} [deps.readFileSync]
 * @param {Function} [deps.writeFileSync]
 * @param {Function} [deps.mkdirSync]
 * @returns {{ ok: boolean, error?: string }}
 */
export function upsertMcpConfig(target, root, deps) {
  const {
    existsSync = fsExistsSync,
    readFileSync = fsReadFileSync,
    writeFileSync = fsWriteFileSync,
    mkdirSync = fsMkdirSync,
  } = deps || {};

  if (!target.writable) {
    return { ok: false, error: "not writable" };
  }

  if (!target.configPath) {
    return { ok: false, error: "no config path" };
  }

  let config = {};

  if (existsSync(target.configPath)) {
    const content = readFileSync(target.configPath, "utf-8").trim();
    if (content) {
      try {
        config = JSON.parse(content);
      } catch (e) {
        console.error(`  ${Dim}⚠ JSON corrupto en ${target.configPath} — omitiendo${Reset}`);
        return { ok: false, error: `Malformed JSON: ${e.message}` };
      }
    }
  } else {
    // Create parent dirs before writing
    mkdirSync(dirname(target.configPath), { recursive: true });
  }

  const key = FORMAT_KEYS[target.format];
  if (!config[key]) config[key] = {};

  const serverEntry = FORMAT_SERVER_ENTRY[target.format]({
    command: "node",
    args: [join(root, "dist", "index.js")],
  });
  config[key].clickup = serverEntry;

  // Validate before write: ensure serialization round-trips without error
  try {
    JSON.parse(JSON.stringify(config));
  } catch (e) {
    console.error(`  ${Dim}⚠ Validación falló para ${target.configPath} — omitiendo${Reset}`);
    return { ok: false, error: `Validation failed: ${e.message}` };
  }

  writeFileSync(target.configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { ok: true };
}

export { FORMAT_KEYS, FORMAT_SERVER_ENTRY };
