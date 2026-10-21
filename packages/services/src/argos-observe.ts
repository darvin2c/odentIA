/**
 * Lo que Argos ve del resultado de un cálculo (ADR 0076, decisión D20): para
 * revisar su cuenta antes de responder ve las cifras, las fechas y los
 * nombres de la clínica, pero nunca a las personas. Un texto se muestra solo
 * si es un nombre de la clínica (sede, equipo, especialidad, servicio,
 * producto), un valor de las listas del catálogo («atendida», «whatsapp»…) o
 * está en una columna que no es de personas; los demás llegan como «Paciente
 * 1», «Persona 2» o «texto 3». Las cifras de la frase siguen saliendo de los
 * huecos: el modelo puede leerlas, no escribirlas.
 */
import { ARGOS_CATALOG } from "./argos-catalog.js"
import type { ArgosNames } from "./argos-figures.js"
import { plainArgosName } from "./argos-figures.js"
import type { ArgosQueryResult } from "./argos-query.js"

/** Filas que ve el modelo; de las demás, cuántas son. */
export const ARGOS_OBSERVED_ROWS = 25

/** Columnas con nombres de personas: siempre se tapan, aunque el valor parezca otra cosa. */
const PERSON_COLUMN = /(^|_)(paciente|persona|nombre|interlocutor|contacto|cliente)(_|$)/

/** Columnas que nombran cosas de la clínica o estados, nunca personas que se atienden. */
const THING_COLUMN =
  /(^|_)(sede|profesional|responsable|asignada_a|indicado_por|dejada_por|especialidad|especialidades|servicio|concepto|tratamiento|producto|medio|canal|categoria|tipo|estado|etapa|momento|area|dia_semana|como_nos_conocio|motivo_cierre|promocion|proveedor|unidad|unidad_dental|rol|decision|fase|origen|antiguedad|resultado|mes|semana|dia|hora)(_|$)/

/** Los valores de las listas del catálogo: lo que va entre comillas en sus columnas («'atendida'», «'Redes sociales'»). */
const CATALOG_VALUES = new Set(
  ARGOS_CATALOG.flatMap((view) =>
    [...view.columns.matchAll(/'([^']+)'/g)].map((match) => plainArgosName(match[1] ?? "")),
  ),
)

/**
 * El resultado como lo ve el modelo, en texto: cuántas filas, las columnas con
 * su tipo, las primeras filas con las personas tapadas y avisos de lo que
 * suele estar mal (una columna vacía, todo en cero).
 */
export function argosResultForModel(
  id: string,
  result: ArgosQueryResult,
  names: ArgosNames | null,
): string {
  const known = new Set(
    names
      ? [
          ...names.sedes,
          ...names.equipo,
          ...names.especialidades,
          ...names.servicios.map((service) => service.name),
          ...names.productos,
        ].map(plainArgosName)
      : [],
  )
  // Una misma persona lleva el mismo número en todo el resultado.
  const tokens = new Map<string, string>()
  const counters = { Paciente: 0, Persona: 0, texto: 0 }
  const masked = (column: string, value: string): string => {
    const plain = plainArgosName(value)
    if (
      !PERSON_COLUMN.test(column) &&
      (known.has(plain) || CATALOG_VALUES.has(plain) || THING_COLUMN.test(column))
    )
      return value
    const kind: keyof typeof counters = /paciente/.test(column)
      ? "Paciente"
      : PERSON_COLUMN.test(column)
        ? "Persona"
        : "texto"
    const key = `${kind}|${plain}`
    const existing = tokens.get(key)
    if (existing) return existing
    counters[kind] += 1
    const token = `${kind} ${counters[kind]}`
    tokens.set(key, token)
    return token
  }
  const cell = (
    column: ArgosQueryResult["columns"][number],
    value: string | number | boolean | null | undefined,
  ): string => {
    if (value === null || value === undefined) return "(vacío)"
    if (column.kind === "text" && typeof value === "string") return masked(column.name, value)
    return String(value)
  }
  const shown = result.columns.filter((column) => !/(^|_)id$/.test(column.name))
  const lines = [
    `${id}: ${result.truncated ? `más de ${result.rows.length}` : result.rows.length} fila${result.rows.length === 1 ? "" : "s"}. Columnas: ${shown.map((column) => `${column.name} (${column.kind})`).join(", ")}.`,
  ]
  if (result.rows.length) {
    lines.push(shown.map((column) => column.name).join(" | "))
    for (const row of result.rows.slice(0, ARGOS_OBSERVED_ROWS))
      lines.push(shown.map((column) => cell(column, row[column.name])).join(" | "))
    if (result.rows.length > ARGOS_OBSERVED_ROWS)
      lines.push(`… y ${result.rows.length - ARGOS_OBSERVED_ROWS} filas más.`)
  }
  // Lo que suele delatar un error: un nombre mal escrito da cero o nada.
  const first = result.rows[0]
  const numbers = shown.filter((column) => column.kind === "number")
  if (!result.rows.length)
    lines.push("Aviso: no trajo filas. Si filtraste por un nombre, búscalo con buscar_nombres.")
  else if (
    numbers.length &&
    result.rows.every((row) =>
      numbers.every((column) => row[column.name] === null || Number(row[column.name]) === 0),
    )
  )
    lines.push(
      "Aviso: todas las cifras son cero o vacías. Revisa los nombres y el periodo antes de responder.",
    )
  const empty = first
    ? shown.filter((column) => first[column.name] === null).map((column) => column.name)
    : []
  if (empty.length) lines.push(`Aviso: en la primera fila vienen vacías ${empty.join(", ")}.`)
  return lines.join("\n")
}
