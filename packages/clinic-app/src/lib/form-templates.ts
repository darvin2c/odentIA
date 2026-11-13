import type { FormFieldDef, FormSectionDef, FormTemplate } from "./clinical-forms"

/**
 * Lo que «Formularios propios» decide sin tocar el servidor: qué formularios
 * están en la lista y cuáles ya no se usan, las palabras de cada confirmación
 * y las claves de las preguntas nuevas del constructor.
 */

/** Las versiones de una plantilla, de la más nueva a la más antigua. */
export function byTemplate<T extends { key: string; version: number; title: string }>(templates: T[]): T[][] {
  const byKey = new Map<string, T[]>()
  for (const item of templates) {
    const list = byKey.get(item.key) ?? []
    list.push(item)
    byKey.set(item.key, list)
  }
  return [...byKey.values()]
    .map((versions) => versions.sort((a, b) => b.version - a.version))
    .sort((a, b) => (a[0]?.title ?? "").localeCompare(b[0]?.title ?? "", "es"))
}

/** Un formulario que se dejó de usar: la última versión que estuvo en uso y cuándo se dejó. */
export interface UnusedTemplate {
  last: FormTemplate
  /** Una versión archivada ya no cambia: su última modificación es el momento en que se dejó de usar. */
  leftAt: string
}

/**
 * La lista y «Ya no se usan». Un formulario ya no se usa cuando estuvo en uso
 * (alguna versión se publicó) y hoy no tiene versión vigente ni borrador; con
 * un borrador sigue en la lista, porque se vuelve a usar publicándolo. El
 * borrador que se archivó sin publicarse nunca se usó: sigue en la lista.
 */
export function templateGroups(templates: FormTemplate[]): { listed: FormTemplate[][]; unused: UnusedTemplate[] } {
  const listed: FormTemplate[][] = []
  const unused: UnusedTemplate[] = []
  for (const versions of byTemplate(templates)) {
    const open = versions.some((version) => version.status !== "archivado")
    const last = versions.find((version) => version.publishedAt !== null)
    if (!open && last) unused.push({ last, leftAt: last.updatedAt })
    else listed.push(versions)
  }
  return { listed, unused }
}

/** El cuestionario que hoy reciben los pacientes (lo dice el servidor), si hay alguno. */
export function reachingPatients(templates: readonly FormTemplate[]): FormTemplate | undefined {
  return templates.find((template) => template.reachesPatients === true)
}

/** Publicado «que responde el paciente», pero a los pacientes les llega otro. */
export function publishedButNotReaching(version: FormTemplate): boolean {
  return version.status === "publicado" && version.respondent === "portal" && version.reachesPatients === false
}

const STATUS_WORDS: Record<FormTemplate["status"], string> = {
  borrador: "borrador",
  publicado: "vigente",
  archivado: "archivada",
}

/** El estado de una versión en su etiqueta: de los cuestionarios del paciente, «vigente» es solo el que les llega. */
export function versionStatusWords(version: FormTemplate): string {
  return publishedButNotReaching(version) ? "no llega a los pacientes" : STATUS_WORDS[version.status]
}

/** La línea bajo el título: qué versión está en uso y, si lo responde el paciente, si es el que le llega. */
export function currentLine(versions: FormTemplate[], templates: readonly FormTemplate[]): string {
  const draft = versions.find((version) => version.status === "borrador")
  const current = versions.find((version) => version.status === "publicado")
  const draftWords = draft ? ` · borrador de la versión ${draft.version}` : ""
  if (!current) return `Sin versión vigente${draftWords}`
  if (publishedButNotReaching(current)) {
    const reaching = reachingPatients(templates)
    return `Versión ${current.version} publicada, pero no les llega: los pacientes reciben ${reaching ? `«${reaching.title}»` : "otro cuestionario"}${draftWords}`
  }
  const reaches = current.reachesPatients === true ? " · es el que reciben los pacientes con cita por venir" : ""
  return `Vigente: versión ${current.version}${reaches}${draftWords}`
}

const KEEPS = "Lo ya respondido conserva su título y sus preguntas."
const FROZEN = "Una versión publicada ya no se edita: para cambiarla se prepara la siguiente."

/** Lo que pasa al publicar un borrador, dicho antes de publicarlo. */
export function publishWords(draft: FormTemplate, templates: readonly FormTemplate[]): string {
  const replaced = templates.find((template) => template.key === draft.key && template.status === "publicado")
  if (draft.respondent === "portal") {
    const reaching = reachingPatients(templates)
    // Otro cuestionario es el que hoy les llega: publicar este lo reemplaza, aunque el otro siga publicado.
    if (reaching && reaching.key !== draft.key) {
      return [
        `Desde ese momento lo reciben los pacientes con cita por venir, en lugar de «${reaching.title}», que sigue publicado pero deja de llegarles.`,
        replaced ? `La versión ${replaced.version} se archiva.` : "",
        replaced ? KEEPS : FROZEN,
      ]
        .filter(Boolean)
        .join(" ")
    }
    if (replaced) {
      return `Desde ese momento los pacientes con cita por venir reciben la versión ${draft.version}, en lugar de la ${replaced.version}, que se archiva. ${KEEPS}`
    }
    return `Desde ese momento lo reciben los pacientes con cita por venir, para responderlo antes de venir. ${FROZEN}`
  }
  if (replaced) {
    // La versión anterior la respondía el paciente y esta, el equipo: deja de llegarle.
    const stops = replaced.reachesPatients === true ? " Como ahora lo responde el equipo, los pacientes dejan de recibirlo." : ""
    return `La versión ${replaced.version} se archiva y los formularios nuevos usarán la ${draft.version}.${stops} ${KEEPS}`
  }
  return `Quedará disponible para responder en la ficha. ${FROZEN}`
}

