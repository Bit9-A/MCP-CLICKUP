#!/usr/bin/env node
// CJS wrapper for the ESM MCP ClickUp server
// Needed because npm bin doesn't support ESM directly
import("../dist/index.js").catch((err) => {
  console.error("Error al iniciar MCP ClickUp server:", err.message);
  process.exit(1);
});
