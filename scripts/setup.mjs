#!/usr/bin/env node

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Colores ────────────────────────────────────────────────────────

const Reset = "\x1b[0m";
const Bold = "\x1b[1m";
const Green = "\x1b[32m";
const Yellow = "\x1b[33m";
const Cyan = "\x1b[36m";
const Dim = "\x1b[2m";

// ── Input helper ───────────────────────────────────────────────────

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

function writeEnv(key) {
  console.log(`\n${Bold}Paso 2: Creando .env${Reset}`);
  const envPath = join(ROOT, ".env");
  writeFileSync(envPath, `CLICKUP_API_KEY=${key}\n`, "utf-8");
  console.log(`  ✅ ${Green}.env creado${Reset}`);
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

// ── OpenCode auto-register ─────────────────────────────────────────

const OPENCODE_PATHS = [
  // Prefer .json over .jsonc — having both causes conflicts
  join(osHome(), ".config", "opencode", "opencode.json"),
  join(osHome(), ".config", "opencode", "opencode.jsonc"),
  join(ROOT, "..", "opencode.json"),
  join(ROOT, "..", "opencode.jsonc"),
];

function osHome() {
  return process.env.HOME || process.env.USERPROFILE || "/home/adrianvergel";
}

function existingOpenCodeConfig() {
  // Warn if both .json and .jsonc exist
  const jsonPath = join(osHome(), ".config", "opencode", "opencode.json");
  const jsoncPath = join(osHome(), ".config", "opencode", "opencode.jsonc");
  if (existsSync(jsonPath) && existsSync(jsoncPath)) {
    console.log(`  ${Yellow}⚠ Tenés opencode.json Y opencode.jsonc.${Reset}`);
    console.log(`  ${Yellow}  Eliminá el .jsonc para evitar conflictos. El setup va a modificar solo el .json.${Reset}`);
  }

  for (const p of OPENCODE_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

function buildClickUpConfigEntry() {
  return {
    command: [
      "node",
      "--env-file", join(ROOT, ".env"),
      join(ROOT, "dist", "index.js"),
    ],
    type: "local",
    description: "MCP server para ClickUp — crear tareas y descubrir estructura",
  };
}

async function registerInOpenCode(configPath) {
  console.log(`\n${Bold}Paso 5: Registrando en OpenCode${Reset}`);

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    console.log(`  ${Yellow}⚠ No se pudo leer ${configPath}${Reset}`);
    return false;
  }

  // Ensure mcp section exists
  if (!config.mcp) config.mcp = {};
  if (config.mcp.clickup) {
    const overwrite = await ask(
      `  ${Yellow}⚠ Ya existe una entrada "clickup" en tu OpenCode config.${Reset}\n  ¿Sobrescribirla? (s/N): `
    );
    if (overwrite.toLowerCase() !== "s") {
      console.log(`  ${Yellow}✗ Omitido. Podés agregarlo manualmente después.${Reset}`);
      return false;
    }
  }

  config.mcp.clickup = buildClickUpConfigEntry();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(`  ✅ ${Green}Configuración agregada en ${configPath}${Reset}`);
  return true;
}

function printManualInstructions() {
  const entry = buildClickUpConfigEntry();
  console.log(`\n${Bold}Paso alternativo: Configuración manual en opencode.json${Reset}`);
  console.log(`  Agregá esto en tu archivo opencode.json o opencode.jsonc:\n`);
  console.log(`  ${Dim}${JSON.stringify({ clickup: entry }, null, 2)}${Reset}`);
  console.log(`\n  ${Yellow}Y reiniciá OpenCode para que tome el cambio.${Reset}\n`);
}

function finish() {
  console.log(`
${Green}╔══════════════════════════════════════╗
║   ${Bold}¡Setup completado!${Reset}${Green}               ║
╚══════════════════════════════════════╝${Reset}

  ${Bold}Comandos disponibles:${Reset}
    ${Cyan}npm run dev${Reset}     → Server en modo desarrollo (con tsx)
    ${Cyan}npm start${Reset}      → Server modo producción (JS compilado)
    ${Cyan}npm run build${Reset}  → Re-compilar TypeScript

  ${Bold}Probalo con:${Reset}
    echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npm start
`);
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  printBanner();

  const key = await collectApiKey();
  writeEnv(key);
  installDeps();
  buildProject();

  const configPath = existingOpenCodeConfig();
  if (configPath) {
    console.log(`\n  ${Dim}Detectado: ${configPath}${Reset}`);
    await registerInOpenCode(configPath);
  } else {
    console.log(`\n  ${Yellow}No se encontró configuración de OpenCode.${Reset}`);
    printManualInstructions();
  }

  finish();
}

main().catch((err) => {
  console.error("Error en setup:", err);
  process.exit(1);
});
