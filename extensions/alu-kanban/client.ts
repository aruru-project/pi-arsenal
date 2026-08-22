export class KanbanApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "KanbanApiError";
    this.status = status;
    this.payload = payload;
  }
}

export interface KanbanClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class KanbanClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: KanbanClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async json(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.token}`,
    };
    let requestBody: BodyInit | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }

    const response = await this.request(path, { method, headers, body: requestBody }, signal);
    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return { status: response.status };
    }

    const text = await response.text();
    if (!text.trim()) return { status: response.status };
    try {
      return JSON.parse(text);
    } catch {
      throw new KanbanApiError("Kanban API returned a non-JSON response", response.status, text.slice(0, 500));
    }
  }

  async multipart(
    method: string,
    path: string,
    form: FormData,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.request(path, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: form,
    }, signal);

    const text = await response.text();
    if (!text.trim()) return { status: response.status };
    try {
      return JSON.parse(text);
    } catch {
      throw new KanbanApiError("Kanban API returned a non-JSON response", response.status, text.slice(0, 500));
    }
  }

  async download(path: string, signal?: AbortSignal): Promise<{ data: Uint8Array; filename?: string; contentType?: string }> {
    const response = await this.request(path, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}` },
    }, signal);
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1];
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      filename,
      contentType: response.headers.get("content-type") ?? undefined,
    };
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(new Error("Kanban API request timed out")), this.timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: combinedSignal });
      if (response.ok) return response;

      const text = await response.text();
      let payload: unknown = text.slice(0, 1000);
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        // Keep the bounded text payload.
      }
      const message = this.errorMessage(payload) || `Kanban API request failed with HTTP ${response.status}`;
      throw new KanbanApiError(message, response.status, payload);
    } finally {
      clearTimeout(timeout);
    }
  }

  private errorMessage(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const data = payload as { error?: unknown; errors?: unknown };
    if (typeof data.error === "string") return data.error;
    if (Array.isArray(data.errors)) return data.errors.map(String).join(", ");
    return undefined;
  }
}
