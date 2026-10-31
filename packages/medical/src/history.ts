/**
 * Los antecedentes médicos de latidIA (issue 229, decisión 13): embarazo y
 * lactancia con su fecha, gineco-obstétricos, hábitos y vacunas. Viven en la
 * «Entrevista de salud» de la ficha (`patient_anamnesis.answers`), versionada
 * como el resto, cada grupo con su clave:
 *
 * - `embarazoLactancia`: `{ embarazo?: { estado, fecha, semanas? }, lactancia?: { estado, fecha } }`.
 *   La fecha es el día en que se dijo: la receta (entrega 6) sabe si sigue
 *   vigente y la ficha dice «registrado el …».
 * - `ginecoObstetricos`: `{ fur?, gestas?, partos?, cesareas?, metodo? }`.
 * - `habitos`: `{ tabaco?, cigarrillosDia?, alcohol?, actividadFisica? }`.
 * - `vacunas`: `[{ vacuna, fecha? }]`, con el nombre escrito: todavía no hay
 *   una lista de vacunas codificada (CVX) para elegir.
 *
 * Las demás claves de la entrevista son comunes y no se tocan aquí.
 */

export const MEDICAL_INTERVIEW_GROUPS = [
  "embarazoLactancia",
  "ginecoObstetricos",
  "habitos",
  "vacunas",
] as const

export const YES_NO = ["si", "no"] as const
export type YesNo = (typeof YES_NO)[number]

export const CONTRACEPTION_METHODS = {
  ninguno: "Ninguno",
  preservativo: "Preservativo",
  pildora: "Píldora",
  inyectable: "Inyectable",
  implante: "Implante",
  diu: "DIU",
  ligadura: "Ligadura de trompas",
  otro: "Otro",
} as const
export type ContraceptionMethod = keyof typeof CONTRACEPTION_METHODS

export const TOBACCO = { nunca: "Nunca fumó", fuma: "Fuma", dejo: "Lo dejó" } as const
export const ALCOHOL = { no: "No toma", ocasional: "Ocasional", frecuente: "Frecuente" } as const
export const ACTIVITY = { sedentaria: "Sedentaria", ligera: "Ligera", regular: "Regular" } as const

export interface PregnancyStatement {
  estado: YesNo
  /** El día en que se dijo (YYYY-MM-DD). */
  fecha: string
  /** Las semanas a esa fecha, si se saben. */
  semanas?: number
}

export interface BreastfeedingStatement {
  estado: YesNo
  fecha: string
}

export interface MedicalHistory {
  embarazoLactancia?: { embarazo?: PregnancyStatement; lactancia?: BreastfeedingStatement }
  ginecoObstetricos?: {
    /** Fecha de la última regla. */
    fur?: string
    gestas?: number
    partos?: number
    cesareas?: number
    metodo?: ContraceptionMethod
  }
  habitos?: {
    tabaco?: keyof typeof TOBACCO
    cigarrillosDia?: number
    alcohol?: keyof typeof ALCOHOL
    actividadFisica?: keyof typeof ACTIVITY
  }
  vacunas?: Array<{ vacuna: string; fecha?: string }>
}

const MAX_VACCINES = 40

type Rec = Record<string, unknown>
const isRec = (value: unknown): value is Rec =>
  !!value && typeof value === "object" && !Array.isArray(value)
const isDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)

/** Un dato que no pasa: el mensaje y la ruta del dato en la entrevista («habitos.cigarrillosDia»). */
class HistoryError extends Error {
  constructor(
    message: string,
    readonly field: string | undefined,
  ) {
    super(message)
  }
}
const fail = (message: string, field?: string): never => {
  throw new HistoryError(message, field)
}

function only(group: Rec, name: string, keys: readonly string[], field: string): void {
  const extra = Object.keys(group).find((key) => !keys.includes(key))
  if (extra) fail(`${name}: no tiene el dato ${extra}`, field)
}
function pastDate(value: unknown, label: string, today: string, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (!isDate(value)) fail(`${label}: elige una fecha válida`, field)
  if ((value as string) > today) fail(`${label}: la fecha no puede ser futura`, field)
  return value as string
}
function count(value: unknown, label: string, max: number, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max)
    fail(`${label}: un número entero de 0 a ${max}`, field)
  return value as number
}
function choice<T extends string>(
  value: unknown,
  options: Record<T, string>,
  label: string,
  field: string,
): T | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || !(value in options)) fail(`${label}: elige una de las opciones`, field)
  return value as T
}

function statement(value: unknown, label: string, today: string, withWeeks: boolean, field: string) {
  if (value === undefined || value === null) return undefined
  if (!isRec(value)) return fail(`${label}: falta si o no`, field)
  only(value, label, withWeeks ? ["estado", "fecha", "semanas"] : ["estado", "fecha"], field)
  if (!(YES_NO as readonly unknown[]).includes(value.estado)) fail(`${label}: el estado es sí o no`, `${field}.estado`)
  const fecha = pastDate(value.fecha, label, today, `${field}.fecha`)
  if (!fecha) fail(`${label}: falta la fecha en que se dijo`, `${field}.fecha`)
  const semanas =
    withWeeks && value.estado === "si"
      ? count(value.semanas, `${label}, semanas`, 42, `${field}.semanas`)
      : undefined
  return {
    estado: value.estado as YesNo,
    fecha: fecha as string,
    ...(semanas === undefined ? {} : { semanas }),
  }
}