/** Lo que pasa al dejar de usar un formulario en uso. */
export function leaveWords(current: FormTemplate, templates: readonly FormTemplate[]): string {
  const again = "Puedes volver a usarlo cuando quieras."
  if (current.respondent !== "portal") {
    return `Deja de ofrecerse en «Nuevo» › «Formulario». Lo ya llenado sigue en cada paciente, con sus preguntas. ${again}`
  }
  const kept = `Lo que ya respondieron sigue en cada paciente. ${again}`
  if (publishedButNotReaching(current)) {
    const reaching = reachingPatients(templates)
    return `Hoy no les llega a los pacientes${reaching ? `: reciben «${reaching.title}»` : ""}, así que para ellos nada cambia. ${kept}`
  }
  // Los otros cuestionarios del paciente que siguen publicados: con uno solo, se sabe cuál les llegará.
  const others = templates.filter(
    (template) => template.key !== current.key && template.status === "publicado" && template.respondent === "portal",
  )
  const instead =
    others.length === 0
      ? "y no recibirán ningún cuestionario antes de su cita."
      : others.length === 1
        ? `y en su lugar les llegará «${others[0]?.title}», que sigue publicado.`
        : "y en su lugar les llegará otro de los que siguen publicados: la lista dirá cuál."
  return `Los pacientes con cita por venir dejan de recibirlo, ${instead} ${kept}`
}

/**
 * Lo que pasa al volver a usar un cuestionario que responde el paciente: empieza a
 * llegarles, y eso se confirma. Null si lo llena el equipo: se vuelve a usar sin preguntar.
 */
export function reuseWords(last: FormTemplate, templates: readonly FormTemplate[]): string | null {
  if (last.respondent !== "portal") return null
  const reaching = reachingPatients(templates)
  return reaching
    ? `Desde ese momento lo reciben los pacientes con cita por venir, en lugar de «${reaching.title}», que sigue publicado pero deja de llegarles. Tendrá las mismas preguntas.`
    : "Desde ese momento lo reciben los pacientes con cita por venir, con las mismas preguntas."
}

// ---------------------------------------------------------------------------
// El constructor: preguntas nuevas y sus claves
// ---------------------------------------------------------------------------

export function slugifyLabel(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
  return base || "campo"
}

/**
 * Una clave que no tiene ninguna otra sección o pregunta de la plantilla:
 * `base` o, si ya está, `base_2`, `base_3`… Así quitar una pregunta y agregar
 * otra no repite la clave de una que sigue (el servidor las rechaza repetidas).
 */
export function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  // El servidor admite claves de hasta 49 caracteres.
  const stem = base.slice(0, 44)
  let n = 2
  while (taken.has(`${stem}_${n}`)) n += 1
  return `${stem}_${n}`
}

/** El texto de ejemplo de una pregunta nueva: se ve en gris y no es un valor. */
export const NEW_FIELD_PLACEHOLDER = "Ej.: ¿Desde cuándo tiene la molestia?"

/** Una pregunta nueva: nace vacía, de texto, con una clave provisional (`campo_N`) que nadie ve. */
export function newField(existing: readonly FormFieldDef[]): FormFieldDef {
  return {
    id: uniqueKey(`campo_${existing.length + 1}`, new Set(existing.map((field) => field.id))),
    label: "",
    type: "texto",
  }
}

/**
 * Al guardar, cada pregunta agregada en esta sesión (`provisional`) recibe su
 * clave definitiva del texto completo de la pregunta, no de la primera letra
 * tecleada; las condiciones «Mostrar si» que la nombraban la siguen. Las claves
 * de las preguntas que ya estaban no cambian.
 */
export function settleFieldKeys(sections: FormSectionDef[], provisional: ReadonlySet<string>): FormSectionDef[] {
  const all = sections.flatMap((section) => section.fields)
  const taken = new Set(all.filter((field) => !provisional.has(field.id)).map((field) => field.id))
  const renamed = new Map<string, string>()
  for (const field of all) {
    if (!provisional.has(field.id)) continue
    const key = uniqueKey(slugifyLabel(field.label), taken)
    taken.add(key)
    renamed.set(field.id, key)
  }
  if (renamed.size === 0) return sections
  return sections.map((section) => ({
    ...section,
    fields: section.fields.map((field) => ({
      ...field,
      id: renamed.get(field.id) ?? field.id,
      ...(field.showIf ? { showIf: { ...field.showIf, field: renamed.get(field.showIf.field) ?? field.showIf.field } } : {}),
    })),
  }))
}
