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
  console.log(`MCP ClickUp Server v${require("../package.json").version}`);
  console.log("");
  console.log("Para actualizar al instalar con npm (recomendado):");
  console.log("  npx mcp-clickup-server@latest setup");
  console.log("");
  console.log("Si clonaste el repo:");
  console.log("  git pull && npm install && npm run build");
} else {
  // Start the MCP server (default)
  import("../dist/index.js").catch((err) => {
    console.error("Error al iniciar MCP ClickUp server:", err.message);
    process.exit(1);
  });
}
