import type {
  ErrorResponse,
  GetDetailRequest,
  GetTimelineRequest,
  ListRequest,
  MemoryResponse,
  RecallRequest,
} from '@muninn/types';

export class SidecarClient {
  private baseUrl: string;

  constructor(baseUrl: string = process.env.MUNINN_SIDECAR_BASE_URL || 'http://127.0.0.1:8080') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async recall(request: RecallRequest): Promise<MemoryResponse> {
    return this.fetchJson('/api/v1/recall', request);
  }

  async list(request: ListRequest): Promise<MemoryResponse> {
    return this.fetchJson('/api/v1/list', request);
  }

  async getTimeline(request: GetTimelineRequest): Promise<MemoryResponse> {
    return this.fetchJson('/api/v1/timeline', request);
  }

  async getDetail(request: GetDetailRequest): Promise<MemoryResponse> {
    return this.fetchJson('/api/v1/detail', request);
  }

  private async fetchJson<T extends object>(path: string, params: T): Promise<MemoryResponse> {
    const response = await fetch(this.buildUrl(path, params));
    if (!response.ok) {
      const error = await response.json() as ErrorResponse;
      throw new Error(`${error.errorCode}: ${error.errorMessage}`);
    }

    return response.json() as Promise<MemoryResponse>;
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