/**
 * Valida y limpia los grupos médicos de la entrevista; lo demás queda igual.
 * Un grupo vacío se quita. `today` (YYYY-MM-DD) es el día de la clínica. Un
 * error dice, en `field`, la ruta de su dato en la entrevista
 * («ginecoObstetricos.partos»; la regla entre los tres conteos, el grupo).
 */
export function parseMedicalHistory(
  answers: Rec,
  today: string,
): { ok: true; value: Rec } | { ok: false; error: string; field?: string } {
  try {
    const out: Rec = { ...answers }
    const set = (key: string, value: Rec | unknown[] | undefined) => {
      const empty =
        value === undefined ||
        (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0)
      if (empty) delete out[key]
      else out[key] = value
    }
    const pregnancy = answers.embarazoLactancia
    if (pregnancy !== undefined) {
      if (!isRec(pregnancy)) fail("Embarazo y lactancia debe ser un objeto", "embarazoLactancia")
      const group = pregnancy as Rec
      only(group, "Embarazo y lactancia", ["embarazo", "lactancia"], "embarazoLactancia")
      const embarazo = statement(group.embarazo, "Embarazo", today, true, "embarazoLactancia.embarazo")
      const lactancia = statement(group.lactancia, "Lactancia", today, false, "embarazoLactancia.lactancia")
      set("embarazoLactancia", {
        ...(embarazo ? { embarazo } : {}),
        ...(lactancia ? { lactancia } : {}),
      })
    }
    const gyneco = answers.ginecoObstetricos
    if (gyneco !== undefined) {
      if (!isRec(gyneco)) fail("Gineco-obstétricos debe ser un objeto", "ginecoObstetricos")
      const group = gyneco as Rec
      only(group, "Gineco-obstétricos", ["fur", "gestas", "partos", "cesareas", "metodo"], "ginecoObstetricos")
      const fur = pastDate(group.fur, "Última regla", today, "ginecoObstetricos.fur")
      const gestas = count(group.gestas, "Embarazos", 30, "ginecoObstetricos.gestas")
      const partos = count(group.partos, "Partos", 30, "ginecoObstetricos.partos")
      const cesareas = count(group.cesareas, "Cesáreas", 30, "ginecoObstetricos.cesareas")
      // La regla es de los tres conteos: se dice bajo el grupo.
      if (gestas !== undefined && (partos ?? 0) + (cesareas ?? 0) > gestas)
        fail("Los partos y las cesáreas no pueden ser más que los embarazos", "ginecoObstetricos")
      const metodo = choice(group.metodo, CONTRACEPTION_METHODS, "Método anticonceptivo", "ginecoObstetricos.metodo")
      set("ginecoObstetricos", {
        ...(fur ? { fur } : {}),
        ...(gestas === undefined ? {} : { gestas }),
        ...(partos === undefined ? {} : { partos }),
        ...(cesareas === undefined ? {} : { cesareas }),
        ...(metodo ? { metodo } : {}),
      })
    }
    const habits = answers.habitos
    if (habits !== undefined) {
      if (!isRec(habits)) fail("Hábitos debe ser un objeto", "habitos")
      const group = habits as Rec
      only(group, "Hábitos", ["tabaco", "cigarrillosDia", "alcohol", "actividadFisica"], "habitos")
      const tabaco = choice(group.tabaco, TOBACCO, "Tabaco", "habitos.tabaco")
      // Los cigarrillos al día solo se dicen de quien fuma.
      const cigarrillosDia =
        tabaco === "fuma"
          ? count(group.cigarrillosDia, "Cigarrillos al día", 100, "habitos.cigarrillosDia")
          : undefined
      const alcohol = choice(group.alcohol, ALCOHOL, "Alcohol", "habitos.alcohol")
      const actividadFisica = choice(group.actividadFisica, ACTIVITY, "Actividad física", "habitos.actividadFisica")
      set("habitos", {
        ...(tabaco ? { tabaco } : {}),
        ...(cigarrillosDia === undefined ? {} : { cigarrillosDia }),
        ...(alcohol ? { alcohol } : {}),
        ...(actividadFisica ? { actividadFisica } : {}),
      })
    }
    const vaccines = answers.vacunas
    if (vaccines !== undefined) {
      if (!Array.isArray(vaccines)) fail("Vacunas debe ser una lista", "vacunas")
      const list = vaccines as unknown[]
      if (list.length > MAX_VACCINES) fail(`Vacunas: hasta ${MAX_VACCINES}`, "vacunas")
      set(
        "vacunas",
        list.flatMap((item, index) => {
          if (!isRec(item)) return fail("Vacunas: cada una con su nombre", `vacunas.${index}.vacuna`)
          only(item, "Vacunas", ["vacuna", "fecha"], `vacunas.${index}`)
          const vacuna = typeof item.vacuna === "string" ? item.vacuna.trim() : ""
          if (vacuna.length > 120) fail("Vacunas: el nombre tiene hasta 120 caracteres", `vacunas.${index}.vacuna`)
          if (!vacuna) return []
          const fecha = pastDate(item.fecha, `Vacuna ${vacuna}`, today, `vacunas.${index}.fecha`)
          return [{ vacuna, ...(fecha ? { fecha } : {}) }]
        }),
      )
    }
    return { ok: true, value: out }
  } catch (error) {
    if (error instanceof HistoryError)
      return { ok: false, error: error.message, ...(error.field ? { field: error.field } : {}) }
    throw error
  }
}

