import type { ApiErrorShape } from "@odentia/ui-patterns";
import { API_URL } from "./auth-client";

export class ApiError extends Error {
  shape: ApiErrorShape;
  status: number;

  constructor(status: number, shape: ApiErrorShape) {
    super(shape.message ?? `Error ${status}`);
    this.status = status;
    this.shape = shape;
  }
}

/** Fetch a la API con cookies de sesión; errores en forma ApiErrorShape. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  });
  if (!response.ok) {
    let shape: ApiErrorShape = {};
    try {
      const body = (await response.json()) as { error?: ApiErrorShape };
      shape = body.error ?? {};
    } catch {
      // respuesta no-JSON: shape vacío
    }
    throw new ApiError(response.status, shape);
  }
  return (await response.json()) as T;
}
