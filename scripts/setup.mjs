#!/usr/bin/env node

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_ROOT = join(__dirname, "..");

// Detect canonical installation path: prefer cloned repo over npx cache
function findInstallPath() {
  // Check if we're in the known cloned repo
  const repoPath = join(homedir(), "MCP-CLICKUP");
  if (existsSync(join(repoPath, "dist", "index.js"))) return repoPath;
  // Fall back to script location
  if (existsSync(join(SCRIPT_ROOT, "dist", "index.js"))) return SCRIPT_ROOT;
  return SCRIPT_ROOT;
}
const ROOT = findInstallPath();

// ── Colors ─────────────────────────────────────────────────────────

const Reset = "\x1b[0m";
const Bold = "\x1b[1m";
const Green = "\x1b[32m";
const Yellow = "\x1b[33m";
const Cyan = "\x1b[36m";
const Dim = "\x1b[2m";

// ── Input ──────────────────────────────────────────────────────────

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// ── Steps ──────────────────────────────────────────────────────────

function printBanner() {
  console.log(`
${Cyan}╔══════════════════════════════════════╗
║   ${Bold}MCP ClickUp Server — Setup${Reset}${Cyan}      ║
╚══════════════════════════════════════╝${Reset}
`);
}

async function collectApiKey() {
  console.log(`${Bold}Paso 1: API Key de ClickUp${Reset}`);
  console.log(`  Obtenela en: ${Cyan}https://app.clickup.com/settings/apps${Reset}`);
  console.log(`  ${Dim}(Personal API Token, la que empieza con pk_)${Reset}\n`);

  let key = "";
  while (!key) {
    key = await ask("  ➜ Ingresá tu ClickUp API Key: ");
  }
  return key;
}

function saveApiKey(key) {
  console.log(`\n${Bold}Paso 2: Guardando API key${Reset}`);

  // Global: ~/.config/mcp-clickup-server/.env
  const globalDir = join(homedir(), ".config", "mcp-clickup-server");
  const globalEnv = join(globalDir, ".env");
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(globalEnv, `CLICKUP_API_KEY=${key}\n`, "utf-8");
  console.log(`  ✅ ${Green}Global: ${globalEnv}${Reset}`);

  // Local: ./.env
  const localEnv = join(ROOT, ".env");
  writeFileSync(localEnv, `CLICKUP_API_KEY=${key}\n`, "utf-8");
  console.log(`  ✅ ${Green}Local: ${localEnv}${Reset}`);
}

function installDeps() {
  console.log(`\n${Bold}Paso 3: Instalando dependencias${Reset}`);
  execSync("npm install", { cwd: ROOT, stdio: "inherit" });
  console.log(`  ✅ ${Green}Dependencias instaladas${Reset}`);
}

function buildProject() {
  const distIndex = join(ROOT, "dist", "index.js");
  if (existsSync(distIndex)) {
    console.log(`\n${Bold}Paso 4: Server ya compilado, omitiendo build${Reset}`);
    return;
  }
  console.log(`\n${Bold}Paso 4: Compilando TypeScript${Reset}`);
  execSync("npx tsc", { cwd: ROOT, stdio: "inherit" });
  console.log(`  ✅ ${Green}Build completado${Reset}`);
}

// ── MCP config entries ─────────────────────────────────────────────

function openCodeEntry() {
  return {
    command: ["node", join(ROOT, "dist", "index.js")],
    type: "local",
    description: "MCP server para ClickUp — crear tareas y descubrir estructura",
  };
}

function antigravityEntry() {
  return {
    command: "node",
    args: [join(ROOT, "dist", "index.js")],
  };
}

// ── Platform detection ─────────────────────────────────────────────

const OPENCODE_PATHS = [
  join(homedir(), ".config", "opencode", "opencode.json"),
  join(homedir(), ".config", "opencode", "opencode.jsonc"),
  join(ROOT, "..", "opencode.json"),
  join(ROOT, "..", "opencode.jsonc"),
];

