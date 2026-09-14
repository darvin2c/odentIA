import type { Db } from "@odentia/db";
import { ServiceError, type Storage } from "@odentia/services";
import type { Context } from "hono";
import type { ZodIssue } from "zod";
import { errorBody } from "../lib/error.js";

export interface CrmDeps {
  db: Db;
  secretsKey: Buffer;
  storage: Storage;
  /** CHANNEL_VALIDATE_EXTERNAL !== 'false': validar contra el proveedor real. */
  validateExternal: boolean;
  /** Base pública del API para construir webhookUrl (p.ej. BETTER_AUTH_URL). */
  webhookBaseUrl: string;
}

export function validationError(c: Context, issues: ZodIssue[]) {
  return c.json(errorBody(c, "VALIDATION", issues[0]?.message ?? "Datos inválidos"), 400);
}

/**
 * Ejecuta un servicio dentro del contexto RLS y mapea ServiceError a su
 * código HTTP. Los errores inesperados suben al onError (500).
 */
export async function runService<T>(c: Context, status: 200 | 201, fn: () => Promise<T>) {
  try {
    return c.json({ data: await fn() }, status);
  } catch (e) {
    if (e instanceof ServiceError) {
      return c.json(errorBody(c, e.code, e.message), e.status);
    }
    throw e;
  }
}

/** Mapea ServiceError a respuesta HTTP; resto de errores suben al onError (500). */
export function serviceErrorResponse(c: Context, e: unknown): Response | null {
  if (e instanceof ServiceError) {
    return c.json(errorBody(c, e.code, e.message), e.status);
  }
  return null;
}
