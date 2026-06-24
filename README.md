# 🚀 MCP ClickUp Server

**Servidor MCP para integrar ClickUp con OpenCode, Antigravity (Google IDE) o cualquier cliente MCP.**

Creá tareas, consultá tu workspace, asigná módulos y más, todo desde lenguaje natural.

---

## ✨ Qué podés hacer

| Acción | Ejemplo |
|--------|---------|
| 📋 **Ver estructura** | "Mostrame mis workspaces de ClickUp" |
| 📁 **Explorar listas** | "Qué listas hay en mi espacio?" |
| ✅ **Ver estados** | "Qué estados tiene la lista SIGESP?" |
| 📦 **Ver módulos** | "Qué módulos están disponibles?" |
| 📝 **Crear tareas** | "Creá una tarea urgente en SIGESP llamada 'Revisar pendientes' con módulo TESORERIA" |
| 🔄 **Actualizar tareas** | "Cambiá la tarea 86cad8gv7 a completado y prioridad alta" |
| 📥 **Crear subtareas** | "Agregá una subtarea a la tarea 86cacpvg1" |
| 💬 **Comentar** | "Agregale un comentario a la tarea diciendo que ya lo revisé" |
| 🗑️ **Eliminar** | "Borrá la tarea de prueba" |
| 📊 **Listar tareas** | "Mostrame las tareas pendientes de SIGESP" |

---

## 🔧 Instalación

### 1. Clonar el repo

```bash
git clone https://github.com/Bit9-A/MCP-CLICKUP.git
cd MCP-CLICKUP
```

### 2. Setup automático

```bash
npm run setup
```

Esto va a:
1. Pedirte tu **API Key de ClickUp** (la generás en https://app.clickup.com/settings/apps)
2. Guardarla de forma segura
3. Instalar dependencias y compilar
4. Detectar **OpenCode** y/o **Antigravity** y registrar el servidor automáticamente

### 3. Reiniciar el IDE

Reiniciá OpenCode o Antigravity y ya podés empezar a usar los comandos.

---

## ⚙️ Configuración manual

Si el setup no detecta tu IDE automáticamente, agregá esto manualmente:

### Para OpenCode

En `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "clickup": {
      "command": ["node", "/ruta/a/MCP-CLICKUP/dist/index.js"],
      "type": "local"
    }
  }
}
```

### Para Antigravity (Google IDE)

En `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "clickup": {
      "command": "node",
      "args": ["/ruta/a/MCP-CLICKUP/dist/index.js"]
    }
  }
}
```

---

## 🔑 API Key

Necesitás un **Personal API Token** de ClickUp:

1. Andá a **Settings → Apps → API Token** o directo a https://app.clickup.com/settings/apps
2. Copiá el token (empieza con `pk_`)
3. Pegalo cuando `npm run setup` lo pida

El servidor busca la key en este orden:
1. Variable de entorno `CLICKUP_API_KEY`
2. Archivo global `~/.config/mcp-clickup-server/.env`
3. Archivo local `./.env`

---

## 📦 Publicar en npm (para compartir)

Una vez que el setup esté listo, tus compañeros pueden instalarlo con:

```bash
npx mcp-clickup-server setup
```

Sin clonar, sin rutas absolutas, sin config manual.

---

## 🛠️ Desarrollo

```bash
npm run dev      # Modo desarrollo con recarga
npm run build    # Compilar TypeScript
npm start        # Modo producción
```

---

## 📋 Tools disponibles (13)

| Tool | Descripción |
|------|-------------|
| `get_workspaces` | Lista workspaces |
| `get_spaces` | Lista espacios de un workspace |
| `get_folders` | Lista carpetas de un espacio |
| `get_lists` | Lista listas de un espacio o carpeta |
| `get_list_statuses` | Estados disponibles de una lista |
| `get_custom_fields` | Campos personalizados (ej. MÓDULO) |
| `get_tasks` | Lista tareas con filtros |
| `get_task` | Detalle de una tarea |
| `get_task_comments` | Comentarios de una tarea |
| `create_task` | Crea tarea completa |
| `update_task` | Actualiza tarea existente |
| `add_comment` | Agrega comentario |
| `delete_task` | Elimina tarea |

---

## ❓ Solución de problemas

**"CLICKUP_API_KEY no encontrada"**
→ Ejecutá `npm run setup` de nuevo para configurar la key.

**No aparece ClickUp en el IDE después de configurar**
→ Reiniciá el IDE (OpenCode o Antigravity).
→ Verificá que el archivo de configuración tenga el formato correcto.

**Error al crear tarea: "Value must be an option index or uuid"**
→ Usá `get_custom_fields` para ver los IDs de las opciones del dropdown.
→ Pasá el UUID de la opción (no el nombre).

**El servidor no arranca**
→ Verificá que Node.js v20+ esté instalado.
→ Corré `npm run build` para asegurarte de que el TypeScript esté compilado.
→ Verificá que `dist/index.js` exista.

---

## 📄 Licencia

MIT
