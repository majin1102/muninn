import type {
  ErrorResponse,
  GetDetailRequest,
  GetTimelineRequest,
  ListRequest,
  MemoryResponse,
  ProjectDreamRequest,
  ProjectDreamSignalsResponse,
  RecallRequest,
} from '@muninn/common';

export class ServerClient {
  private baseUrl: string;

  constructor(baseUrl: string = process.env.MUNINN_SERVER_BASE_URL || 'http://127.0.0.1:8080') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async recall(request: RecallRequest): Promise<MemoryResponse> {
    return this.fetchJson<MemoryResponse, RecallRequest>('/api/v1/recall', request);
  }

  async list(request: ListRequest): Promise<MemoryResponse> {
    return this.fetchJson<MemoryResponse, ListRequest>('/api/v1/list', request);
  }

  async getTimeline(request: GetTimelineRequest): Promise<MemoryResponse> {
    return this.fetchJson<MemoryResponse, GetTimelineRequest>('/api/v1/timeline', request);
  }

  async getDetail(request: GetDetailRequest): Promise<MemoryResponse> {
    return this.fetchJson<MemoryResponse, GetDetailRequest>('/api/v1/detail', request);
  }

  async projectSignals(request: ProjectDreamRequest): Promise<ProjectDreamSignalsResponse> {
    return this.fetchJson<ProjectDreamSignalsResponse, ProjectDreamRequest>('/api/v1/dreaming/project/signals', request);
  }

  private async fetchJson<TResponse, TParams extends object>(path: string, params: TParams): Promise<TResponse> {
    const response = await fetch(this.buildUrl(path, params));
    if (!response.ok) {
      const error = await response.json() as ErrorResponse;
      throw new Error(`${error.errorCode}: ${error.errorMessage}`);
    }

    return response.json() as Promise<TResponse>;
  }

  private buildUrl<T extends object>(path: string, params: T): string {
    const url = new URL(`${this.baseUrl}${path}`);

    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }
}
