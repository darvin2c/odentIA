/**
 * El embarazo de la «Entrevista de salud» (`patient_anamnesis.answers`), común a
 * los productos. Se guarda con el día en que se dijo, en la forma que ya usaba
 * latidIA: `embarazoLactancia.embarazo = { estado, fecha, semanas? }`. Con la
 * fecha se dice la semana de hoy y se deja de afirmar cuando ya no puede ser
 * cierto. La fecha es la del día en que se dijo: guardar otro dato no la mueve.
 *
 * `pregnancyToday` es la única regla de si un embarazo sigue en pie, para la
 * franja de la ficha y de la atención, Antecedentes y la receta de los tres
 * productos. Sin las semanas, las cuenta desde la última regla
 * (`ginecoObstetricos.fur`, que hoy solo pregunta latidIA) si está anotada.
 *
 * Lo guardado antes en odentIA y vistIA (`antecedentesPersonales.embarazo`, un
 * sí o no sin fecha) se sigue leyendo. Su fecha es la del día en que se anotó
 * ese «sí» (`legacyPregnancySaidOn`, de las versiones de la entrevista); solo
 * queda «sin fecha», y por confirmar, lo que de verdad no la tiene.
 */

/** Un embarazo dura hasta 42 semanas (el mismo tope de la pregunta del registro). */
export const PREGNANCY_TERM_WEEKS = 42

export interface PregnancyStatement {
  estado: "si" | "no"
  /** El día en que se dijo (YYYY-MM-DD). */
  fecha: string
  /** Las semanas a esa fecha, si se saben. */
  semanas?: number
}

/** Lo que se sabe del embarazo: la forma con fecha o, en lo guardado antes, sin ella. */
export interface PregnancyRecord {
  estado: "si" | "no"
  fecha: string | null
  semanas: number | null
}

export interface PregnancyToday {
  /** Sigue en pie hoy, o ya pasó el término (o no tiene fecha) y toca confirmarlo. */
  state: "vigente" | "por_confirmar"
  /** El día en que se dijo; nulo en lo guardado antes de tener fecha. */
  saidOn: string | null
  /** Las semanas que se dijeron ese día. */
  weeksSaid: number | null
  /** Las semanas de hoy: las que se dijeron más lo que pasó desde entonces. */
  weeksToday: number | null
}

type Rec = Record<string, unknown>
const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value)

const isDay = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)

const isWeeks = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= PREGNANCY_TERM_WEEKS

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** Cuándo se anotó un embarazo guardado sin fecha: lo que se sabe por las versiones de la entrevista. */
export interface PregnancyReading {
  /** El día (YYYY-MM-DD) en que se anotó el «sí» vigente, si lo guardado no trae su fecha. */
  legacySaidOn?: string | null
}

/** Una versión de la entrevista, con su día en la clínica (YYYY-MM-DD). */
export interface InterviewVersionDay {
  answers: unknown
  day: string
}

/**
 * El día en que se anotó el embarazo vigente cuando se guardó sin fecha
 * (`antecedentesPersonales.embarazo`): el de la primera versión seguida que ya
 * decía ese «sí» con las mismas semanas. `versions` va de la más nueva a la más
 * antigua. null si lo vigente ya trae su fecha o no es un embarazo.
 */
export function legacyPregnancySaidOn(versions: readonly InterviewVersionDay[]): string | null {
  const current = versions[0] ? pregnancyRecordOf(versions[0].answers) : null
  if (!current || current.estado !== "si" || current.fecha) return null
  let day: string | null = null
  for (const version of versions) {
    const record = pregnancyRecordOf(version.answers)
    if (!record || record.estado !== "si" || record.fecha || record.semanas !== current.semanas) break
    day = version.day
  }
  return day
}

/** El embarazo guardado en la entrevista, con fecha o como se guardaba antes; null si no se respondió. */
export function pregnancyRecordOf(answers: unknown): PregnancyRecord | null {
  if (!isRec(answers)) return null
  const group = answers.embarazoLactancia
  const dated = isRec(group) ? group.embarazo : undefined
  if (isRec(dated) && (dated.estado === "si" || dated.estado === "no")) {
    return {
      estado: dated.estado,
      fecha: isDay(dated.fecha) ? dated.fecha : null,
      semanas: dated.estado === "si" && isWeeks(dated.semanas) ? dated.semanas : null,
    }
  }
  const personal = answers.antecedentesPersonales
  if (isRec(personal) && typeof personal.embarazo === "boolean") {
    return {
      estado: personal.embarazo ? "si" : "no",
      fecha: null,
      semanas: personal.embarazo && isWeeks(personal.semanasEmbarazo) ? personal.semanasEmbarazo : null,
    }
  }
  return null
}

