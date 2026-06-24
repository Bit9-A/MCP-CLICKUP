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
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
    console.log(`📦 Repositorio detectado. Rama actual: ${branch}`);

    // Check if branch has upstream tracking
    try {
      execSync(`git rev-parse --abbrev-ref --symbolic-full-name ${branch}@{upstream}`, { stdio: "ignore" });
    } catch {
      // No upstream set — try to set it for common branch names
      const mainBranch = branch === "main" || branch === "master" ? branch : "main";
      try {
        execSync(`git branch --set-upstream-to=origin/${mainBranch} ${branch}`, { stdio: "inherit" });
        console.log(`  → Upstream configurado: origin/${mainBranch}`);
      } catch {
        console.log(`  ⚠ No se pudo configurar upstream automáticamente.`);
        console.log(`  Ejecutá manualmente: git branch --set-upstream-to=origin/main ${branch}`);
        return;
      }
    }

    execSync("git pull", { stdio: "inherit" });
    execSync("npm install", { stdio: "inherit" });
    execSync("npm run build", { stdio: "inherit" });
    console.log("\n✅ Actualización completada. Configuración preservada.");
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
