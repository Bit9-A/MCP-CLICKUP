import axios, { AxiosInstance } from "axios";

const CLICKUP_BASE_URL = "https://api.clickup.com/api/v2";

// ── Types ──────────────────────────────────────────────────────────

export interface CreateTaskParams {
  name: string;
  description?: string;
  priority?: 1 | 2 | 3 | 4;
  dueDate?: string;
  assignees?: number[];
}

export interface Workspace {
  id: string;
  name: string;
  color?: string;
  members?: unknown[];
}

export interface Space {
  id: string;
  name: string;
  private: boolean;
  admin_can_manage?: boolean;
  archived?: boolean;
}

export interface Folder {
  id: string;
  name: string;
  hidden: boolean;
  archived?: boolean;
  task_count?: string;
}

export interface List {
  id: string;
  name: string;
  archived?: boolean;
  task_count?: number;
  permission_level?: string;
  folder?: { id: string; name: string; hidden: boolean; access: boolean };
}

// ── Client ─────────────────────────────────────────────────────────

export class ClickUpClient {
  private client: AxiosInstance;

  constructor(apiKey: string) {
    this.client = axios.create({
      baseURL: CLICKUP_BASE_URL,
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
    });
  }

  // ── Discovery ──────────────────────────────────────────────────

  async getWorkspaces(): Promise<Workspace[]> {
    const res = await this.client.get("/team");
    return res.data.teams as Workspace[];
  }

  async getSpaces(teamId: string): Promise<Space[]> {
    const res = await this.client.get(`/team/${teamId}/space`);
    return res.data.spaces as Space[];
  }

  async getFolders(spaceId: string): Promise<Folder[]> {
    const res = await this.client.get(`/space/${spaceId}/folder`);
    return res.data.folders as Folder[];
  }

  async getFolderlessLists(spaceId: string): Promise<List[]> {
    const res = await this.client.get(`/space/${spaceId}/list`);
    return res.data.lists as List[];
  }

  async getFolderLists(folderId: string): Promise<List[]> {
    const res = await this.client.get(`/folder/${folderId}/list`);
    return res.data.lists as List[];
  }

  // ── Actions ────────────────────────────────────────────────────

  async createTask(listId: string, params: CreateTaskParams) {
    const body: Record<string, unknown> = {
      name: params.name,
      description: params.description ?? "",
    };

    if (params.priority !== undefined) {
      body.priority = params.priority;
    }

    if (params.dueDate) {
      const due = /^\d+$/.test(params.dueDate)
        ? parseInt(params.dueDate, 10)
        : new Date(params.dueDate).getTime();
      body.due_date = due;
    }

    if (params.assignees && params.assignees.length > 0) {
      body.assignees = { add: params.assignees };
    }

    const response = await this.client.post(`/list/${listId}/task`, body);
    return response.data;
  }
}
