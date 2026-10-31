import type { z } from "zod"

/**
 * Error de dominio con código estable para mapear a HTTP en la API. `fields`
 * dice qué dato hay que corregir: el nombre del campo en el cuerpo de la
 * petición (`items[0].price`, ver `fieldPath`) → lo que se dice junto a él.
 * La pantalla lo pinta en su campo; `message` queda para lo demás.
 */
export class ServiceError extends Error {
  constructor(
    public code: string,
    public status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message)
  }
}

export function validation(message: string, fields?: Record<string, string>): ServiceError {
  return new ServiceError("VALIDATION", 400, message, fields)
}

/** El error es de un solo dato del cuerpo (`field`, ver `fieldPath`): se dice junto a él. */
export function invalidField(field: string, message: string): ServiceError {
  return validation(message, { [field]: message })
}

/**
 * Un mapa campo → mensaje (el de `validateDemographics`, `postalAddressErrors`…)
 * como error: el primer mensaje para quien no lee los campos y todos en
 * `fields`, cada uno con el nombre que tiene en el cuerpo (`rename`).
 */
export function fieldsError(errors: Record<string, string>, rename: (key: string) => string = (key) => key): ServiceError | null {
  const entries = Object.entries(errors)
  const first = entries[0]
  if (!first) return null
  return validation(first[1], Object.fromEntries(entries.map(([key, message]) => [rename(key), message])))
}

/** Ruta de un dato como la nombra el formulario: `["items", 0, "price"]` → `items[0].price`. */
export function fieldPath(path: readonly PropertyKey[]): string {
  let out = ""
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`
    else out += out ? `.${String(part)}` : String(part)
  }
  return out
}

/** El primer mensaje de cada dato con problema; lo que no es de un dato (la raíz) queda fuera. */
export function issueFields(issues: readonly z.core.$ZodIssue[], prefix?: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const issue of issues) {
    const path = fieldPath(issue.path)
    if (!path) continue
    const key = !prefix ? path : path.startsWith("[") ? `${prefix}${path}` : `${prefix}.${path}`
    fields[key] ??= issue.message
  }
  return fields
}

export function notFound(entity: string): ServiceError {
  return new ServiceError("NOT_FOUND", 404, `${entity} no encontrado`)
}

/** La sede no existe (o no es de la organización): `notFound` concuerda en masculino. */
export function branchNotFound(): ServiceError {
  return new ServiceError("NOT_FOUND", 404, "Sede no encontrada")
}

/**
 * Lo que se reserva no existe (o no es de la organización): en femenino, como
 * su palabra en todos los productos («Unidad dental no encontrada»).
 */
export function roomNotFound(word = "unidad dental"): ServiceError {
  return new ServiceError("NOT_FOUND", 404, `${word.charAt(0).toLocaleUpperCase("es")}${word.slice(1)} no encontrada`)
}

/** La orden de compra no existe (o no es de la organización): también en femenino. */
export function purchaseOrderNotFound(): ServiceError {
  return new ServiceError("NOT_FOUND", 404, "Orden de compra no encontrada")
}

/** true si el error es violación de unique (Postgres 23505, incluso envuelto por Drizzle). */
export function isUniqueViolation(error: unknown): boolean {
  return pgCodeOf(error) === "23505"
}

/** true si el error es violación de exclusión (Postgres 23P01, p.ej. doble reserva). */
export function isExclusionViolation(error: unknown): boolean {
  return pgCodeOf(error) === "23P01"
}

/** true si el error es violación de un CHECK o de una regla de la base que la imita (Postgres 23514). */
export function isCheckViolation(error: unknown): boolean {
  return pgCodeOf(error) === "23514"
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
