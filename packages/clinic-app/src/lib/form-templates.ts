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
  if (version.status === "publicado" && version.inUse === false) return "sin usar"
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

/**
 * Lo que respondía el paciente ya no se publica ni se vuelve a usar (mesa del 13 nov, entrega 8): lo que
 * se le pregunta, también antes de cada cita, está en «Preguntas al paciente». El servidor lo rechaza
 * (`PATIENT_FORMS_RETIRED`) y la confirmación lo dice antes, sin «lo reciben los pacientes».
 */
const RETIRED =
  "Lo respondía el paciente y ya no se usa: lo que se le pregunta, también antes de cada cita, está en Configuración › Preguntas al paciente. Lo ya respondido sigue en cada paciente."

/** Lo que pasa al publicar un borrador, dicho antes de publicarlo. */
export function publishWords(draft: FormTemplate, templates: readonly FormTemplate[]): string {
  if (draft.respondent === "portal") return RETIRED
  const replaced = templates.find((template) => template.key === draft.key && template.status === "publicado")
  if (replaced) return `La versión ${replaced.version} se archiva y las fichas nuevas usarán la ${draft.version}. ${KEEPS}`
  return `Quedará en uso: se llena en la atención y en «Nuevo» › «Ficha». ${FROZEN}`
}

/** Lo que pasa al apagar una ficha en uso: lo que deja de pasar, lo que se queda y cómo volver. */
export function leaveWords(current: FormTemplate): string {
  if (current.respondent === "portal") return `${RETIRED} Apagarlo no cambia nada para los pacientes.`
  const again = "Para volver a usarla, enciende su interruptor «En uso»: vuelve la misma, con sus preguntas."
  return `Deja de aparecer sola en la atención y en «Nuevo» › «Ficha». Lo ya llenado sigue en cada paciente, con sus preguntas. ${again}`
}

/** Volver a usar: uno del equipo vuelve sin preguntar (null); uno que respondía el paciente ya no vuelve. */
export function reuseWords(last: FormTemplate): string | null {
  return last.respondent === "portal" ? RETIRED : null
}

/** Sin tildes ni mayúsculas ni espacios de más: así se reconoce un título que ya está. */
function foldTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Otro formulario de la clínica con el mismo título que se está escribiendo,
 * también si ya no se usa (`unused`, para ofrecer «Volver a usar»). El
 * constructor lo avisa y deja guardar igual. `ownKey`: la plantilla que se
 * edita no es su propio doble.
 */
export function sameTitleTemplate(
  title: string,
  templates: FormTemplate[],
  ownKey?: string,
): { title: string; unused: UnusedTemplate | null; existing: FormTemplate | null } | null {
  const wanted = foldTitle(title)
  if (!wanted) return null
  const { listed, unused } = templateGroups(templates.filter((template) => template.key !== ownKey))
  // Primero los que están en la lista: ese es el que se vería repetido al llenar.
  const inList = listed.find((versions) =>
    versions.some((version) => version.status !== "archivado" && foldTitle(version.title) === wanted),
  )
  const live = inList?.find((version) => version.status !== "archivado" && foldTitle(version.title) === wanted)
  // `existing`: lo que se abre para cambiar ese en vez de crear otro; su borrador si ya tiene uno.
  if (live && inList)
    return { title: live.title, unused: null, existing: inList.find((version) => version.status === "borrador") ?? live }
  const left = unused.find((item) => foldTitle(item.last.title) === wanted)
  return left ? { title: left.last.title, unused: left, existing: null } : null
}

/**
 * Qué botón de la fila recibe el foco después de un cambio que la muda de
 * sitio. Se dejó de usar: está en «Ya no se usan», con «Volver a usar»
 * (`reuse`). Volvió a usarse o se publicó: está en la lista, con «Dejar de
 * usar» (`leave`). Sin esto el foco se pierde, porque el botón que se tocó ya no está.
 */
export function rowButtonAfter(change: "publish" | "leave" | "reuse"): "leave" | "reuse" {
  return change === "leave" ? "reuse" : "leave"
}

/** Una opción que dice «no tiene»: con ella, una pregunta de casillas obligatoria se puede responder. */
const NONE_OPTION = /^(no|no tiene|ninguno|ninguna|nada)$/i

/**
 * Una pregunta de casillas obligatoria sin opción «No tiene»: dejarla sin marcar
 * ya no vale como respuesta y la ficha no se puede finalizar si el paciente no
 * tiene nada. El editor lo avisa al marcar «Obligatorio», sin impedirlo.
 */
export function requiredWithoutNone(field: Pick<FormFieldDef, "type" | "required" | "options">): boolean {
  return (
    field.type === "opcion_multiple" &&
    field.required === true &&
    !(field.options ?? []).some((option) => NONE_OPTION.test(option.trim()))
  )
}

/** El que sigue a `current` en una lista de paradas, o null si es el último o no está. */
export function nextAfter<T>(stops: readonly T[], current: T): T | null {
  const index = stops.indexOf(current)
  return index >= 0 ? (stops[index + 1] ?? null) : null
}

/** «4 preguntas»: cuántas tiene un formulario, entre todas sus secciones. */
function questionWords(template: FormTemplate): string {
  const count = template.schema.sections.reduce((total, section) => total + section.fields.length, 0)
  return `${count} ${count === 1 ? "pregunta" : "preguntas"}`
}

/**
 * Lo que distingue a un formulario de otro con su mismo título, entre los que
 * se muestran juntos (`shown`): cuántas preguntas tiene y cuándo se creó (`when`
 * lo escribe). Null si su título no se repite: entonces no hace falta decir más.
 * Dos versiones de un mismo formulario no son dos formularios. La fecha es la
 * del formulario (su primera versión, `formCreatedAt`), no la de la versión que
 * se muestra: así no cambia al volver a usarlo o al publicar otra versión.
 */
export function twinDetail(template: FormTemplate, shown: readonly FormTemplate[], when: (iso: string) => string): string | null {
  const wanted = foldTitle(template.title)
  const repeated = shown.some((other) => other.key !== template.key && foldTitle(other.title) === wanted)
  return repeated ? `${questionWords(template)} · creado el ${when(template.formCreatedAt ?? template.createdAt)}` : null
}

/** El nombre de un formulario en un desplegable: su título y, si otro se llama igual, lo que los distingue. */
export function templateOptionLabel(template: FormTemplate, shown: readonly FormTemplate[], when: (iso: string) => string): string {
  const detail = twinDetail(template, shown, when)
  return detail ? `${template.title} · ${detail}` : template.title
}

/**
 * Un envío a la vez. El segundo clic de un doble clic llega antes de que la
 * pantalla alcance a apagar el botón: `run` lo ignora hasta que `done` avisa
 * que el primero terminó (bien o mal).
 */
export function oneAtATime(): { run: (send: () => void) => boolean; done: () => void } {
  let busy = false
  return {
    run(send) {
      if (busy) return false
      busy = true
      send()
      return true
    },
    done() {
      busy = false
    },
  }
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
