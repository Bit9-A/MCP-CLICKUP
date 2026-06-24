# MCP ClickUp Server

Model Context Protocol server for integrating ClickUp with OpenCode, Antigravity (Google IDE), or any MCP-compatible client. Create tasks, query workspaces, assign modules, and manage your project workflow using natural language commands.

---

## Table of Contents

- [Capabilities](#capabilities)
- [Installation](#installation)
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

Run this in any project directory:

```bash
npx mcp-clickup-server setup
```

The setup script will:
1. Prompt for your ClickUp API key
2. Save the key to the global configuration
3. Detect your IDE (OpenCode, Antigravity) and register the server
4. Optionally associate the current project with a ClickUp list

After installation, restart your IDE. The ClickUp tools will be available immediately.

---

## Usage

Once installed, you can interact with ClickUp using natural language. The assistant will use the tools automatically based on your request.

Examples:

- "Show me my workspaces"
- "Who are the members of this workspace?"
- "Create a task in SIGESP called 'Review Q3 budget' assigned to Luis"
- "What tasks are pending in this project?"
- "Add a comment to task 86cad8gv7 saying I reviewed it"

If a project has been configured with a ClickUp list, you can omit the list name and the assistant will use the configured list automatically.

---

## Updating

To update to the latest version without losing your configuration:

```bash
npx mcp-clickup-server update
```

This preserves your API key and per-project settings. If you installed via git, it pulls the latest code, installs dependencies, and rebuilds.

### Reconfigure a project

To change which ClickUp list is associated with the current project:

```bash
npx mcp-clickup-server reconfigure
```

This skips the API key and dependency steps and goes directly to the project configuration wizard.

---

## Configuration

### Automatic Configuration

The `npx mcp-clickup-server setup` command automatically detects and configures supported IDEs. No manual steps are required.

### Manual Configuration

If automatic detection fails, add the following configuration manually.

**For OpenCode:**

In `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "clickup": {
      "command": ["node", "/path/to/MCP-CLICKUP/dist/index.js"],
      "type": "local"
    }
  }
}
```

**For Antigravity (Google IDE):**

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

1. **Paste a ClickUp list URL** - The setup parses the URL and extracts the list and workspace IDs.
2. **Browse workspaces interactively** - Select from your workspaces, spaces, and lists.
3. **Enter a list ID manually** - If you already know the ID.
4. **Skip** - Configure later.

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

The server exposes 16 tools for ClickUp interaction:

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
| `create_task` | Create a complete task with all fields |
| `update_task` | Update an existing task |
| `add_comment` | Add a comment to a task |
| `delete_task` | Delete a task |

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

**ClickUp tools not appearing in IDE after setup**
Restart your IDE (OpenCode or Antigravity). Verify the configuration file has the correct format.

**Error: "Value must be an option index or uuid"**
Use the `get_custom_fields` tool to retrieve the available option UUIDs for dropdown fields. Pass the option UUID (not the display name) in the `customFields` parameter.

**Server fails to start**
Ensure Node.js v20 or later is installed. Run `npm run build` to verify the TypeScript compiles successfully. Confirm that `dist/index.js` exists.

---

## License

MIT
