// Interactive numbered checklist for selecting MCP tools to configure
import { createInterface } from "node:readline";
import { TARGET_REGISTRY } from "./ide-registry.mjs";

const Dim = "\x1b[2m";
const Reset = "\x1b[0m";
const Yellow = "\x1b[33m";

/**
 * Present a numbered checklist of all 14 tools.
 * Detected tools are pre-checked per FR-SEL-001.
 * User toggles by number per FR-SEL-002, confirms summary per FR-SEL-003.
 *
 * @param {Array<{id: string, name: string, found: boolean, path: string|null}>} detected
 *        Results from detectAllTargets()
 * @returns {Promise<string[]>} Array of selected tool IDs
 */
export async function interactiveSelect(detected) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const selected = new Set(
    detected.filter((t) => t.found).map((t) => t.id)
  );

  while (true) {
    console.log("\nHerramientas MCP detectadas. Seleccioná cuáles configurar:");
    TARGET_REGISTRY.forEach((target, i) => {
      const checked = selected.has(target.id) ? "[x]" : "[ ]";
      const status = detected.find((d) => d.id === target.id)?.found
        ? `${Dim}(detectado)${Reset}`
        : "";
      console.log(`  ${checked} ${String(i + 1).padStart(2)}. ${target.name} ${status}`);
    });
    console.log("\nNúmero para toggle, Enter para confirmar:");

    const answer = await askQuestion(rl);
    if (answer === "") break;
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < TARGET_REGISTRY.length) {
      const t = TARGET_REGISTRY[idx];
      if (selected.has(t.id)) selected.delete(t.id);
      else selected.add(t.id);
    }
  }

  rl.close();

  // FR-SEL-003: Confirmation summary before returning
  const finalSelected = Array.from(selected);
  if (finalSelected.length === 0) {
    console.log(`\n${Yellow}No seleccionaste ninguna herramienta. Saliendo...${Reset}`);
    return [];
  }

  console.log("\nResumen de selección (Enter para confirmar):");
  for (const id of finalSelected) {
    const target = TARGET_REGISTRY.find((t) => t.id === id);
    if (target) console.log(`  • ${target.name}`);
  }

  // Wait for Enter confirmation
  const confirmRl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => confirmRl.question("", () => resolve()));
  confirmRl.close();

  return finalSelected;
}

function askQuestion(rl) {
  return new Promise((resolve) => rl.question("", (a) => resolve(a.trim())));
}
