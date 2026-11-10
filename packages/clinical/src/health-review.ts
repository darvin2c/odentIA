/**
 * Si los antecedentes de salud esperan la revisión de un profesional. Es una
 * sola regla para el servidor (`getPatientHealth` la manda ya decidida en
 * `reviewPending`) y la pantalla: el Resumen («Antecedentes declarados por
 * revisar») y Antecedentes («Revisar antecedentes») dicen lo mismo.
 */

/** Lo que la regla lee de los antecedentes; las fechas pueden venir como texto (API) o fecha (servidor). */
export interface HealthReviewInput {
  revision: number
  bloodGroup: string | null
  reviewedAt: Date | string | null
  allergiesReviewedAt?: Date | string | null
  reviewStatus: { allergies: string; conditions: string; medications: string }
  allergies: readonly unknown[]
  conditions: readonly unknown[]
  medications: readonly unknown[]
  latestAnamnesis: { answers?: unknown } | null
}

/** Quién escribió los antecedentes según la auditoría: el paciente al declararlos, el clínico al negar un grupo. */
export interface HealthAuthorship {
  /** El paciente o su responsable los declaró alguna vez (registro, enlace, portal). */
  declaredByPatient: boolean
  /** Un clínico marcó «Niega enfermedades» o «No toma medicación» en una atención. */
  deniedByClinician: boolean
}

/**
 * Hay información en los antecedentes (no es solo «No se le preguntó»): una
 * determinación explícita (negación o registro) en algún grupo, o entrevista.
 * La longitud de las listas por sí sola no basta: sangre, un «No» o una
 * respuesta odontológica también son información.
 */
export function hasHealthInfo(health: HealthReviewInput | null | undefined): boolean {
  if (!health) return false
  // La declaración explícita «No sé» incrementa revisión aunque no cree filas.
  if (health.revision > 0) return true
  if (health.bloodGroup != null) return true
  if (health.allergies.length > 0 || health.conditions.length > 0 || health.medications.length > 0) return true
  const status = health.reviewStatus
  if (status.allergies !== "unknown" || status.conditions !== "unknown" || status.medications !== "unknown")
    return true
  const answers = (health.latestAnamnesis?.answers ?? null) as Record<string, unknown> | null
  return !!answers && Object.keys(answers).length > 0
}

/**
 * Declaración pendiente de revisión profesional: hay información y nadie del
 * equipo la guardó después (`reviewedAt`). Distinto de «No se le preguntó».
 *
 * Con `authorship`, lo que solo anotó un clínico no es «declarado por el
 * paciente»: «Niega enfermedades» en la atención deja esos grupos en «niega»
 * sin firmar la revisión de todo (QA del 8 nov, entrega 3: la ficha pedía
 * revisar lo que el propio odontólogo había anotado). Si además el paciente
 * declaró algo, sigue pendiente: lo declarado no se da por revisado.
 */
export function healthReviewPending(
  health: HealthReviewInput | null | undefined,
  authorship?: HealthAuthorship,
): boolean {
  if (!health || health.reviewedAt || !hasHealthInfo(health)) return false
  if (authorship && authorship.deniedByClinician && !authorship.declaredByPatient) return false
  // Las alergias tienen su propia revisión: las que agregó o revisó el equipo no son «declaradas
  // por el paciente», y por sí solas no dejan pendiente lo demás.
  if (!health.allergiesReviewedAt) return true
  const status = health.reviewStatus
  const answers = (health.latestAnamnesis?.answers ?? null) as Record<string, unknown> | null
  return (
    health.bloodGroup != null ||
    health.conditions.length > 0 ||
    health.medications.length > 0 ||
    status.conditions !== "unknown" ||
    status.medications !== "unknown" ||
    (!!answers && Object.keys(answers).length > 0)
  )
}

/**
 * El comienzo de la nota de una enfermedad o un medicamento que la persona
 * declaró en su registro en línea cuando su ficha ya tenía antecedentes: así
 * lo reconoce la atención para pedir que se revise. Lo escribe el servidor
 * (`addDeclaredHealth`) y lo lee la pantalla: se cambian juntos.
 */
export const DECLARED_ONLINE_NOTE = "Lo declaró en su registro en línea"
