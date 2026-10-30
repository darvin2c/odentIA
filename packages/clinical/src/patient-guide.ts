/**
 * La explicación de un servicio para quien se atiende: lo que se imprime en el
 * presupuesto y se ve en «Su enlace». El texto es de cada clínica, nunca del
 * código. La biblioteca solo sugiere: un texto sugerido no le llega a un
 * paciente hasta que la clínica lo guarda en su servicio.
 */
export interface PatientGuideStep {
  when: string
  what: string
}

export interface PatientGuide {
  /** «1 a 2». */
  visits?: string
  /** «60 a 90 minutos». */
  visitLength?: string
  how?: string
  includes?: string
  excludes?: string
  aftercare?: string
  /** El calendario, para lo que se reparte en el tiempo. */
  schedule?: PatientGuideStep[]
  /** Señales de alarma: cuándo llamar o ir a emergencia. */
  warnings?: string
}

export const PATIENT_GUIDE_LIMITS = {
  /** `visits` y `visitLength`. */
  short: 80,
  /** `how`, `includes`, `excludes`, `aftercare` y `warnings`. */
  text: 2000,
  scheduleRows: 24,
  scheduleWhen: 80,
  scheduleWhat: 400,
} as const

const TEXT_KEYS = ["how", "includes", "excludes", "aftercare", "warnings"] as const
const SHORT_KEYS = ["visits", "visitLength"] as const

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  const text = value.trim().slice(0, max).trim()
  return text || null
}

/**
 * Lo que venga (lo guardado o una semilla) como explicación: recorta los
 * blancos y lo que pase del límite, ignora lo que no conoce y, si no queda
 * nada, es null. La API rechaza antes lo que pasa del límite, para no perder
 * texto de quien lo escribe.
 */
export function parsePatientGuide(value: unknown): PatientGuide | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const guide: PatientGuide = {}
  for (const key of SHORT_KEYS) {
    const text = clean(raw[key], PATIENT_GUIDE_LIMITS.short)
    if (text) guide[key] = text
  }
  for (const key of TEXT_KEYS) {
    const text = clean(raw[key], PATIENT_GUIDE_LIMITS.text)
    if (text) guide[key] = text
  }
  if (Array.isArray(raw.schedule)) {
    const steps: PatientGuideStep[] = []
    for (const row of raw.schedule.slice(0, PATIENT_GUIDE_LIMITS.scheduleRows)) {
      const step = row && typeof row === "object" ? (row as Record<string, unknown>) : {}
      const when = clean(step.when, PATIENT_GUIDE_LIMITS.scheduleWhen)
      const what = clean(step.what, PATIENT_GUIDE_LIMITS.scheduleWhat)
      if (when && what) steps.push({ when, what })
    }
    if (steps.length > 0) guide.schedule = steps
  }
  return Object.keys(guide).length > 0 ? guide : null
}