const ANTIGRAVITY_PATH = join(homedir(), ".gemini", "config", "mcp_config.json");

function detectPlatforms() {
  const platforms = [];

  // Detect OpenCode
  const openCodeConfig = OPENCODE_PATHS.find(existsSync);
  if (openCodeConfig) {
    platforms.push({ name: "OpenCode", type: "opencode", path: openCodeConfig });
    console.log(`  ${Dim}✓ Detectado: OpenCode (${openCodeConfig})${Reset}`);
  }

  // Detect Antigravity
  if (existsSync(ANTIGRAVITY_PATH)) {
    platforms.push({ name: "Antigravity (Google)", type: "antigravity", path: ANTIGRAVITY_PATH });
    console.log(`  ${Dim}✓ Detectado: Antigravity (${ANTIGRAVITY_PATH})${Reset}`);
  }

  return platforms;
}

// ── Registry ───────────────────────────────────────────────────────

function registerInOpenCode(configPath, key) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8") || "{}");
  } catch { /* file will be created */ }

  if (!config.mcp) config.mcp = {};
  config.mcp.clickup = openCodeEntry();

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(`  ✅ ${Green}Registrado en OpenCode${Reset}`);
}

function registerInAntigravity(configPath) {
  let config = {};
  try {
    const content = readFileSync(configPath, "utf-8").trim();
    config = content ? JSON.parse(content) : {};
  } catch { /* file will be created */ }

  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers.clickup = antigravityEntry();

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(`  ✅ ${Green}Registrado en Antigravity${Reset}`);
}

function printManualInstructions() {
  console.log(`\n${Yellow}⚠ No se detectó OpenCode ni Antigravity.${Reset}`);
  console.log(`\n  Configuración manual para OpenCode:`);
  console.log(`  ${Dim}${JSON.stringify({ mcp: { clickup: openCodeEntry() } }, null, 2)}${Reset}`);
  console.log(`\n  Configuración manual para Antigravity:`);
  console.log(`  ${Dim}${JSON.stringify({ mcpServers: { clickup: antigravityEntry() } }, null, 2)}${Reset}`);
}

// ── Helpers ──────────────────────────────────────────────────────────