/**
 * El embarazo a hoy, para avisarlo donde se decide: la semana calculada y si
 * sigue en pie. Pasada la semana 42 de lo dicho (o 42 semanas desde el día en
 * que se dijo, si no se saben las semanas) ya no es una alerta: se pide
 * confirmarlo. Las semanas son las que se dijeron o, sin ellas, las que dan la
 * última regla. null si no está embarazada o no se respondió.
 */
export function pregnancyToday(answers: unknown, today: string, reading: PregnancyReading = {}): PregnancyToday | null {
  const record = pregnancyRecordOf(answers)
  if (record?.estado !== "si") return null
  const saidOn = record.fecha ?? (isDay(reading.legacySaidOn) ? reading.legacySaidOn : null)
  if (!saidOn) return { state: "por_confirmar", saidOn: null, weeksSaid: record.semanas, weeksToday: null }
  const weeksSince = Math.max(0, Math.floor(daysBetween(saidOn, today) / 7))
  // Sin las semanas dichas, las de la última regla al día en que se dijo.
  const gyneco = isRec(answers) ? answers.ginecoObstetricos : undefined
  const fur = isRec(gyneco) && isDay(gyneco.fur) && gyneco.fur <= saidOn ? gyneco.fur : null
  const weeksSaid = record.semanas ?? (fur ? Math.floor(daysBetween(fur, saidOn) / 7) : null)
  const weeksToday = weeksSaid === null ? null : weeksSaid + weeksSince
  const past = (weeksToday ?? weeksSince) > PREGNANCY_TERM_WEEKS
  return {
    state: past ? "por_confirmar" : "vigente",
    saidOn,
    weeksSaid,
    weeksToday: past ? null : weeksToday,
  }
}

/**
 * El embarazo del registro («¿Estás embarazada?» y sus semanas), con el día en
 * que se dijo: lo demás de «Personales» sigue con sus claves.
 */
export function declaredPregnancy(
  personal: Rec,
  today: string,
): { statement: PregnancyStatement | null; rest: Rec } {
  const { embarazo, semanasEmbarazo, ...rest } = personal
  if (typeof embarazo !== "boolean") return { statement: null, rest }
  return {
    statement: {
      estado: embarazo ? "si" : "no",
      fecha: today,
      ...(embarazo && typeof semanasEmbarazo === "number" ? { semanas: semanasEmbarazo } : {}),
    },
    rest,
  }
}

/**
 * Valida el embarazo de una entrevista que se va a guardar y la deja en una
 * sola forma: con `embarazoLactancia.embarazo`, lo de antes
 * (`antecedentesPersonales.embarazo` y `semanasEmbarazo`) sale. Lo demás queda
 * igual. Un error dice, en `field`, la ruta de su dato en la entrevista.
 */
export function checkInterviewPregnancy(
  answers: Rec,
  today: string,
): { ok: true; value: Rec } | { ok: false; error: string; field: string } {
  const group = answers.embarazoLactancia
  if (group === undefined) return { ok: true, value: answers }
  const at = "embarazoLactancia.embarazo"
  if (!isRec(group)) return { ok: false, error: "Embarazo: falta sí o no", field: "embarazoLactancia" }
  const raw = group.embarazo
  if (raw === undefined || raw === null) return { ok: true, value: answers }
  if (!isRec(raw) || (raw.estado !== "si" && raw.estado !== "no"))
    return { ok: false, error: "Embarazo: el estado es sí o no", field: `${at}.estado` }
  if (raw.fecha === undefined || raw.fecha === null || raw.fecha === "")
    return { ok: false, error: "Embarazo: falta la fecha en que se dijo", field: `${at}.fecha` }
  // Escrita pero imposible (un 30 de febrero): no es que falte, es que ese día no existe.
  if (!isDay(raw.fecha)) return { ok: false, error: "Embarazo: esa fecha no existe", field: `${at}.fecha` }
  if (raw.fecha > today) return { ok: false, error: "Embarazo: la fecha no puede ser futura", field: `${at}.fecha` }
  const withWeeks = raw.estado === "si" && raw.semanas !== undefined && raw.semanas !== null && raw.semanas !== ""
  if (withWeeks && !isWeeks(raw.semanas))
    return {
      ok: false,
      error: `Semanas de embarazo: un número entero de 0 a ${PREGNANCY_TERM_WEEKS}`,
      field: `${at}.semanas`,
    }
  const statement: PregnancyStatement = {
    estado: raw.estado,
    fecha: raw.fecha,
    ...(withWeeks ? { semanas: raw.semanas as number } : {}),
  }
  const out: Rec = { ...answers, embarazoLactancia: { ...group, embarazo: statement } }
  if (isRec(out.antecedentesPersonales)) {
    const { embarazo: _embarazo, semanasEmbarazo: _semanas, ...personal } = out.antecedentesPersonales
    if (Object.keys(personal).length > 0) out.antecedentesPersonales = personal
    else delete out.antecedentesPersonales
  }
  return { ok: true, value: out }
}
