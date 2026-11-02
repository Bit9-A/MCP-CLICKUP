# MCP ClickUp Server

A Model Context Protocol (MCP) server that connects ClickUp to your favorite AI coding tools. Create tasks, browse workspaces, assign work, and manage your project workflow using natural language.

---

## Table of Contents

- [Capabilities](#capabilities)
- [Installation](#installation)
- [Supported Tools](#supported-tools)
- [Headless Mode](#headless-mode)
- [Usage](#usage)
- [Updating](#updating)
- [Configuration](#configuration)
- [API Key](#api-key)
- [Per-Project Configuration](#per-project-configuration)
- [Available Tools](#available-tools)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Capabilities

| Action | Example Command |
|--------|----------------|
| Browse workspaces | "Show me my ClickUp workspaces" |
| Explore lists | "What lists are in my space?" |
| View statuses | "What statuses does the SIGESP list have?" |
| View modules | "What modules are available?" |
| View team members | "Who are the members of this workspace?" |
| Create tasks | "Create a high-priority task in SIGESP called 'Review pending items' with module TESORERIA" |
| Update tasks | "Change task 86cad8gv7 to completed with high priority" |
| Assign tasks | "Assign task 86cad8gv7 to Luis Sanchez" |
| Create subtasks | "Add a subtask to task 86cacpvg1" |
| Add comments | "Add a comment to the task saying I already reviewed it" |
| Delete tasks | "Delete the test task" |
| List tasks | "Show me the pending tasks in SIGESP" |

---

## Installation

> **Requirements:** Node 22.5+ for the local task cache (`node:sqlite`). Everything else works on older Node, but the cache tools report the requirement instead of booting a broken server.

Nothing to provision by hand: the cache database, its directories and its schema are created automatically the first time a cache tool runs (`sync_tasks`, `get_completed_tasks`, `get_workload`). No migration command, no setup step.

Run the setup wizard from any project directory:

```bash
npx mcp-clickup-server setup
```

The wizard will:

1. Ask for your ClickUp API key
2. Save the key to a global configuration file
3. Detect installed MCP-compatible tools and let you choose where to register the server
4. Optionally link the current project to a ClickUp list

After setup, restart the IDE or AI tool where you installed the server. The ClickUp tools will be available immediately.

> **Tip:** The setup never overwrites existing MCP servers unless you explicitly select that tool. It safely merges the ClickUp server into your existing configuration.

---

## Supported Tools

The following MCP-compatible clients are supported. Detection and automatic configuration availability vary by platform.

| Tool | Detected Automatically | Configured Automatically | Notes |
|------|:----------------------:|:------------------------:|-------|
| OpenCode | ✓ | ✓ | |
| Antigravity (Google IDE) | ✓ | ✓ | |
| Cursor | ✓ | ✓ | |
| VS Code + Copilot | ✓ | ✓ | Uses the `mcp` / `servers` configuration |
| Claude Desktop | ✓ | ✓ | macOS / Windows / Linux paths supported |
| Claude Code | ✓ | ✓ | |
| ChatGPT Desktop | ✓ | ✓ | |
| Augment | ✓ | ✓ | |
| Auggie | ✓ | ✓ | |
| Windsurf | ✓ | ✓ | |
| Roo Code | ✓ | ✓ | Detected through the VS Code extension storage |
| n8n | ✗ | ✗ | Copy the MCP server command into the n8n workflow UI |
| Codex (OpenAI) | ✗ | ✗ | Add the command to your Codex configuration file |
| Add Agent (generic) | ✗ | ✗ | Paste the command into the agent's MCP settings |

If a tool is not detected automatically, you can still select it manually in the interactive wizard or use `--targets` in headless mode.

---

## Headless Mode

For CI/CD, dotfiles, or when you already know which tools you want to configure, skip the interactive wizard:

```bash
# Detect installed tools without writing any configuration
npx mcp-clickup-server setup --detect-only

# Configure specific tools by their ID
npx mcp-clickup-server setup --targets cursor,claude-desktop,opencode

# Update only the project-level ClickUp list association
npx mcp-clickup-server reconfigure
```

> **Note:** `--reconfigure` only updates the project list association. It does not register the MCP server in IDEs. To register tools and update the project list, run setup first and then reconfigure.

### Tool IDs

Use these IDs with `--targets`:

`opencode`, `antigravity`, `cursor`, `vscode-copilot`, `claude-desktop`, `claude-code`, `chatgpt`, `augment`, `auggie`, `windsurf`, `roo-code`, `n8n`, `codex`, `add-agent`

---

## Usage

Once installed, interact with ClickUp using natural language. The assistant will call the appropriate tools automatically.

Examples:

- "Show me my workspaces"
- "Who are the members of this workspace?"
- "Create a task in SIGESP called 'Review Q3 budget' assigned to Luis"
- "What tasks are pending in this project?"
- "Add a comment to task 86cad8gv7 saying I reviewed it"

If a project has been configured with a ClickUp list, you can omit the list name and the assistant will use the configured list automatically.

---

## Updating

Update to the latest version without losing your configuration:

```bash
npx mcp-clickup-server update
```

This preserves your API key and per-project settings. If you installed via git, it pulls the latest code, installs dependencies, and rebuilds.

### Reconfigure a project

To change which ClickUp list is associated with the current project:

```bash
npx mcp-clickup-server reconfigure
```

This skips the API key, dependency, and IDE registration steps and goes directly to the project configuration wizard.

---

## Configuration

### Automatic Configuration

`npx mcp-clickup-server setup` detects and configures supported tools automatically. No manual file editing is required.

### Manual Configuration

If automatic detection fails or you prefer to configure a tool by hand, use the command below and add it to your tool's MCP settings:

```bash
node /path/to/MCP-CLICKUP/dist/index.js
```

Each client stores MCP servers differently. The setup wizard writes to the standard location for each tool; refer to your client's documentation for the exact file and schema.

**OpenCode example:**

In `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "clickup": {
      "command": ["node", "/path/to/MCP-CLICKUP/dist/index.js"],
      "type": "local",
      "enabled": true
    }
  }
}
```

**Antigravity (Google IDE) example:**

In `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "clickup": {
      "command": "node",
      "args": ["/path/to/MCP-CLICKUP/dist/index.js"]
    }
  }
}
```

---

## API Key

A ClickUp Personal API Token is required. Generate one at:

**Settings > Apps > API Token** or directly at https://app.clickup.com/settings/apps

The token begins with `pk_`. The server resolves the API key in the following priority order:

1. `CLICKUP_API_KEY` environment variable
2. Global configuration file at `~/.config/mcp-clickup-server/.env`
3. Local `.env` file in the project directory

---

## Per-Project Configuration

Each project can be associated with a specific ClickUp list, allowing the assistant to know where to create tasks without being told every time.

### Setup

Run this in your project directory:

```bash
npx mcp-clickup-server setup
```

During setup, you will be prompted to configure the current project. You can:

1. **Paste a ClickUp list URL** — The setup parses the URL and extracts the list and workspace IDs.
2. **Browse workspaces interactively** — Select from your workspaces, spaces, and lists.
3. **Enter a list ID manually** — If you already know the ID.
4. **Skip** — Configure later.

To change the configuration later, run:

```bash
npx mcp-clickup-server reconfigure
```

### Manual Configuration

Create a `.mcp-clickup.json` file in your project root:

```json
{
  "project": "My Project",
  "listId": "901513520682",
  "listName": "SIGESP",
  "workspaceId": "90151439364",
  "workspaceName": "Ing. Aron Rojas."
}
```

### How It Works

When you ask the assistant to create a task or list tasks without specifying a list, the server checks for `.mcp-clickup.json` in the current project directory. If found, it uses the configured list automatically.

---

## Available Tools

The server exposes 25 tools for ClickUp interaction:

| Tool | Description |
|------|-------------|
| `get_workspaces` | List all accessible workspaces |
| `get_workspace_members` | List members with IDs, names, and roles |
| `get_authenticated_user` | Get the current user's info (ID, name, email) |
| `get_spaces` | List spaces within a workspace |
| `get_folders` | List folders within a space |
| `get_lists` | List lists within a space or folder |
| `get_list_statuses` | View available statuses for a list |
| `get_custom_fields` | View custom fields (e.g., MODULE dropdown) |
| `get_tasks` | List tasks with optional filters (includes assignees) |
| `get_task` | Get detailed task information (includes assignees) |
| `get_task_comments` | View comments on a task |
| `get_project_config` | Get the project's associated ClickUp list |
| `get_space_tags` | List the tags defined in a space |
| `create_task` | Create a complete task with all fields |
| `update_task` | Update an existing task |
| `add_comment` | Add a comment to a task |
| `delete_task` | Delete a task |
| `create_space` | Create a space in a workspace |
| `create_list` | Create a list in a space |
| `create_folder` | Create a folder in a space (or a subfolder, if enabled) |
| `create_space_tag` | Create a space-level tag |
| `add_tag_to_task` | Add an existing tag to a task |
| `sync_tasks` | Sync ClickUp tasks into the local SQLite cache (list or workspace scope) |
| `get_completed_tasks` | Query completed tasks from the cache by date range, assignee, project |
| `get_workload` | Count open/closed tasks by status and assignee, from the cache |

### Local task cache

`sync_tasks` builds a local, **rebuildable** projection of your tasks in SQLite. ClickUp stays the only source of truth: delete the file and re-sync.

- Location: `${XDG_DATA_HOME:-~/.local/share}/mcp-clickup-server/clickup.db`, or `CLICKUP_CACHE_DB` if set. Created `0600` (task names, URLs and assignee ids live there; the API key never does).
- Reads (`get_completed_tasks`, `get_workload`) hit the cache. Writes still call ClickUp first and then project the returned task into the cache (best-effort — a cache failure never fails a write).
- `sync_tasks` with no `listId`/`teamId` falls back to the project's `.mcp-clickup.json`, and registers the project so `project: "<name>"` works in queries.
- First sync of a scope is a full sweep. Later syncs are deltas keyed on `date_updated_gt`.
- A task that disappears from a **complete full sweep** is flagged `archived = 1`, never deleted. Deletions upstream are therefore detected on `sync_tasks({ full: true })`.
- A failed or partial sweep never archives anything and never advances the watermark.
- Same file is safe to share across projects and concurrent sessions: WAL mode, `busy_timeout`, one writer at a time.

Verify the cache locally with plain SQL:

```bash
sqlite3 ~/.local/share/mcp-clickup-server/clickup.db \
  "SELECT status, COUNT(*) FROM tasks WHERE archived = 0 GROUP BY status;"
```

Run the test suite (no network calls) with `npm test`.

### Classification limits

ClickUp's public API does not expose everything the UI does. Check this before promising a workflow to a user:

| Mechanism | Supported | Endpoint |
|-----------|-----------|----------|
| Folders | Yes | `POST /space/{space_id}/folder` |
| Spaces, Lists | Yes | `POST /team/{team_id}/space`, `POST /space/{space_id}/list` |
| Tags (create, list, add to task) | Yes | `POST /space/{space_id}/tag`, `POST /task/{task_id}/tag/{tag_name}` |
| Custom field values | Yes | `POST /task/{task_id}/field/{field_id}` (also via `customFields` on create/update) |
| `PUT /task` with `tags` | **Ignored silently** | ClickUp returns 200 and leaves tags unchanged — use `POST /task/{id}/tag/{name}` |
| **Create a custom field definition** | **No** | No public endpoint — create it in the UI, then set values via this server |
| **Create or edit statuses** | **No** | No endpoint at all — configure in the UI, or replicate a Folder/List template with `Create Folder/List from Template` |

Tags are space-scoped: a tag created for one list becomes available across the whole space and cannot be deleted with this server.

### create_task Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `listId` | string | No* | ClickUp list ID (falls back to project config) |
| `name` | string | Yes | Task title |
| `description` | string | No | Markdown-supported description |
| `status` | string | No | Initial status (e.g., "pendiente", "en curso") |
| `priority` | number | No | 1 (Urgent), 2 (High), 3 (Normal), 4 (Low) |
| `dueDate` | string | No | ISO date string or millisecond timestamp |
| `startDate` | string | No | Start date (ISO or timestamp) |
| `tags` | string[] | No | Tags for the task |
| `assignees` | number[] | No | User IDs to assign (use `get_workspace_members` to find IDs) |
| `parent` | string | No | Parent task ID for subtasks |
| `customFields` | array | No | Custom field values (e.g., module assignments) |

*`listId` is optional if the project has a `.mcp-clickup.json` configuration.

---

## Development

```bash
npm run dev               # Development mode with hot reload
npm run build             # Compile TypeScript
npm start                 # Production mode
npm run update            # Update from git (preserves config)
```

---

## Troubleshooting

**"CLICKUP_API_KEY not found"**
Run `npx mcp-clickup-server setup` to configure the API key.

**ClickUp tools not appearing after setup**
Restart the IDE or AI tool where you installed the server, then verify the configuration file was updated.

**A tool was not detected automatically**
Use the `--targets` flag to force configuration, or add the server manually using the command shown in the [Manual Configuration](#manual-configuration) section.

**Error: "Value must be an option index or uuid"**
Use the `get_custom_fields` tool to retrieve the available option UUIDs for dropdown fields. Pass the option UUID (not the display name) in the `customFields` parameter.

**Server fails to start**
Ensure Node.js v20 or later is installed. Run `npm run build` to verify the TypeScript compiles successfully. Confirm that `dist/index.js` exists.

---

## License

MIT
