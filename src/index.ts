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
import {
  getProjectListId,
  getSyncState,
  normalizeTask,
  openDatabase,
  parseDateInput,
  queryCompleted,
  queryWorkload,
  registerProject,
  upsertTask,
  type Db,
} from "./db.js";
import { syncTasks } from "./sync.js";
import { existsSync, readFileSync } from "node:fs";
import { join as joinPath, dirname, basename } from "node:path";
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

// ── Project config ────────────────────────────────────────────────
interface ProjectConfig {
  project?: string;
  listId?: string;
  listName?: string;
  workspaceId?: string;
  workspaceName?: string;
  defaultStatus?: string;
  defaultPriority?: number;
}

function findProjectConfig(startDir: string = process.cwd()): {
  config: ProjectConfig | null;
  path: string | null;
} {
  let dir = startDir;
  // Walk up to 5 levels (should cover most project structures)
  for (let i = 0; i < 5; i++) {
    const candidate = joinPath(dir, ".mcp-clickup.json");
    if (existsSync(candidate)) {
      try {
        const config = JSON.parse(readFileSync(candidate, "utf-8")) as ProjectConfig;
        return { config, path: candidate };
      } catch {
        return { config: null, path: candidate };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return { config: null, path: null };
}

const PROJECT_CONFIG = findProjectConfig();

const clickup = new ClickUpClient(API_KEY);

const server = new Server(
  { name: "mcp-clickup-server", version: "1.6.0" },
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

function resolveListId(argsListId: unknown): string {
  if (typeof argsListId === "string" && argsListId.length > 0) return argsListId;
  const pc = findProjectConfig(process.cwd());
  if (pc.config?.listId) return pc.config.listId;
  throw new McpError(
    ErrorCode.InvalidParams,
    "No se especificó listId y el proyecto no tiene configuración. Ejecutá `npx mcp-clickup-server setup` en la raíz del proyecto, o pasá el listId directamente.",
  );
}

function formatList(items: { id: string; name: string }[], label: string) {
  if (items.length === 0) return `No se encontraron ${label}.`;
  const lines = items.map(
    (i) => `  • **${i.name}** — \`${i.id}\``,
  );
  return [`## ${label}`, ...lines, "", `Total: ${items.length}`].join("\n");
}

// ── Local cache ─────────────────────────────────────────────────────

let cacheDb: Db | null = null;

/**
 * Opened lazily so a broken/unwritable cache path can only affect the cache
 * tools, never server startup or the existing ClickUp tools.
 */
function getDb(): Db {
  if (!cacheDb) cacheDb = openDatabase();
  return cacheDb;
}

/** Best-effort projection write: a cache failure must never fail a tool call. */
function cacheUpsertTask(raw: unknown): void {
  try {
    if (!raw || typeof raw !== "object") return;
    upsertTask(getDb(), normalizeTask(raw as Record<string, unknown>));
  } catch (error) {
    console.error(`⚠️ No se pudo actualizar la caché local: ${extractError(error)}`);
  }
}

function formatDate(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString();
}

function syncStateFor(listId?: string, teamId?: string) {
  try {
    if (listId) return getSyncState(getDb(), `list:${listId}`);
    if (teamId) return getSyncState(getDb(), `team:${teamId}`);
  } catch {
    // Cache unreadable → report as never synced.
  }
  return null;
}

/** Resolves `project` from the local registry; throws a clear MCP error otherwise. */
function resolveProjectListId(project: string): string {
  let listId: string | null = null;
  try {
    listId = getProjectListId(getDb(), project);
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `No se pudo leer la caché local: ${extractError(error)}`,
    );
  }
  if (!listId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `No hay un proyecto registrado como "${project}". Ejecutá get_project_config en ese proyecto (o sync_tasks) para registrarlo, o pasá listId directamente.`,
    );
  }
  return listId;
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

NO uses otras herramientas para crear tareas — esta es la herramienta específica para ClickUp.

IMPORTANTE: Si el usuario no especifica listId, el server intenta resolverlo desde la configuración del proyecto (.mcp-clickup.json). Si el proyecto no está configurado, muestra un error indicando que ejecute el setup.`,
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
    name: "get_workspace_members",
    description: `Lista los miembros de un workspace de ClickUp con sus IDs, nombres y roles.

ÚSALA para:
- Saber quiénes son los miembros del equipo
- Obtener IDs de usuarios para asignar tareas
- Ver roles (owner, admin, member, guest)`,
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
- Filtrar por estado, orden, etc.

IMPORTANTE: Si el usuario no especifica listId, el server intenta resolverlo desde la configuración del proyecto (.mcp-clickup.json).`,
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
  {
    name: "get_authenticated_user",
    description: `Obtiene el usuario autenticado de ClickUp (el dueño de la API key).

ÚSALA para:
- Saber quién está usando la API key
- Conocer el ID de usuario para asignar tareas
- Filtrar tareas por el usuario actual`,
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "create_space",
    description: `Crea un espacio en un workspace de ClickUp.

ÚSALA cuando el usuario pida:
- "Crear espacio", "nuevo espacio", "agregar espacio"
- Organizar el workspace en espacios nuevos`,
    inputSchema: {
      type: "object",
      properties: {
        teamId: {
          type: "string",
          description: "ID del workspace donde crear el espacio",
        },
        name: {
          type: "string",
          description: "Nombre del espacio",
        },
      },
      required: ["teamId", "name"],
    },
  },
  {
    name: "create_list",
    description: `Crea una lista en un espacio de ClickUp.

ÚSALA cuando el usuario pida:
- "Crear lista", "nueva lista", "agregar lista"
- Organizar tareas en listas nuevas`,
    inputSchema: {
      type: "object",
      properties: {
        spaceId: {
          type: "string",
          description: "ID del espacio donde crear la lista",
        },
        name: {
          type: "string",
          description: "Nombre de la lista",
        },
        content: {
          type: "string",
          description: "Descripción de la lista",
        },
        status: {
          type: "string",
          description: "Estado default de la lista",
        },
        priority: {
          type: "number",
          description: "Prioridad default: 1 (Urgente) a 4 (Baja)",
          enum: [1, 2, 3, 4],
        },
        assignee: {
          type: "number",
          description: "ID del usuario asignado por defecto",
        },
      },
      required: ["spaceId", "name"],
    },
  },
  {
    name: "create_folder",
    description: `Crea una carpeta dentro de un espacio de ClickUp.

ÚSALA cuando el usuario pida:
- "Crear carpeta", "nueva carpeta", "agrupar en una carpeta"
- Organizar listas dentro de una carpeta

Nota: ClickUp no permite crear carpetas anidadas salvo que el workspace tenga subcarpetas habilitadas; en ese caso pasá parentFolderId.`,
    inputSchema: {
      type: "object",
      properties: {
        spaceId: {
          type: "string",
          description: "ID del espacio donde crear la carpeta",
        },
        name: {
          type: "string",
          description: "Nombre de la carpeta",
        },
        parentFolderId: {
          type: "string",
          description: "ID de una carpeta existente para crearla como subcarpeta (opcional)",
        },
      },
      required: ["spaceId", "name"],
    },
  },
  {
    name: "get_space_tags",
    description: `Lista los tags (etiquetas) existentes en un espacio de ClickUp.

ÚSALA para:
- Ver qué clasificaciones ya existen antes de crear una nueva
- Evitar duplicar tags con nombres parecidos`,
    inputSchema: {
      type: "object",
      properties: {
        spaceId: {
          type: "string",
          description: "ID del espacio",
        },
      },
      required: ["spaceId"],
    },
  },
  {
    name: "create_space_tag",
    description: `Crea un tag (etiqueta) a nivel de espacio en ClickUp.

ÚSALA cuando el usuario pida:
- "Crear etiqueta", "crear tag", "clasificar por..."
- Armar clasificaciones transversales (área, tipo, plataforma)

Importante: el tag queda disponible en TODO el espacio, no solo en una lista.`,
    inputSchema: {
      type: "object",
      properties: {
        spaceId: {
          type: "string",
          description: "ID del espacio donde crear el tag",
        },
        name: {
          type: "string",
          description: "Nombre del tag (sin #)",
        },
        tagBg: {
          type: "string",
          description: "Color de fondo en hex, ej: #FF5733 (default: #595d66)",
        },
        tagFg: {
          type: "string",
          description: "Color del texto en hex, ej: #FFFFFF (default: #ffffff)",
        },
      },
      required: ["spaceId", "name"],
    },
  },
  {
    name: "add_tag_to_task",
    description: `Agrega un tag existente a una tarea de ClickUp.

ÚSALA cuando el usuario pida:
- "Etiquetar tarea como...", "agregar tag a la tarea"

El tag debe existir en el espacio; si no existe, crealo antes con create_space_tag.`,
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "ID de la tarea",
        },
        tagName: {
          type: "string",
          description: "Nombre del tag a agregar",
        },
      },
      required: ["taskId", "tagName"],
    },
  },
  {
    name: "sync_tasks",
    description: `Sincroniza las tareas de ClickUp en la caché local SQLite del servidor.

ÚSALA para:
- "Sincronizar tareas", "actualizar la caché", "traer las tareas de ClickUp"
- Preparar datos para get_completed_tasks o get_workload
- Refrescar el estado del trabajo sin depender de la API en cada consulta

ClickUp sigue siendo la fuente de verdad: la base local es una proyección reconstruible. Por defecto hace una sincronización incremental (solo tareas modificadas desde la última vez); con full=true recorre la lista completa y detecta tareas eliminadas (las marca como archivadas, nunca las borra).

IMPORTANTE: Si no pasás listId ni teamId, el server usa la lista configurada del proyecto (.mcp-clickup.json).`,
    inputSchema: {
      type: "object",
      properties: {
        listId: {
          type: "string",
          description: "ID de la lista a sincronizar (si no se pasa, usa la del proyecto)",
        },
        teamId: {
          type: "string",
          description: "ID del workspace para sincronizar todas sus listas",
        },
        full: {
          type: "boolean",
          description: "true = recorrido completo con detección de eliminadas (default: false)",
        },
      },
    },
  },
  {
    name: "get_completed_tasks",
    description: `Lista tareas completadas/cerradas desde la caché local (sin llamar a la API).

ÚSALA para:
- "Qué se completó esta semana", "tareas cerradas del mes"
- Reportes de avance por rango de fechas
- Ver el trabajo terminado de un proyecto o workspace

Requiere haber corrido sync_tasks al menos una vez para ese alcance. Devuelve nombre, estado, fecha de cierre localizada, cantidad de asignados y link. Los datos pueden estar desactualizados respecto de ClickUp: revisá el último sync informado.`,
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Nombre del proyecto registrado (resuelve a su lista de ClickUp)",
        },
        listId: {
          type: "string",
          description: "ID de la lista (alternativa a project)",
        },
        teamId: {
          type: "string",
          description: "ID del workspace para abarcar todas sus listas registradas",
        },
        since: {
          type: "string",
          description: "Desde cuándo: fecha ISO (2025-01-31) o timestamp en milisegundos",
        },
        until: {
          type: "string",
          description: "Hasta cuándo: fecha ISO o timestamp en milisegundos",
        },
        assignee: {
          type: "number",
          description: "ID de usuario para filtrar por asignado",
        },
        limit: {
          type: "number",
          description: "Máximo de tareas a devolver (default: 100, tope: 500)",
        },
      },
    },
  },
  {
    name: "get_workload",
    description: `Resume la carga de trabajo desde la caché local: tareas abiertas por estado y por asignado.

ÚSALA para:
- "Cómo viene la carga del equipo", "quién tiene más pendientes"
- Distribución de tareas por estado
- Planificación rápida sin consultar ClickUp

Requiere haber corrido sync_tasks para ese alcance. Excluye tareas archivadas.`,
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Nombre del proyecto registrado (resuelve a su lista de ClickUp)",
        },
        listId: {
          type: "string",
          description: "ID de la lista (alternativa a project)",
        },
        teamId: {
          type: "string",
          description: "ID del workspace para abarcar todas sus listas registradas",
        },
      },
    },
  },
  {
    name: "get_project_config",
    description: `Obtiene la configuración del proyecto actual asociada a una lista de ClickUp.

ÚSALA cuando el usuario pida acciones sin especificar lista:
- Detecta si el proyecto tiene una lista configurada en .mcp-clickup.json
- Permite al asistente saber qué lista usar sin preguntar`,
    inputSchema: {
      type: "object",
      properties: {},
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

      case "get_workspace_members": {
        const { teamId } = args as Record<string, unknown>;
        if (typeof teamId !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "teamId es requerido");
        }
        const members = await clickup.getWorkspaceMembers(teamId);
        const lines = members.map(
          (m) => `  • **${m.username}** — \`${m.id}\` (${m.roleName}, ${m.email})`,
        );
        return {
          content: [
            {
              type: "text",
              text: [
                `## Miembros del workspace`,
                ...lines,
                "",
                `Total: ${members.length} miembros`,
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

        const assigneeNames = (taskData.assignees as Array<Record<string, unknown>> | undefined)
          ?.map((a) => (a.username as string) ?? a.id as string)
          .join(", ") ?? "—";

        const fields: string[] = [
          `**${taskData.name as string}**`,
          `  Estado: ${(taskData.status as Record<string, unknown>)?.status as string ?? "—"}`,
          `  Asignado: ${assigneeNames}`,
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

        const resolvedListId = resolveListId(listId);
        if (typeof taskName !== "string") {
          throw new McpError(
            ErrorCode.InvalidParams,
            "name es requerido",
          );
        }

        const task = await clickup.createTask(resolvedListId, {
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

        cacheUpsertTask(task);

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
        const resolvedTListId = resolveListId(tListId);
        const data = await clickup.getTasks(resolvedTListId, {
          statuses: (statuses as string)?.split(",").map((s: string) => s.trim()).filter(Boolean),
          page: (page as number) ?? 0,
          orderBy: (orderBy as string) ?? undefined,
        });
        const tasks = data.tasks as Array<Record<string, unknown>>;
        const lines = tasks.map((t: Record<string, unknown>) => {
          const st = (t.status as Record<string, unknown>)?.status as string ?? "—";
          const assignees = (t.assignees as Array<Record<string, unknown>> | undefined)
            ?.map((a) => a.username as string)
            .filter(Boolean)
            .join(", ") ?? "";
          const assigneeStr = assignees ? ` | 👤 ${assignees}` : "";
          return `  • **${t.name as string}** — \`${t.id as string}\` [${st}]${assigneeStr}`;
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

        cacheUpsertTask(updated);

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

      case "create_space": {
        const { teamId: csTeamId, name: csName } = args as Record<string, unknown>;
        if (typeof csTeamId !== "string" || typeof csName !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "teamId y name son requeridos");
        }
        const space = await clickup.createSpace(csTeamId, { name: csName });
        return {
          content: [{
            type: "text",
            text: `✅ Espacio creado: **${space.name as string}** (\`${space.id as string}\`)`,
          }],
        };
      }

      case "create_list": {
        const { spaceId: clSpaceId, name: clName, content, status, priority, assignee } = args as Record<string, unknown>;
        if (typeof clSpaceId !== "string" || typeof clName !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "spaceId y name son requeridos");
        }
        const list = await clickup.createList(clSpaceId, {
          name: clName,
          content: content as string | undefined,
          status: status as string | undefined,
          priority: priority as number | undefined,
          assignee: assignee as number | undefined,
        });
        return {
          content: [{
            type: "text",
            text: `✅ Lista creada: **${list.name as string}** (\`${list.id as string}\`)`,
          }],
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

      case "get_authenticated_user": {
        const user = await clickup.getAuthenticatedUser();
        if (!user) {
          return { content: [{ type: "text", text: "No se pudo determinar el usuario autenticado." }] };
        }
        return {
          content: [{
            type: "text",
            text: [
              `👤 **${user.username}**`,
              `  ID: \`${user.id}\``,
              `  Email: ${user.email}`,
            ].join("\n"),
          }],
        };
      }

      case "create_folder": {
        const { spaceId: cfSpaceId, name: cfName, parentFolderId } = args as Record<string, unknown>;
        if (typeof cfSpaceId !== "string" || typeof cfName !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "spaceId y name son requeridos");
        }
        const folder = await clickup.createFolder(cfSpaceId, {
          name: cfName,
          parentFolderId: parentFolderId as string | undefined,
        });
        return {
          content: [{
            type: "text",
            text: `✅ Carpeta creada: **${folder.name as string}** (\`${folder.id as string}\`)`,
          }],
        };
      }

      case "get_space_tags": {
        const { spaceId: gstSpaceId } = args as Record<string, unknown>;
        if (typeof gstSpaceId !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "spaceId es requerido");
        }
        const tags = await clickup.getSpaceTags(gstSpaceId);
        if (tags.length === 0) {
          return { content: [{ type: "text", text: "Este espacio no tiene tags." }] };
        }
        return {
          content: [{
            type: "text",
            text: [
              "## Tags",
              ...tags.map((t) => `  • **${t.name}**${t.tag_bg ? ` — ${t.tag_bg}` : ""}`),
              "",
              `Total: ${tags.length}`,
            ].join("\n"),
          }],
        };
      }

      case "create_space_tag": {
        const { spaceId: cstSpaceId, name: cstName, tagBg, tagFg } = args as Record<string, unknown>;
        if (typeof cstSpaceId !== "string" || typeof cstName !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "spaceId y name son requeridos");
        }
        const tagRes = await clickup.createSpaceTag(cstSpaceId, {
          name: cstName,
          tagBg: tagBg as string | undefined,
          tagFg: tagFg as string | undefined,
        });
        const createdTag = (tagRes as Record<string, unknown>)?.tag as Record<string, unknown> | undefined;
        return {
          content: [{
            type: "text",
            text: `✅ Tag creado: **${(createdTag?.name as string) ?? cstName}** en espacio \`${cstSpaceId}\``,
          }],
        };
      }

      case "add_tag_to_task": {
        const { taskId: attTaskId, tagName } = args as Record<string, unknown>;
        if (typeof attTaskId !== "string" || typeof tagName !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "taskId y tagName son requeridos");
        }
        await clickup.addTagToTask(attTaskId, tagName);
        // The tag endpoint returns no task body, so refresh it for the cache.
        // Best-effort: a failure here must not change the tool result.
        try {
          cacheUpsertTask(await clickup.getTask(attTaskId));
        } catch (error) {
          console.error(`⚠️ No se pudo refrescar la caché local: ${extractError(error)}`);
        }
        return {
          content: [{
            type: "text",
            text: `✅ Tag **${tagName}** agregado a tarea \`${attTaskId}\``,
          }],
        };
      }

      // ── Local cache ────────────────────────────────────────────
      case "sync_tasks": {
        const { listId: stListId, teamId: stTeamId, full: stFull } = args as Record<string, unknown>;

        let targetListId = typeof stListId === "string" && stListId ? stListId : undefined;
        const targetTeamId = typeof stTeamId === "string" && stTeamId ? stTeamId : undefined;
        let configUsed: { config: ProjectConfig; path: string | null } | null = null;

        if (!targetListId && !targetTeamId) {
          const pc = findProjectConfig(process.cwd());
          if (pc.config?.listId) {
            targetListId = pc.config.listId;
            configUsed = { config: pc.config, path: pc.path };
          }
        }

        if (!targetListId && !targetTeamId) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "Pasá listId o teamId, o configurá el proyecto con .mcp-clickup.json (npm run setup).",
          );
        }

        const result = await syncTasks(getDb(), {
          client: clickup,
          listId: targetListId,
          teamId: targetTeamId,
          full: stFull === true,
        });

        // Same registration the config tool does, so `project` works later.
        if (configUsed && targetListId) {
          try {
            registerProject(getDb(), {
              project: configUsed.config.project ?? basename(process.cwd()),
              path: configUsed.path,
              listId: targetListId,
              teamId: configUsed.config.workspaceId ?? null,
            });
          } catch {
            // Cache bookkeeping only — never fails the sync report.
          }
        }

        const statusIcon = result.status === "ok" ? "✅" : result.status === "partial" ? "⚠️" : "❌";
        const lines = [
          `## Sync ${targetListId ? `lista \`${targetListId}\`` : `workspace \`${targetTeamId}\``}`,
          `  Tareas sincronizadas: ${result.synced}`,
          `  Páginas recorridas: ${result.pages}`,
          `  Archivadas (ya no están en ClickUp): ${result.archived}`,
          `  Estado: ${statusIcon} ${result.status}`,
          `  Duración: ${(result.durationMs / 1000).toFixed(2)}s`,
          `  Watermark: ${result.watermark}`,
        ];

        if (result.status === "partial") {
          lines.push(
            "",
            "⚠️ Se alcanzó el tope de páginas y el recorrido quedó incompleto. No se archivó nada; volvé a ejecutar sync_tasks para continuar.",
          );
        } else if (result.status === "failed") {
          lines.push(
            "",
            "❌ La sincronización falló (red o API de ClickUp). No se archivó ninguna tarea y el watermark no cambió; reintentá en unos minutos.",
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "get_completed_tasks": {
        const {
          project: gcProject,
          listId: gcListId,
          teamId: gcTeamId,
          since: gcSince,
          until: gcUntil,
          assignee: gcAssignee,
          limit: gcLimit,
        } = args as Record<string, unknown>;

        let scopeListId = typeof gcListId === "string" && gcListId ? gcListId : undefined;
        const scopeTeamId = typeof gcTeamId === "string" && gcTeamId ? gcTeamId : undefined;
        if (!scopeListId && typeof gcProject === "string" && gcProject) {
          scopeListId = resolveProjectListId(gcProject);
        }

        const sinceMs = parseDateInput(gcSince);
        const untilMs = parseDateInput(gcUntil);
        const notes: string[] = [];
        if (gcSince !== undefined && sinceMs === undefined) notes.push("⚠️ `since` inválido, se ignoró.");
        if (gcUntil !== undefined && untilMs === undefined) notes.push("⚠️ `until` inválido, se ignoró.");

        const rows = queryCompleted(getDb(), {
          listId: scopeListId,
          teamId: scopeListId ? undefined : scopeTeamId,
          since: sinceMs,
          until: untilMs,
          assigneeId: typeof gcAssignee === "number" ? gcAssignee : undefined,
          limit: typeof gcLimit === "number" ? gcLimit : undefined,
        });

        const state = syncStateFor(scopeListId, scopeTeamId);
        const scopeLabel = scopeListId
          ? `lista \`${scopeListId}\``
          : scopeTeamId
            ? `workspace \`${scopeTeamId}\``
            : "todas las listas en caché";

        const header = [
          `## Tareas completadas (${scopeLabel})`,
          state
            ? `Último sync: ${formatDate(state.last_sync)} — estado: ${state.last_status ?? "—"}`
            : "⚠️ Este alcance nunca se sincronizó. Ejecutá sync_tasks primero.",
        ];

        if (rows.length === 0) {
          header.push(
            "",
            state
              ? "No hay tareas completadas para los filtros indicados."
              : "⚠️ La caché está vacía para este alcance.",
          );
        } else {
          const lines = rows.map((row) => {
            let assigneeCount = 0;
            try {
              const parsed = JSON.parse(row.assignees ?? "[]") as unknown;
              assigneeCount = Array.isArray(parsed) ? parsed.length : 0;
            } catch {
              assigneeCount = 0;
            }
            const people = assigneeCount > 0 ? ` · 👤 ${assigneeCount}` : "";
            const link = row.url ? ` · ${row.url}` : "";
            return `  • **${row.name}** — ${row.status} · cerrada: ${formatDate(row.closed_at)}${people}${link}`;
          });
          header.push("", ...lines, "", `Total: ${rows.length}`);
        }

        if (notes.length > 0) header.push("", ...notes);

        return {
          content: [{ type: "text", text: header.join("\n") }],
        };
      }

      case "get_workload": {
        const { project: gwProject, listId: gwListId, teamId: gwTeamId } = args as Record<string, unknown>;

        let scopeListId = typeof gwListId === "string" && gwListId ? gwListId : undefined;
        const scopeTeamId = typeof gwTeamId === "string" && gwTeamId ? gwTeamId : undefined;
        if (!scopeListId && typeof gwProject === "string" && gwProject) {
          scopeListId = resolveProjectListId(gwProject);
        }

        const result = queryWorkload(getDb(), {
          listId: scopeListId,
          teamId: scopeListId ? undefined : scopeTeamId,
        });

        const state = syncStateFor(scopeListId, scopeTeamId);
        const scopeLabel = scopeListId
          ? `lista \`${scopeListId}\``
          : scopeTeamId
            ? `workspace \`${scopeTeamId}\``
            : "todas las listas en caché";

        const statusEntries = Object.entries(result.byStatus).sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        );

        const statusLines = statusEntries.length === 0
          ? ["  Sin datos."]
          : statusEntries.map(([status, count]) => `  • **${status}**: ${count}`);

        const assigneeLines = result.byAssignee.length === 0
          ? ["  Sin asignados registrados."]
          : result.byAssignee.map(
              (a) => `  • \`${a.id}\` — abiertas: ${a.open} · cerradas: ${a.closed}`,
            );

        const lines = [
          `## Carga de trabajo (${scopeLabel})`,
          state
            ? `Último sync: ${formatDate(state.last_sync)} — estado: ${state.last_status ?? "—"}`
            : "⚠️ Este alcance nunca se sincronizó. Ejecutá sync_tasks primero.",
          "",
          `Tareas en caché: ${result.total}`,
          "",
          "### Por estado",
          ...statusLines,
          "",
          "### Por asignado",
          ...assigneeLines,
        ];

        if (result.total === 0) {
          lines.push("", "⚠️ La caché está vacía para este alcance: ejecutá sync_tasks para poblarla.");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "get_project_config": {
        const pc = findProjectConfig(process.cwd());
        if (!pc.config) {
          return {
            content: [{
              type: "text",
              text: "Este proyecto no tiene configurada una lista de ClickUp. Usá `npm run setup` en la raíz del proyecto para asociarlo.",
            }],
          };
        }

        // Registering the project makes `project` usable in cache queries.
        // Best-effort: the config answer never depends on the cache.
        if (pc.config.listId) {
          try {
            registerProject(getDb(), {
              project: pc.config.project ?? (pc.path ? basename(dirname(pc.path)) : basename(process.cwd())),
              path: pc.path,
              listId: pc.config.listId,
              teamId: pc.config.workspaceId ?? null,
            });
          } catch (error) {
            console.error(`⚠️ No se pudo registrar el proyecto en la caché local: ${extractError(error)}`);
          }
        }

        const lines = [
          `Proyecto: ${pc.config.project ?? "—"}`,
          `Lista: ${pc.config.listName ?? "—"} (\`${pc.config.listId ?? "—"}\`)`,
          `Workspace: ${pc.config.workspaceName ?? "—"} (\`${pc.config.workspaceId ?? "—"}\`)`,
          pc.config.defaultStatus ? `Estado default: ${pc.config.defaultStatus}` : "",
          pc.config.defaultPriority ? `Prioridad default: ${pc.config.defaultPriority}` : "",
          "",
          `Archivo: ${pc.path}`,
        ].filter(Boolean).join("\n");
        return {
          content: [{ type: "text", text: lines }],
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
