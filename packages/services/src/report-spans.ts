/**
 * Una cifra para varios tramos en una sola consulta: los tramos como tabla
 * (`spansSql`) que se une a la consulta y se reparte por `idx` (`bySpan`).
 * Sin dependencias de otros servicios, para que cualquiera lo use sin ciclos.
 */
import { sql, type SQL } from "drizzle-orm"
import { validation } from "./errors.js"

/** Instante como parámetro: el controlador de Postgres entrega y recibe las fechas como texto. */
export function at(date: Date): SQL {
  return sql`${date.toISOString()}::timestamptz`
}

export function safeCents(value: string | number | null | undefined): number {
  const cents = Number(value ?? 0)
  if (!Number.isSafeInteger(cents)) throw validation("El total excede el rango exacto admitido")
  return cents
}

/** Un tramo cualquiera: `[start, end)`. */
export interface Span {
  start: Date
  end: Date
}

/**
 * Los tramos como tabla `b(idx, start_at, end_at)` para unirlos a una
 * consulta: cada fila de la respuesta dice a qué tramo pertenece por `idx`.
 */
export function spansSql(spans: Span[], alias: "b" | "s" = "b"): SQL {
  if (spans.length === 0) throw validation("Sin tramos que consultar")
  return sql`(values ${sql.join(
    spans.map((span, index) => sql`(${index}::int, ${at(span.start)}, ${at(span.end)})`),
    sql`, `,
  )}) as ${sql.raw(alias)}(idx, start_at, end_at)`
}

/** El tramo que abarca a todos: para acotar una consulta antes de repartirla. */
export function hullOf(spans: Span[]): Span {
  return {
    start: new Date(Math.min(...spans.map((span) => span.start.getTime()))),
    end: new Date(Math.max(...spans.map((span) => span.end.getTime()))),
  }
}

/** Reparte filas `{ idx, ... }` en un arreglo por tramo, con su valor vacío donde no hubo nada. */
export function bySpan<Row extends { idx: number }, Value>(spans: Span[], rows: Row[], empty: () => Value, add: (value: Value, row: Row) => Value): Value[] {
  const out = spans.map(() => empty())
  for (const row of rows) {
    const index = Number(row.idx)
    if (index >= 0 && index < out.length) out[index] = add(out[index] as Value, row)
  }
  return out
}
