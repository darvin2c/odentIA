/**
 * Lo que comparten los cálculos de las respuestas correctas de Argos
 * (`eval-argos-respuestas.ts`): la clínica, el mes en curso de Reportes y las
 * mismas ayudas de formato y de SQL. Cada área de las preguntas nuevas del
 * dueño (`eval/argos-owner.json`) tiene su archivo en esta carpeta.
 */
import type { Db } from "@odentia/db"
import type { FigureContext, FigureGroup, FigureResult, ReportScope } from "@odentia/services"
import type { SQL } from "drizzle-orm"

/** La respuesta correcta de una pregunta, calculada sin modelo. */
export interface GoldenAnswer {
  /** La respuesta correcta, como la diría Argos. */
  respuesta: string
  /** Cómo se calculó, en palabras. */
  criterio: string
  /** Otra lectura de la pregunta que da otra cifra: el dueño elige. */
  nota?: string
  datos: Record<string, unknown>
}

export interface GoldenHelpers {
  tx: Db
  org: string
  now: Date
  /** El mes en curso de Reportes (hasta ahora), con la zona y la moneda de la clínica. */
  scope: ReportScope
  ctx: FigureContext
  tz: string
  /** Céntimos con el formato de la clínica. */
  money: (cents: number | null | undefined) => string
  /** Una cifra de Reportes: del mes en curso o de otro periodo (`mes_pasado`, `2026-08`, `2026-04-01..2026-09-30`). */
  fig: (figure: string, group?: FigureGroup, period?: string) => Promise<FigureResult>
  /** El valor de una cifra con su unidad. */
  show: (result: FigureResult, value?: number | null) => string
  /** Hoy, en el día de la clínica. */
  today: SQL
  /** El día de la clínica de un instante. */
  dayOf: (column: SQL) => SQL
  /** Inicio del mes en curso (ISO). */
  monthStart: string
  /** `join patient p … join contact pp …` de un paciente: el nombre es `pp.display_name`. */
  joinPerson: (patientColumn: SQL) => SQL
  /** El nombre de lo que se cobró (`patient_charge c`): su servicio, su producto o lo escrito. */
  conceptName: SQL
  /** Los joins que necesita `conceptName`. */
  conceptJoins: SQL
  /** «a (1), b (2)». */
  listOf: (rows: Array<{ name: string; value: string }>) => string
}

export type GoldenSolvers = Record<string, () => Promise<GoldenAnswer>>
