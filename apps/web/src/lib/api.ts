import { CSRF_HEADER, CSRF_HEADER_VALUE, type ApiResponse, type ErrorCode } from "@household/shared";

export class ApiError extends Error {
  constructor(public readonly code: ErrorCode | "NETWORK_ERROR", message: string, public readonly status: number, public readonly fields?: Record<string, string>) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiResult<T> = { data: T; message: string | null };

const BASE = import.meta.env.VITE_API_URL ?? "";

/** Single entry point for every backend call: cookies, CSRF header, envelope unwrapping, friendly errors. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method: init.method ?? "GET",
      credentials: "include",
      headers: { accept: "application/json", [CSRF_HEADER]: CSRF_HEADER_VALUE, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("NETWORK_ERROR", "You seem to be offline. Check your connection and try again.", 0);
  }

  let body: ApiResponse<T> | null = null;
  try {
    body = (await res.json()) as ApiResponse<T>;
  } catch {
    // non-JSON (proxy error page, etc.)
  }
  if (!body) throw new ApiError("INTERNAL_ERROR", "Something went wrong. Please try again.", res.status);
  if (!body.success) throw new ApiError(body.error.code, body.error.message, res.status, body.error.fields);
  return { data: body.data, message: body.message };
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, signal ? { signal } : {});
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body ?? {} });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });
