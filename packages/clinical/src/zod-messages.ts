import { z } from "zod"

/**
 * Lo que dice una regla de Zod sin mensaje propio, en el español de la
 * interfaz («Escribe…», «Elige…»). La misma voz en el navegador y en la API:
 * el error del servidor se pinta junto al campo, así que no puede llegar en
 * inglés ni en la jerga del validador («se esperaba texto»).
 *
 * Se instala una vez por proceso con `configureZodMessages()` (la API y cada
 * app al arrancar). Un mensaje escrito en el esquema siempre gana; esto es
 * solo lo que falta.
 */
export const zodMessages: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case "invalid_type":
      if (issue.input === undefined || issue.input === null || issue.input === "") return REQUIRED
      if (issue.expected === "int") return "Escribe un número entero."
      if (issue.expected === "number" || issue.expected === "bigint") return "Escribe un número."
      if (issue.expected === "date") return "Escribe una fecha válida."
      return CHECK
    case "too_small":
      return tooSmall(issue.origin, issue.minimum, issue.inclusive !== false)
    case "too_big":
      return tooBig(issue.origin, issue.maximum, issue.inclusive !== false)
    case "invalid_format":
      return formatMessage(issue.format)
    case "not_multiple_of":
      return `Escribe un múltiplo de ${String(issue.divisor)}.`
    case "invalid_value":
      return "Elige una opción de la lista."
    case "unrecognized_keys":
      return "Hay datos que no se esperaban."
    default:
      return CHECK
  }
}

/** Instala `zodMessages` para todo Zod de este proceso: la API y cada app al arrancar. */
export function configureZodMessages(): void {
  z.config({ customError: zodMessages })
}

const REQUIRED = "Completa este dato."
const CHECK = "Revisa este dato."

function tooSmall(origin: string, minimum: number | bigint | Date, inclusive: boolean): string {
  const min = String(minimum)
  switch (origin) {
    case "string":
      return Number(minimum) <= 1 ? REQUIRED : `Escribe al menos ${min} caracteres.`
    case "array":
    case "set":
      return Number(minimum) <= 1 ? "Elige al menos uno." : `Elige al menos ${min}.`
    case "date":
      return "La fecha es anterior a la permitida."
    case "file":
      return "El archivo está vacío o es demasiado pequeño."
    default:
      return inclusive ? `Debe ser ${min} o más.` : `Debe ser mayor que ${min}.`
  }
}

function tooBig(origin: string, maximum: number | bigint | Date, inclusive: boolean): string {
  const max = String(maximum)
  switch (origin) {
    case "string":
      return `Escribe como mucho ${max} caracteres.`
    case "array":
    case "set":
      return `Como mucho ${max}.`
    case "date":
      return "La fecha es posterior a la permitida."
    case "file":
      return "El archivo es demasiado grande."
    default:
      return inclusive ? `Debe ser ${max} o menos.` : `Debe ser menor que ${max}.`
  }
}

function formatMessage(format: string): string {
  switch (format) {
    case "email":
      return "Escribe un correo válido, como nombre@ejemplo.com."
    case "url":
      return "Escribe una dirección web válida, como https://ejemplo.com."
    case "e164":
      return "Escribe el teléfono completo, con el código de su país."
    case "date":
    case "datetime":
      return "Escribe una fecha válida."
    case "time":
      return "Escribe una hora válida."
    case "uuid":
    case "guid":
    case "cuid":
    case "cuid2":
    case "ulid":
    case "nanoid":
      return "Elige una opción de la lista."
    default:
      return "Revisa el formato de este dato."
  }
}
