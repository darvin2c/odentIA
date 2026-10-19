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
import { digitsContain, foldedContains, foldedWordsMatch } from "./search-text.js"

/**
 * Nombre por palabras y sin tildes («lucia quispe» encuentra «Lucía Quispe
 * Huamán»), documento y correo por su texto, y el teléfono por sus dígitos.
 */
export function personSearchCondition(
  q: string,
  columns: { displayName: SQLWrapper; phone: SQLWrapper; email: SQLWrapper; docNumber?: SQLWrapper },
): SQL {
  const text = q.trim()
  if (!text) return sql`true`
  const digits = /^[\d\s\-()+.]+$/.test(text) ? text.replace(/\D/g, "") : ""
  const phone = digits.length >= 4 ? sql` or ${digitsContain(columns.phone, digits)}` : sql``
  const doc = columns.docNumber ? sql` or ${foldedContains(columns.docNumber, text)}` : sql``
  return sql`(${foldedWordsMatch([columns.displayName], text)}${doc} or ${foldedContains(columns.email, text)} or ${foldedContains(columns.phone, text)}${phone})`
}
