import axios, { AxiosInstance } from "axios";

const CLICKUP_BASE_URL = "https://api.clickup.com/api/v2";

// ── Types ──────────────────────────────────────────────────────────

export interface CustomFieldValue {
  id: string;
  value: unknown;
}

export interface CreateTaskParams {
  name: string;
  description?: string;
  status?: string;
  priority?: 1 | 2 | 3 | 4;
  dueDate?: string;
  startDate?: string;
  tags?: string[];
  assignees?: number[];
  parent?: string; // task ID for creating subtasks
  customFields?: CustomFieldValue[];
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

export interface StatusInfo {
  status: string;
  type: string;
  orderindex: number;
  color?: string;
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

  async getListStatuses(listId: string): Promise<{
    name: string;
    statuses: StatusInfo[];
  }> {
    const res = await this.client.get(`/list/${listId}`);
    return {
      name: res.data.name as string,
      statuses: res.data.statuses as StatusInfo[],
    };
  }

  // ── Actions ────────────────────────────────────────────────────

  async createTask(listId: string, params: CreateTaskParams) {
    const body: Record<string, unknown> = {
      name: params.name,
      description: params.description ?? "",
    };

    if (params.status) {
      body.status = params.status;
    }

    if (params.priority !== undefined) {
      body.priority = params.priority;
    }

    // Helper: parse fecha a timestamp ms
    const parseDate = (val?: string): number | undefined => {
      if (!val) return undefined;
      return /^\d+$/.test(val) ? parseInt(val, 10) : new Date(val).getTime();
    };

    const dueTs = parseDate(params.dueDate);
    if (dueTs !== undefined) body.due_date = dueTs;

    const startTs = parseDate(params.startDate);
    if (startTs !== undefined) body.start_date = startTs;

    if (params.tags && params.tags.length > 0) {
      body.tags = params.tags;
    }

    if (params.assignees && params.assignees.length > 0) {
      body.assignees = { add: params.assignees };
    }

    if (params.parent) {
      body.parent = params.parent;
    }

    if (params.customFields && params.customFields.length > 0) {
      body.custom_fields = params.customFields;
    }

    const response = await this.client.post(`/list/${listId}/task`, body);
    return response.data;
  }

  async getListFields(listId: string): Promise<{
    name: string;
    fields: unknown[];
  }> {
    const res = await this.client.get(`/list/${listId}/field`);
    return {
      name: "", // name comes from getListStatuses
      fields: res.data.fields as unknown[],
    };
  }

  async getTask(taskId: string) {
    const res = await this.client.get(`/task/${taskId}`);
    return res.data;
  }

  async updateTask(taskId: string, params: Partial<CreateTaskParams>) {
    const body: Record<string, unknown> = {};

    if (params.name) body.name = params.name;
    if (params.description !== undefined) body.description = params.description;
    if (params.status) body.status = params.status;
    if (params.priority !== undefined) body.priority = params.priority;

    const parseDate = (val?: string): number | undefined => {
      if (!val) return undefined;
      return /^\d+$/.test(val) ? parseInt(val, 10) : new Date(val).getTime();
    };

    const dueTs = parseDate(params.dueDate);
    if (dueTs !== undefined) body.due_date = dueTs;

    const startTs = parseDate(params.startDate);
    if (startTs !== undefined) body.start_date = startTs;

    if (params.tags) body.tags = params.tags;

    if (params.assignees && params.assignees.length > 0) {
      body.assignees = { add: params.assignees };
    }

    if (params.customFields) {
      body.custom_fields = params.customFields;
    }

    const res = await this.client.put(`/task/${taskId}`, body);
    return res.data;
  }

  async deleteTask(taskId: string) {
    await this.client.delete(`/task/${taskId}`);
  }

  async getTasks(
    listId: string,
    filters?: { statuses?: string[]; page?: number; orderBy?: string; reverse?: boolean; includeClosed?: boolean },
  ) {
    const params: Record<string, string | number | boolean> = { page: filters?.page ?? 0 };
    if (filters?.orderBy) params.order_by = filters.orderBy;
    if (filters?.reverse) params.reverse = true;
    if (filters?.includeClosed) params.include_closed = true;
    if (filters?.statuses?.length) params.statuses = filters.statuses.join(",");

    const res = await this.client.get(`/list/${listId}/task`, { params });
    return res.data as { tasks: unknown[] };
  }

  async getComments(taskId: string) {
    const res = await this.client.get(`/task/${taskId}/comment`);
    return res.data as { comments: unknown[] };
  }

  async addComment(taskId: string, commentText: string) {
    const res = await this.client.post(`/task/${taskId}/comment`, {
      comment_text: commentText,
    });
    return res.data;
  }
}
