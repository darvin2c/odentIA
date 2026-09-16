/** Error de dominio con código estable para mapear a HTTP en la API. */
export class ServiceError extends Error {
  constructor(
    public code: string,
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message)
  }
}

export function validation(message: string): ServiceError {
  return new ServiceError("VALIDATION", 400, message)
}

export function notFound(entity: string): ServiceError {
  return new ServiceError("NOT_FOUND", 404, `${entity} no encontrado`)
}

/** true si el error es violación de unique (Postgres 23505, incluso envuelto por Drizzle). */
export function isUniqueViolation(error: unknown): boolean {
  const code = (codeOf(error) ?? codeOf((error as { cause?: unknown })?.cause)) as
    | string
    | undefined
  return code === "23505"
}

function codeOf(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined
}
