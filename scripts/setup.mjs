#!/usr/bin/env node

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

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
`);
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
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

  finish();
}

main().catch((err) => {
  console.error("Error en setup:", err);
  process.exit(1);
});
