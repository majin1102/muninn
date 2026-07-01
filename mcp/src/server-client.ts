import { resolveMuninnServerBaseUrl } from '@muninn/common';

export type RecallInput = {
  query: string;
  budget?: number;
  top_k?: number;
};

export type ListInput = {
  query: string;
  top_k?: number;
};

export type ReadInput = {
  context_ids: string[];
};

export type ExplainInput = {
  context_id: string;
};

type SessionIdentity = {
  project: string;
  sessionId: string;
  agent: string;
};

export class ServerClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = resolveMuninnServerBaseUrl()) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  recall(request: RecallInput): Promise<string> {
    return this.postText('/api/v1/mcp/recall', request);
  }

  list(request: ListInput): Promise<string> {
    return this.postText('/api/v1/mcp/list', {
      ...request,
      session_identity: this.currentSessionIdentity(),
    });
  }

  read(request: ReadInput): Promise<string> {
    return this.postText('/api/v1/mcp/read', request);
  }

  explain(request: ExplainInput): Promise<string> {
    return this.postText('/api/v1/mcp/explain', request);
  }

  private async postText(path: string, body: unknown): Promise<string> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text.trim() || `Muninn request failed with status ${response.status}`);
    }
    return text;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    const token = process.env.MUNINN_DESKTOP_TOKEN;
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private currentSessionIdentity(): SessionIdentity | undefined {
    const project = process.env.MUNINN_SESSION_PROJECT;
    const sessionId = process.env.MUNINN_SESSION_ID;
    const agent = process.env.MUNINN_SESSION_AGENT;
    if (!project || !sessionId || !agent) {
      return undefined;
    }
    return { project, sessionId, agent };
  }
}
