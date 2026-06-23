#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { ClickUpClient } from "./clickup-client.js";

// ── Config ──────────────────────────────────────────────────────────
const API_KEY = process.env.CLICKUP_API_KEY;
if (!API_KEY) {
  console.error("❌ CLICKUP_API_KEY environment variable is required");
  process.exit(1);
}

const clickup = new ClickUpClient(API_KEY);

const server = new Server(
  { name: "mcp-clickup-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ── Helpers ─────────────────────────────────────────────────────────

function extractError(error: unknown): string {
  const detail =
    error &&
    typeof error === "object" &&
    "response" in error &&
    error.response &&
    typeof error.response === "object" &&
    "data" in (error.response as Record<string, unknown>)
      ? ((error as { response: { data: unknown } }).response.data as Record<
          string,
          unknown
        >)
      : null;

  return detail
    ? JSON.stringify(detail, null, 2)
    : error instanceof Error
      ? error.message
      : "Error desconocido";
}

function formatList(items: { id: string; name: string }[], label: string) {
  if (items.length === 0) return `No se encontraron ${label}.`;
  const lines = items.map(
    (i) => `  • **${i.name}** — \`${i.id}\``,
  );
  return [`## ${label}`, ...lines, "", `Total: ${items.length}`].join("\n");
}

// ── Tool definitions ────────────────────────────────────────────────
const TOOLS = [
  {
    name: "create_task",
    description: `Crea una tarea en una lista de ClickUp.

ÚSALA cuando el usuario pida:
- "Crear tarea", "agregar tarea", "subir tarea", "nueva tarea"
- Crear items en un tablero ClickUp
- Cualquier solicitud de seguimiento de trabajo/tareas

NO uses otras herramientas para crear tareas — esta es la herramienta específica para ClickUp.`,
    inputSchema: {
      type: "object",
      properties: {
        listId: {
          type: "string",
          description: "ID de la lista de ClickUp donde crear la tarea",
        },
        name: {
          type: "string",
          description: "Nombre o título de la tarea",
        },
        description: {
          type: "string",
          description: "Descripción detallada de la tarea (soporta Markdown)",
        },
        priority: {
          type: "number",
          description:
            "Prioridad: 1 (Urgente), 2 (Alta), 3 (Normal), 4 (Baja)",
          enum: [1, 2, 3, 4],
        },
        dueDate: {
          type: "string",
          description:
            "Fecha límite. Puede ser string ISO (ej: '2025-12-31' o '2025-12-31T18:00:00Z') o timestamp en milisegundos",
        },
        assignees: {
          type: "array",
          items: { type: "number" },
          description: "IDs de usuarios a asignar a la tarea",
        },
      },
      required: ["listId", "name"],
    },
  },
  {
    name: "get_workspaces",
    description: `Lista todos los workspaces/equipos de ClickUp a los que tenés acceso.

ÚSALA para:
- Descubrir IDs de workspaces
- Ver qué workspaces existen antes de consultar espacios`,
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_spaces",
    description: `Lista los espacios dentro de un workspace de ClickUp.

ÚSALA después de get_workspaces para navegar la estructura.`,
    inputSchema: {
      type: "object",
      properties: {
        teamId: {
          type: "string",
          description: "ID del workspace (teamId de get_workspaces)",
        },
      },
      required: ["teamId"],
    },
  },
  {
    name: "get_folders",
    description: `Lista las carpetas dentro de un espacio de ClickUp.

ÚSALA para explorar la estructura de un espacio.`,
    inputSchema: {
      type: "object",
      properties: {
        spaceId: {
          type: "string",
          description: "ID del espacio (de get_spaces)",
        },
      },
      required: ["spaceId"],
    },
  },
  {
    name: "get_lists",
    description: `Lista las listas dentro de un espacio o carpeta de ClickUp.

Las listas son donde se crean las tareas. Si no pasás folderId, busca listas sin carpeta dentro del espacio.`,
    inputSchema: {
      type: "object",
      properties: {
        spaceId: {
          type: "string",
          description: "ID del espacio (requerido si no usás folderId)",
        },
        folderId: {
          type: "string",
          description:
            "ID de la carpeta (opcional — si se pasa, lista adentro de la carpeta)",
        },
      },
    },
  },
];

// ── Handlers ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── Discovery ──────────────────────────────────────────────
      case "get_workspaces": {
        const workspaces = await clickup.getWorkspaces();
        const lines = workspaces.map(
          (w) =>
            `  • **${w.name}** — \`${w.id}\`` +
            (w.members ? ` (${(w.members as unknown[]).length} miembros)` : ""),
        );
        return {
          content: [
            {
              type: "text",
              text: [
                "## Workspaces",
                ...lines,
                "",
                `Total: ${workspaces.length}`,
              ].join("\n"),
            },
          ],
        };
      }

      case "get_spaces": {
        const { teamId } = args as Record<string, unknown>;
        if (typeof teamId !== "string") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "teamId es requerido",
          );
        }
        const spaces = await clickup.getSpaces(teamId);
        return {
          content: [{ type: "text", text: formatList(spaces, "Espacios") }],
        };
      }

      case "get_folders": {
        const { spaceId } = args as Record<string, unknown>;
        if (typeof spaceId !== "string") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "spaceId es requerido",
          );
        }
        const folders = await clickup.getFolders(spaceId);
        return {
          content: [
            {
              type: "text",
              text: folders.length === 0
                ? "No hay carpetas en este espacio."
                : formatList(folders, "Carpetas"),
            },
          ],
        };
      }

      case "get_lists": {
        const { spaceId, folderId } = args as Record<string, unknown>;
        const lists = folderId
          ? await clickup.getFolderLists(folderId as string)
          : typeof spaceId === "string"
            ? await clickup.getFolderlessLists(spaceId)
            : (() => {
                throw new McpError(
                  ErrorCode.InvalidParams,
                  "Debés pasar spaceId o folderId",
                );
              })();

        const lines = lists.map((l) => {
          const extra = l.task_count != null ? ` (${l.task_count} tareas)` : "";
          return `  • **${l.name}** — \`${l.id}\`${extra}`;
        });

        return {
          content: [
            {
              type: "text",
              text: [
                "## Listas",
                ...lines,
                "",
                `Total: ${lists.length}`,
              ].join("\n"),
            },
          ],
        };
      }

      // ── Actions ────────────────────────────────────────────────
      case "create_task": {
        const {
          listId,
          name: taskName,
          description,
          priority,
          dueDate,
          assignees,
        } = args as Record<string, unknown>;

        if (typeof listId !== "string" || typeof taskName !== "string") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "listId y name son requeridos",
          );
        }

        const task = await clickup.createTask(listId, {
          name: taskName,
          description: (description as string) ?? undefined,
          priority: (priority as 1 | 2 | 3 | 4) ?? undefined,
          dueDate: (dueDate as string) ?? undefined,
          assignees: (assignees as number[]) ?? undefined,
        });

        return {
          content: [
            {
              type: "text",
              text: [
                `✅ Tarea creada: **${task.name}**`,
                `🔗 ${task.url ?? task.web_url ?? "Sin enlace"}`,
                `🆔 ID: \`${task.id}\``,
              ].join("\n"),
            },
          ],
        };
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Tool desconocida: ${name}`,
        );
    }
  } catch (error) {
    // Re-throw McpError as-is
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.InternalError,
      `Error en ClickUp API: ${extractError(error)}`,
    );
  }
});

// ── Start ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ MCP ClickUp server corriendo sobre stdio");