function readApiKeyFromGlobal() {
  const globalEnv = join(homedir(), ".config", "mcp-clickup-server", ".env");
  if (existsSync(globalEnv)) {
    const match = readFileSync(globalEnv, "utf-8").match(/^CLICKUP_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  }
  return null;
}

// ── Project configuration ──────────────────────────────────────────

function parseClickUpUrl(url) {
  // https://app.clickup.com/{workspaceId}/v/l/{listId}
  // https://app.clickup.com/{workspaceId}/v/li/{listId}  (new format)
  // https://app.clickup.com/t/{taskId}
  const listMatch = url.match(/app\.clickup\.com\/(\d+)\/v\/(?:l|li)\/([\w-]+)/);
  if (listMatch) {
    return { type: "list", workspaceId: listMatch[1], listId: listMatch[2] };
  }
  const taskMatch = url.match(/app\.clickup\.com\/t\/(\w+)/);
  if (taskMatch) {
    return { type: "task", taskId: taskMatch[1] };
  }
  return null;
}

async function fetchClickUpApi(endpoint, apiKey) {
  const response = await fetch(`https://api.clickup.com/api/v2${endpoint}`, {
    headers: { Authorization: apiKey },
  });
  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function browseListsInteractive(apiKey) {
  // Get workspaces
  const teamData = await fetchClickUpApi("/team", apiKey);
  const workspaces = teamData.teams;
  if (workspaces.length === 0) {
    console.log(`  ${Yellow}No se encontraron workspaces.${Reset}`);
    return null;
  }

  // Select workspace
  console.log(`\n  Workspaces disponibles:`);
  for (let i = 0; i < workspaces.length; i++) {
    console.log(`  ${i + 1}. ${workspaces[i].name} (${workspaces[i].id})`);
  }
  const wsChoice = await ask("  Seleccioná un workspace (número): ");
  const wsIndex = parseInt(wsChoice, 10) - 1;
  if (isNaN(wsIndex) || wsIndex < 0 || wsIndex >= workspaces.length) {
    console.log(`  ${Yellow}Selección inválida.${Reset}`);
    return null;
  }
  const workspace = workspaces[wsIndex];

  // Get spaces
  const spaceData = await fetchClickUpApi(`/team/${workspace.id}/space`, apiKey);
  const spaces = spaceData.spaces || [];
  if (spaces.length === 0) {
    console.log(`  ${Yellow}El workspace no tiene espacios accesibles.${Reset}`);
    return null;
  }

  for (let i = 0; i < spaces.length; i++) {
    console.log(`  ${i + 1}. ${spaces[i].name} (${spaces[i].id})`);
  }
  const spChoice = await ask("  Seleccioná un espacio (número): ");
  const spIndex = parseInt(spChoice, 10) - 1;
  if (isNaN(spIndex) || spIndex < 0 || spIndex >= spaces.length) {
    console.log(`  ${Yellow}Selección inválida.${Reset}`);
    return null;
  }
  const space = spaces[spIndex];

  // Get folderless lists + folder lists
  const listData = await fetchClickUpApi(`/space/${space.id}/list`, apiKey);
  const lists = listData.lists || [];

  if (lists.length === 0) {
    // Try getting folders
    const folderData = await fetchClickUpApi(`/space/${space.id}/folder`, apiKey);
    const folders = folderData.folders || [];
    if (folders.length === 0) {
      console.log(`  ${Yellow}El espacio no tiene listas.${Reset}`);
      return null;
    }
    for (let i = 0; i < folders.length; i++) {
      console.log(`  ${i + 1}. 📁 ${folders[i].name} (${folders[i].id})`);
    }
    const fChoice = await ask("  Seleccioná una carpeta (número): ");
    const fIndex = parseInt(fChoice, 10) - 1;
    if (isNaN(fIndex) || fIndex < 0 || fIndex >= folders.length) {
      console.log(`  ${Yellow}Selección inválida.${Reset}`);
      return null;
    }
    const folderLists = await fetchClickUpApi(`/folder/${folders[fIndex].id}/list`, apiKey);
    const folderListData = folderLists.lists || [];
    for (let i = 0; i < folderListData.length; i++) {
      console.log(`  ${i + 1}. ${folderListData[i].name} (${folderListData[i].id})`);
    }
    const lChoice = await ask("  Seleccioná una lista (número): ");
    const lIndex = parseInt(lChoice, 10) - 1;
    if (isNaN(lIndex) || lIndex < 0 || lIndex >= folderListData.length) return null;
    return {
      listId: folderListData[lIndex].id,
      listName: folderListData[lIndex].name,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    };
  }

  for (let i = 0; i < lists.length; i++) {
    console.log(`  ${i + 1}. ${lists[i].name} (${lists[i].id})`);
  }
  const lChoice = await ask("  Seleccioná una lista (número): ");
  const lIndex = parseInt(lChoice, 10) - 1;
  if (isNaN(lIndex) || lIndex < 0 || lIndex >= lists.length) return null;

  return {
    listId: lists[lIndex].id,
    listName: lists[lIndex].name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  };
}

async function configureProject(apiKey) {
  const configPath = join(process.cwd(), ".mcp-clickup.json");
  if (existsSync(configPath)) {
    const existing = JSON.parse(readFileSync(configPath, "utf-8"));
    console.log(`\n  ${Dim}Ya existe configuración para este proyecto: ${existing.listName ?? existing.listId}${Reset}`);
    const overwrite = await ask("  ¿Querés reconfigurarlo? (s/N): ");
    if (overwrite.toLowerCase() !== "s") return;
  }

  console.log(`\n  Vinculá este proyecto con una lista de ClickUp:`);
  console.log(`  ${Dim}Así cuando pidas crear tareas, el asistente sabrá qué lista usar sin preguntar.${Reset}`);
  const option = await ask("  ¿Cómo querés configurarlo?\n    1. Pegar URL de una lista de ClickUp\n    2. Explorar workspaces y seleccionar\n    3. Ingresar ID de lista manualmente\n    4. Omitir (lo configuro después)\n    Opción (1-4): ");

  let config = null;

  if (option === "1") {
    const url = await ask("  Pegá la URL de la lista (ej: https://app.clickup.com/90151439364/v/l/7-xxx): ");
    const parsed = parseClickUpUrl(url);
    if (!parsed || parsed.type !== "list") {
      console.log(`  ${Yellow}URL no válida. Asegurate que sea una URL de lista de ClickUp.${Reset}`);
      return;
    }
    config = {
      listId: parsed.listId,
      workspaceId: parsed.workspaceId,
    };
  } else if (option === "2") {
    try {
      config = await browseListsInteractive(apiKey);
    } catch (err) {
      console.log(`  ${Yellow}Error al explorar: ${err.message}${Reset}`);
      return;
    }
    if (!config) {
      console.log(`  ${Yellow}No se seleccionó ninguna lista.${Reset}`);
      return;
    }
  } else if (option === "3") {
    const listId = await ask("  Ingresá el ID de la lista: ");
    if (!listId) {
      console.log(`  ${Yellow}ID inválido.${Reset}`);
      return;
    }
    config = { listId };
  } else {
    console.log(`  ${Dim}Podés configurarlo después creando un archivo .mcp-clickup.json en la raíz del proyecto.${Reset}`);
    return;
  }

  if (!config) return;

  // Ask for a friendly project name
  const projectName = await ask(`  Nombre del proyecto (opcional, default: "${config.listName || "Mi proyecto"}"): `);
  config.project = projectName || config.listName || "Mi proyecto";

  // Save
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(`  ✅ ${Green}Proyecto configurado: ${configPath}${Reset}`);
  console.log(`  ${Dim}Ahora cuando pidas crear tareas, el asistente usará automáticamente esta lista.${Reset}`);
}

function finish() {
  console.log(`
${Green}╔══════════════════════════════════════╗
║   ${Bold}¡Setup completado!${Reset}${Green}               ║
╚══════════════════════════════════════╝${Reset}

  ${Bold}Comandos:${Reset}
    ${Cyan}npm run dev${Reset}    → Desarrollo (recarga cambios)
    ${Cyan}npm start${Reset}     → Modo producción

  ${Bold}Probalo con:${Reset}
    echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npm start

  ${Bold}En tu IDE:${Reset}
    "Creá una tarea en este proyecto"
    "Mostrame la configuración de este proyecto"
`);
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const isReconfigure = process.argv.includes("--reconfigure");

  if (isReconfigure) {
    printBanner();
    console.log(`  ${Dim}Modo reconfiguración: se saltea API key, install y build.${Reset}\n`);
    const key = readApiKeyFromGlobal();
    if (!key) {
      console.log(`  ${Yellow}No se encontró API key global. Ejecutá el setup completo primero.${Reset}`);
      return;
    }
    console.log(`\n${Bold}Paso único: Configurar proyecto actual${Reset}`);
    await configureProject(key);
    console.log(`\n  ✅ ${Green}Reconfiguración completada.${Reset}`);
    return;
  }

  printBanner();

  const key = await collectApiKey();
  saveApiKey(key);
  installDeps();
  buildProject();

  console.log(`\n${Bold}Paso 5: Detectando plataformas...${Reset}`);
  const platforms = detectPlatforms();

  if (platforms.length === 0) {
    printManualInstructions();
  } else {
    console.log(`\n${Bold}Paso 6: Registrando MCP server...${Reset}`);
    for (const p of platforms) {
      if (p.type === "opencode") registerInOpenCode(p.path, key);
      if (p.type === "antigravity") registerInAntigravity(p.path);
    }
  }

  console.log(`\n${Bold}Paso 7: Configurar proyecto actual (opcional)${Reset}`);
  await configureProject(key);

  finish();
}

main().catch((err) => {
  console.error("Error en setup:", err);
  process.exit(1);
});
