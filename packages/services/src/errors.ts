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
  return pgCodeOf(error) === "23505"
}

/** true si el error es violación de exclusión (Postgres 23P01, p.ej. doble reserva). */
export function isExclusionViolation(error: unknown): boolean {
  return pgCodeOf(error) === "23P01"
}

function pgCodeOf(error: unknown): string | undefined {
  const code = codeOf(error) ?? codeOf(causeOf(error))
  return typeof code === "string" ? code : undefined
}

function codeOf(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined
}

function causeOf(error: unknown): unknown {
  return error && typeof error === "object" && "cause" in error ? error.cause : undefined
}
