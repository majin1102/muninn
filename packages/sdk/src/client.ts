import type {
  AddTurnRequest,
  AddTurnResponse,
  ErrorResponse,
  GetDetailRequest,
  GetTimelineRequest,
  ListRequest,
  MemoryResponse,
  RecallRequest,
} from '@munnai/types';

export class MunnaiClient {
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:8080') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async parseJsonResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const error = await response.json() as ErrorResponse;
      throw new Error(`${error.errorCode}: ${error.errorMessage}`);
    }

    return response.json() as Promise<T>;
  }

  private buildUrl<T extends object>(path: string, params?: T): string {
    const url = new URL(`${this.baseUrl}${path}`);

    for (const [key, value] of Object.entries((params ?? {}) as Record<string, unknown>)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  async addTurn(request: AddTurnRequest): Promise<AddTurnResponse> {
    const response = await fetch(`${this.baseUrl}/api/v1/message/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    return this.parseJsonResponse<AddTurnResponse>(response);
  }

  async recall(request: RecallRequest): Promise<MemoryResponse> {
    const response = await fetch(this.buildUrl('/api/v1/recall', request));
    return this.parseJsonResponse<MemoryResponse>(response);
  }

  async list(request: ListRequest): Promise<MemoryResponse> {
    const response = await fetch(this.buildUrl('/api/v1/list', request));
    return this.parseJsonResponse<MemoryResponse>(response);
  }

  async getTimeline(request: GetTimelineRequest): Promise<MemoryResponse> {
    const response = await fetch(this.buildUrl('/api/v1/timeline', request));
    return this.parseJsonResponse<MemoryResponse>(response);
  }

  async getDetail(request: GetDetailRequest): Promise<MemoryResponse> {
    const response = await fetch(this.buildUrl('/api/v1/detail', request));
    return this.parseJsonResponse<MemoryResponse>(response);
  }
}
