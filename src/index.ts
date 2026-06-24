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
import { existsSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { homedir } from "node:os";

// ── API Key detection ──────────────────────────────────────────────
// Priority: 1) CLICKUP_API_KEY env var, 2) ~/.config/mcp-clickup-server/.env, 3) ./.env
function detectApiKey(): string {
  // 1. Env var
  if (process.env.CLICKUP_API_KEY) return process.env.CLICKUP_API_KEY;

  // 2. Global config
  const globalEnv = joinPath(homedir(), ".config", "mcp-clickup-server", ".env");
  if (existsSync(globalEnv)) {
    const content = readFileSync(globalEnv, "utf-8");
    const match = content.match(/^CLICKUP_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  }

  // 3. Local .env
  const localEnv = joinPath(process.cwd(), ".env");
  if (existsSync(localEnv)) {
    const content = readFileSync(localEnv, "utf-8");
    const match = content.match(/^CLICKUP_API_KEY=(.+)$/m);
    if (match) return match[1].trim();
  }

  console.error("❌ CLICKUP_API_KEY no encontrada.");
  console.error("   Ejecutá: npx mcp-clickup-server setup");
  process.exit(1);
}

const API_KEY = detectApiKey();

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
    description: `Crea una tarea completa en una lista de ClickUp, con soporte para subtareas, campos personalizados, estados y más.

ÚSALA cuando el usuario pida:
- "Crear tarea", "agregar tarea", "subir tarea", "nueva tarea"
- "Agregar subtarea", "crear subtarea"
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
        status: {
          type: "string",
          description:
            "Estado inicial de la tarea (ej: 'pendiente', 'en curso'). Usá get_list_statuses para ver los disponibles",
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
        startDate: {
          type: "string",
          description:
            "Fecha de inicio. Mismo formato que dueDate",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Etiquetas/tags para la tarea",
        },
        assignees: {
          type: "array",
          items: { type: "number" },
          description: "IDs de usuarios a asignar a la tarea",
        },
        parent: {
          type: "string",
          description:
            "ID de la tarea padre para crear una subtarea. Ej: '86cacpvg1'",
        },
        customFields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "ID del campo personalizado" },
              value: {
                description:
                  "Valor del campo. Para dropdown: el ID de la opción (UUID). Para number: número. Para text: string.",
              },
            },
            required: ["id", "value"],
          },
          description:
            "Valores de campos personalizados. Ej: [{id:'field_id', value:'option_uuid'}]",
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
  {
    name: "get_list_statuses",
    description: `Obtiene los estados disponibles de una lista de ClickUp.

ÚSALA para:
- Ver qué estados (pendiente, en curso, completado, etc.) tiene una lista
- Conocer los posibles estados antes de actualizar una tarea
- Explorar el flujo de trabajo de una lista`,
    inputSchema: {
      type: "object",
      properties: {
        listId: {
          type: "string",
          description: "ID de la lista de ClickUp",
        },
      },
      required: ["listId"],
    },
  },
  {
    name: "get_custom_fields",
    description: `Obtiene los campos personalizados de una lista de ClickUp (ej: Módulos, Prioridad, etc.).

ÚSALA para:
- Ver qué campos personalizados tiene una lista
- Conocer los IDs y opciones disponibles para usarlos en create_task`,
    inputSchema: {
      type: "object",
      properties: {
        listId: {
          type: "string",
          description: "ID de la lista de ClickUp",
        },
      },
      required: ["listId"],
    },
  },
  {
    name: "get_task",
    description: `Obtiene los detalles de una tarea específica de ClickUp (incluye campos personalizados).

ÚSALA para:
- Ver el contenido y estado de una tarea
- Ver campos personalizados (módulos, etc.)
- Obtener información antes de actualizar una tarea`,
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "ID de la tarea (ej: 86cad9f4x)",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "get_tasks",
    description: `Lista las tareas de una lista de ClickUp con filtros opcionales.

ÚSALA para:
- Ver todas las tareas de una lista
- Filtrar por estado, orden, etc.`,
    inputSchema: {
      type: "object",
      properties: {
        listId: {
          type: "string",
          description: "ID de la lista",
        },
        statuses: {
          type: "string",
          description: "Filtrar por estados separados por coma (ej: 'pendiente,en curso')",
        },
        page: {
          type: "number",
          description: "Número de página (default: 0)",
        },
        orderBy: {
          type: "string",
          description: "Orden: 'created', 'updated', 'due_date'",
        },
      },
      required: ["listId"],
    },
  },
  {
    name: "update_task",
    description: `Actualiza los campos de una tarea existente en ClickUp.

ÚSALA cuando el usuario pida:
- "Cambiar estado", "mover tarea", "actualizar tarea"
- "Asignar tarea a...", "cambiar prioridad", "modificar fecha"
- "Agregar módulo", "cambiar módulo"`,
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "ID de la tarea a actualizar",
        },
        name: {
          type: "string",
          description: "Nuevo nombre de la tarea",
        },
        description: {
          type: "string",
          description: "Nueva descripción",
        },
        status: {
          type: "string",
          description: "Nuevo estado (ej: 'en curso', 'completado')",
        },
        priority: {
          type: "number",
          description: "Nueva prioridad: 1 (Urgente) a 4 (Baja)",
          enum: [1, 2, 3, 4],
        },
        dueDate: {
          type: "string",
          description: "Nueva fecha límite (ISO o timestamp ms)",
        },
        startDate: {
          type: "string",
          description: "Nueva fecha de inicio",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Reemplaza todas las etiquetas",
        },
        assignees: {
          type: "array",
          items: { type: "number" },
          description: "Agrega estos usuarios a la tarea",
        },
        customFields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              value: { description: "Valor del campo" },
            },
            required: ["id", "value"],
          },
          description: "Actualiza campos personalizados",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "delete_task",
    description: `Elimina una tarea de ClickUp.

ÚSALA cuando el usuario pida:
- "Borrar tarea", "eliminar tarea", "remover tarea"`,
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "ID de la tarea a eliminar",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "get_task_comments",
    description: `Obtiene los comentarios de una tarea de ClickUp.

ÚSALA para:
- Ver comentarios de una tarea
- Leer la discusión de una tarea`,
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "ID de la tarea",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "add_comment",
    description: `Agrega un comentario a una tarea de ClickUp.

ÚSALA cuando el usuario pida:
- "Comentar en tarea", "agregar comentario", "dejar nota"`,
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "ID de la tarea",
        },
        comment: {
          type: "string",
          description: "Texto del comentario",
        },
      },
      required: ["taskId", "comment"],
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

      case "get_list_statuses": {
        const { listId } = args as Record<string, unknown>;
        if (typeof listId !== "string") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "listId es requerido",
          );
        }
        const listInfo = await clickup.getListStatuses(listId);

        const statusLines = listInfo.statuses.map((s) => {
          const typeIcon =
            s.type === "closed" ? "✅" : s.type === "open" ? "⬜" : "🔄";
          return `  ${typeIcon} **${s.status}** — orden: ${s.orderindex}`;
        });

        return {
          content: [
            {
              type: "text",
              text: [
                `## Estados de: ${listInfo.name}`,
                ...statusLines,
                "",
                `Total: ${listInfo.statuses.length} estados`,
              ].join("\n"),
            },
          ],
        };
      }

      case "get_task": {
        const { taskId } = args as Record<string, unknown>;
        if (typeof taskId !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "taskId es requerido");
        }
        const taskData = await clickup.getTask(taskId);

        const fields: string[] = [
          `**${taskData.name as string}**`,
          `  Estado: ${(taskData.status as Record<string, unknown>)?.status as string ?? "—"}`,
          `  Link: ${(taskData.url as string) ?? "—"}`,
          `  Prioridad: ${taskData.priority ? (taskData.priority as Record<string, unknown>)?.priority as string ?? "—" : "—"}`,
        ];

        if (taskData.custom_fields) {
          for (const cf of taskData.custom_fields as Array<Record<string, unknown>>) {
            fields.push(`  ${cf.name as string}: ${JSON.stringify(cf.value ?? cf.type_config)}`);
          }
        }

        return {
          content: [{ type: "text", text: fields.join("\n") }],
        };
      }

      case "get_custom_fields": {
        const { listId: cfListId } = args as Record<string, unknown>;
        if (typeof cfListId !== "string") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "listId es requerido",
          );
        }
        const { fields } = await clickup.getListFields(cfListId);

        const lines = (fields as Array<Record<string, unknown>>).map((f) => {
          let extra = "";
          if (f.type === "drop_down") {
            const opts = (f.type_config as Record<string, unknown>)?.options as Array<Record<string, unknown>> ?? [];
            const names = opts.map((o: Record<string, unknown>) => o.name as string).join(", ");
            extra = `\n    Opciones: ${names}`;
          }
          return `  📦 **${f.name as string}** (${f.type as string})\n    ID: \`${f.id as string}\`${extra}`;
        });

        return {
          content: [
            {
              type: "text",
              text: [
                "## Campos personalizados",
                ...lines,
                "",
                `Total: ${fields.length} campos`,
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
          status,
          priority,
          dueDate,
          startDate,
          tags,
          assignees,
          parent,
          customFields,
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
          status: (status as string) ?? undefined,
          priority: (priority as 1 | 2 | 3 | 4) ?? undefined,
          dueDate: (dueDate as string) ?? undefined,
          startDate: (startDate as string) ?? undefined,
          tags: (tags as string[]) ?? undefined,
          assignees: (assignees as number[]) ?? undefined,
          parent: (parent as string) ?? undefined,
          customFields: (customFields as Array<{ id: string; value: unknown }>) ?? undefined,
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

      case "get_tasks": {
        const { listId: tListId, statuses, page, orderBy } = args as Record<string, unknown>;
        if (typeof tListId !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "listId es requerido");
        }
        const data = await clickup.getTasks(tListId, {
          statuses: (statuses as string)?.split(",").map((s: string) => s.trim()).filter(Boolean),
          page: (page as number) ?? 0,
          orderBy: (orderBy as string) ?? undefined,
        });
        const tasks = data.tasks as Array<Record<string, unknown>>;
        const lines = tasks.map((t: Record<string, unknown>) => {
          const st = (t.status as Record<string, unknown>)?.status as string ?? "—";
          return `  • **${t.name as string}** — \`${t.id as string}\` [${st}]`;
        });
        return {
          content: [{
            type: "text",
            text: [
              `## Tareas (página ${(page as number) ?? 0})`,
              ...lines,
              "",
              `Total: ${tasks.length}`,
            ].join("\n"),
          }],
        };
      }

      case "update_task": {
        const {
          taskId: utTaskId,
          name: utName,
          description: utDesc,
          status: utStatus,
          priority: utPriority,
          dueDate: utDueDate,
          startDate: utStartDate,
          tags: utTags,
          assignees: utAssignees,
          customFields: utCustomFields,
        } = args as Record<string, unknown>;

        if (typeof utTaskId !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "taskId es requerido");
        }

        const updated = await clickup.updateTask(utTaskId, {
          name: utName as string,
          description: utDesc as string,
          status: utStatus as string,
          priority: utPriority as 1 | 2 | 3 | 4,
          dueDate: utDueDate as string,
          startDate: utStartDate as string,
          tags: utTags as string[],
          assignees: utAssignees as number[],
          customFields: utCustomFields as Array<{ id: string; value: unknown }>,
        });

        return {
          content: [{
            type: "text",
            text: [
              `✅ Tarea actualizada: **${updated.name as string}**`,
              `🔗 ${(updated.url as string) ?? "Sin enlace"}`,
            ].join("\n"),
          }],
        };
      }

      case "delete_task": {
        const { taskId: delTaskId } = args as Record<string, unknown>;
        if (typeof delTaskId !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "taskId es requerido");
        }
        await clickup.deleteTask(delTaskId);
        return {
          content: [{ type: "text", text: `🗑️ Tarea \`${delTaskId}\` eliminada` }],
        };
      }

      case "get_task_comments": {
        const { taskId: commTaskId } = args as Record<string, unknown>;
        if (typeof commTaskId !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "taskId es requerido");
        }
        const { comments } = await clickup.getComments(commTaskId);
        const comms = comments as Array<Record<string, unknown>>;
        if (comms.length === 0) {
          return { content: [{ type: "text", text: "Sin comentarios." }] };
        }
        const lines = comms.map((c) => {
          const user = (c.user as Record<string, unknown>)?.username as string ?? "—";
          const date = c.date ? new Date(Number(c.date)).toLocaleString() : "—";
          return `  👤 **${user}** (${date})\n  ${(c.comment_text as string) ?? "—"}`;
        });
        return {
          content: [{
            type: "text",
            text: ["## Comentarios", ...lines, "", `Total: ${comms.length}`].join("\n"),
          }],
        };
      }

      case "add_comment": {
        const { taskId: acTaskId, comment } = args as Record<string, unknown>;
        if (typeof acTaskId !== "string" || typeof comment !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "taskId y comment son requeridos");
        }
        await clickup.addComment(acTaskId, comment);
        return {
          content: [{ type: "text", text: `✅ Comentario agregado a tarea \`${acTaskId}\`` }],
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
