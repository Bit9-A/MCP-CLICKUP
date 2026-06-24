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

  // Check if we're in a git repo (the MCP-CLICKUP repo itself)
  try {
    execSync("git rev-parse --git-dir", { stdio: "ignore" });
    console.log("📦 Repositorio detectado. Buscando actualizaciones...");

    // Fetch latest from origin without needing upstream tracking
    execSync("git fetch origin", { stdio: "inherit" });

    // Check current branch and if main has new commits
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
    const behindCount = execSync("git rev-list --count HEAD..origin/main", { encoding: "utf-8" }).trim();
    if (behindCount === "0") {
      console.log("  ✅ Ya estás en la última versión.");
    } else {
      console.log(`  Nuevos commits disponibles: ${behindCount}`);
      if (branch === "main") {
        execSync("git pull origin main", { stdio: "inherit" });
      } else {
        // Merge main into current branch
        console.log(`  Fusionando origin/main en ${branch}...`);
        execSync("git merge origin/main", { stdio: "inherit" });
      }
      execSync("npm install", { stdio: "inherit" });
      execSync("npm run build", { stdio: "inherit" });
      console.log("\n✅ Actualización completada. Configuración preservada.");
    }
  } catch (err) {
    console.log("📦 Instalación global (npx).");
    console.log("  La próxima vez que ejecutes un comando se usará la última versión automáticamente.");
    console.log("  Para forzar la última versión: npx mcp-clickup-server@latest <comando>");
  }
} else {
  // Start the MCP server (default)
  import("../dist/index.js").catch((err) => {
    console.error("Error al iniciar MCP ClickUp server:", err.message);
    process.exit(1);
  });
}
