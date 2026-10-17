/**
 * Un solo buscador de personas (fase 4, tablero 2b): nombre, teléfono (por sus
 * dígitos: «987 654 321» encuentra «+51987654321»), documento o correo. Lo
 * usan la lista de personas, Pacientes, la Agenda («¿Cuándo es mi cita?»), la
 * Bandeja y el CRM. Buscar nunca identifica: solo propone.
 *
 * Vive aparte de `people.ts` porque Pacientes y Contactos también lo usan y
 * `people.ts` ya depende de ellos.
 */
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"

export function personSearchCondition(
  q: string,
  columns: { displayName: SQLWrapper; phone: SQLWrapper; email: SQLWrapper; docNumber?: SQLWrapper },
): SQL {
  const text = q.trim()
  if (!text) return sql`true`
  const like = `%${text}%`
  const digits = /^[\d\s\-()+.]+$/.test(text) ? text.replace(/\D/g, "") : ""
  const phone =
    digits.length >= 4
      ? sql` or regexp_replace(coalesce(${columns.phone}, ''), '[^0-9]', '', 'g') like ${`%${digits}%`}`
      : sql``
  const doc = columns.docNumber ? sql` or ${columns.docNumber} ilike ${like}` : sql``
  return sql`(${columns.displayName} ilike ${like}${doc} or ${columns.email} ilike ${like} or ${columns.phone} ilike ${like}${phone})`
}
