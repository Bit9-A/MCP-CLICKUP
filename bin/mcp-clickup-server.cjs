#!/usr/bin/env node
// CJS wrapper for the ESM MCP ClickUp server
// Needed because npm bin doesn't support ESM directly

const args = process.argv.slice(2);

if (args[0] === "setup") {
  // Run the setup wizard instead of starting the server
  import("../scripts/setup.mjs").catch((err) => {
    console.error("Error al ejecutar setup:", err.message);
    process.exit(1);
  });
} else if (args[0] === "reconfigure") {
  // Re-run only the project config step, skip API key/install/build
  import("../scripts/setup.mjs").catch((err) => {
    console.error("Error al ejecutar setup:", err.message);
    process.exit(1);
  });
} else if (args[0] === "update") {
  // Update to latest version without losing configuration
  console.log("Actualizando MCP ClickUp Server...\n");
  const { execSync } = require("child_process");
  const { existsSync } = require("fs");
  const { join } = require("path");

  // Check if we're in a git repo
  try {
    execSync("git rev-parse --git-dir", { stdio: "ignore" });
    console.log("📦 Repositorio detectado. Actualizando...");
    execSync("git pull", { stdio: "inherit" });
    execSync("npm install", { stdio: "inherit" });
    console.log("\n✅ Actualización completada. Configuración preservada.");
  } catch {
    console.log("📦 Instalación global (npx).");
    console.log("  La próxima vez que ejecutes un comando se usará la última versión automáticamente.");
    console.log("  Si querés forzar la última versión: npx mcp-clickup-server@latest <comando>");
  }
} else {
  // Start the MCP server (default)
  import("../dist/index.js").catch((err) => {
    console.error("Error al iniciar MCP ClickUp server:", err.message);
    process.exit(1);
  });
}