/** Lo guardado, leído sin fallar: lo que no se entiende queda fuera. */
export function readMedicalHistory(answers: unknown, today: string): MedicalHistory {
  if (!isRec(answers)) return {}
  const picked: Rec = {}
  for (const key of MEDICAL_INTERVIEW_GROUPS) {
    const one = parseMedicalHistory({ [key]: answers[key] }, today)
    if (one.ok && one.value[key] !== undefined) picked[key] = one.value[key]
  }
  return picked as MedicalHistory
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * Las semanas de embarazo hoy: las que se dijeron más lo que pasó desde
 * entonces o, sin ellas, desde la última regla. null si no está embarazada o
 * no se sabe.
 */
export function pregnancyWeeks(history: MedicalHistory, today: string): number | null {
  const embarazo = history.embarazoLactancia?.embarazo
  if (embarazo?.estado !== "si") return null
  if (embarazo.semanas !== undefined)
    return embarazo.semanas + Math.floor(daysBetween(embarazo.fecha, today) / 7)
  const fur = history.ginecoObstetricos?.fur
  return fur ? Math.floor(daysBetween(fur, today) / 7) : null
}

/** «24/10/2026». */
export function dayWords(iso: string): string {
  const [year, month, day] = iso.split("-")
  return `${day}/${month}/${year}`
}

/** Embarazo y lactancia en una línea cada uno, con su fecha: lo primero que se lee. */
export function pregnancyLines(history: MedicalHistory, today: string): string[] {
  const lines: string[] = []
  const embarazo = history.embarazoLactancia?.embarazo
  if (embarazo) {
    const weeks = pregnancyWeeks(history, today)
    lines.push(
      embarazo.estado === "si"
        ? `Embarazada${weeks === null ? "" : `, ${weeks} semanas`} (registrado el ${dayWords(embarazo.fecha)})`
        : `No embarazada (registrado el ${dayWords(embarazo.fecha)})`,
    )
  }
  const lactancia = history.embarazoLactancia?.lactancia
  if (lactancia)
    lines.push(
      `${lactancia.estado === "si" ? "Da de lactar" : "No da de lactar"} (registrado el ${dayWords(lactancia.fecha)})`,
    )
  return lines
}

/** Los antecedentes médicos en líneas, para la ficha y la copia de la historia. */
export function medicalHistoryLines(history: MedicalHistory, today: string): string[] {
  const lines = pregnancyLines(history, today)
  const gyneco = history.ginecoObstetricos
  if (gyneco) {
    const parts = [
      gyneco.fur ? `última regla ${dayWords(gyneco.fur)}` : "",
      gyneco.gestas === undefined ? "" : `${gyneco.gestas} embarazo(s)`,
      gyneco.partos === undefined ? "" : `${gyneco.partos} parto(s)`,
      gyneco.cesareas === undefined ? "" : `${gyneco.cesareas} cesárea(s)`,
      gyneco.metodo ? `método: ${CONTRACEPTION_METHODS[gyneco.metodo].toLowerCase()}` : "",
    ].filter(Boolean)
    if (parts.length) lines.push(`Gineco-obstétricos: ${parts.join(" · ")}`)
  }
  const habits = history.habitos
  if (habits) {
    const parts = [
      habits.tabaco
        ? `tabaco: ${TOBACCO[habits.tabaco].toLowerCase()}${habits.cigarrillosDia === undefined ? "" : `, ${habits.cigarrillosDia} al día`}`
        : "",
      habits.alcohol ? `alcohol: ${ALCOHOL[habits.alcohol].toLowerCase()}` : "",
      habits.actividadFisica
        ? `actividad física: ${ACTIVITY[habits.actividadFisica].toLowerCase()}`
        : "",
    ].filter(Boolean)
    if (parts.length) lines.push(`Hábitos: ${parts.join(" · ")}`)
  }
  if (history.vacunas?.length)
    lines.push(
      `Vacunas: ${history.vacunas.map((v) => (v.fecha ? `${v.vacuna} (${dayWords(v.fecha)})` : v.vacuna)).join(", ")}`,
    )
  return lines
}
