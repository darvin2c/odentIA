/**
 * Fichas de consulta: lo que la atención ofrece sola y lo que la lista de
 * Configuración dice de las que vinieron con el producto. Las reglas viven en
 * el servidor (`getEncounterFormOffers`, `productFormMarks`); aquí se llaman y
 * se dicen con las palabras de la pantalla.
 */
import { apiFetch } from "./api"
import type { FormFieldDef, FormResponse, FormTemplate } from "./clinical-forms"

const BASE = "/api/clinical-forms"

/** Por qué la atención ofrece una ficha: por la cita, por la edad o por quien atiende. */
export type FormOfferWhy = "cita" | "edad" | "profesional"

/** Una ficha que la atención ofrece sola. Ofrecer no es pedir: nada la exige. */
export interface FormOffer {
  templateId: string
  key: string
  title: string
  why: FormOfferWhy
  specialtyName: string
  underYears: number | null
  /** La de esta atención, si ya se empezó. */
  today: { responseId: string; status: "borrador" | "finalizado" } | null
  /** La anterior del mismo tipo, ya en su historia. */
  previous: { responseId: string; finalizedAt: string; professionalUserId: string | null } | null
}

export function fetchFormOffers(patientId: string, encounterId: string) {
  const search = new URLSearchParams({ patientId, encounterId })
  return apiFetch<{ data: FormOffer[] }>(`${BASE}/form-offers?${search.toString()}`)
}

/** «La miraste»: deja constancia de que alguien de la clínica abrió una ficha del producto. */
export function markFormTemplateLooked(id: string) {
  return apiFetch<{ data: { looked: true } }>(`${BASE}/form-templates/${id}/looked`, { method: "POST", body: "{}" })
}

/** Por qué aparece, en una línea: «Por la especialidad de su cita: Ortodoncia». */
export function offerWhyWords(offer: Pick<FormOffer, "why" | "specialtyName" | "underYears">): string {
  if (offer.why === "edad") return `Por su edad: menor de ${offer.underYears ?? 12} años`
  if (offer.why === "cita") return `Por la especialidad de su cita: ${offer.specialtyName}`
  return `Por la especialidad de quien atiende: ${offer.specialtyName}`
}

/** El botón de una ficha ofrecida: empezarla, seguirla o verla ya terminada. */
export function offerActionWords(offer: Pick<FormOffer, "today">): "Empezar la de hoy" | "Seguir con la de hoy" | "Ver la de hoy" {
  if (!offer.today) return "Empezar la de hoy"
  return offer.today.status === "borrador" ? "Seguir con la de hoy" : "Ver la de hoy"
}

/** El nombre del botón de una ficha ofrecida: qué hace, de cuál es y por qué aparece. */
export function offerButtonName(offer: Pick<FormOffer, "title" | "today" | "why" | "specialtyName" | "underYears">): string {
  return `${offerActionWords(offer)}: ${offer.title}. ${offerWhyWords(offer)}`
}

/** El estado de una ficha ofrecida: «Sin empezar», «A medias», «Finalizada». Nunca «pendiente»: no se pide. */
export function offerStateWords(offer: Pick<FormOffer, "today">): string | null {
  if (!offer.today) return null
  return offer.today.status === "borrador" ? "A medias" : "Finalizada"
}

/**
 * Qué muestra la atención de sus fichas: con alguna ofrecida, la lista con «Otra ficha…» al pie;
 * sin ninguna, solo «Otra ficha…», en una línea, para que siempre esté; sin poder empezar una
 * ni nada que ver, nada. Mientras llegan las ofrecidas, nada: no se dice que no hay.
 */
export function offersView(
  offers: readonly Pick<FormOffer, "today">[] | undefined,
  canStart: boolean,
): "lista" | "solo-otra" | "nada" {
  if (offers === undefined) return "nada"
  if (offers.length > 0) return "lista"
  return canStart ? "solo-otra" : "nada"
}

/**
 * La ficha de esa plantilla que ya está a medias en esta atención, si la hay:
 * «Otra ficha…» y «Nuevo › Ficha» la abren en vez de empezar otra igual. Se
 * reconoce por la plantilla o por su título (una versión anterior de la misma ficha).
 */
export function draftOf(
  template: Pick<FormTemplate, "id" | "title">,
  drafts: ReadonlyArray<Pick<FormResponse, "id" | "templateId" | "templateTitle" | "status" | "source">>,
): string | null {
  const open = drafts.filter((draft) => draft.status === "borrador" && draft.source !== "portal")
  return (open.find((draft) => draft.templateId === template.id) ?? open.find((draft) => draft.templateTitle === template.title))?.id ?? null
}

/**
 * Las fichas de la atención que se listan en Documentos: la que está a medias y
 * ya se ofrece arriba («A medias · Seguir con la de hoy») no se repite.
 */
export function formsBelowOffers<T extends Pick<FormResponse, "id" | "status">>(
  forms: readonly T[],
  offers: ReadonlyArray<Pick<FormOffer, "today">> | undefined,
): T[] {
  const above = new Set((offers ?? []).flatMap((offer) => (offer.today?.status === "borrador" ? [offer.today.responseId] : [])))
  return forms.filter((form) => !(form.status === "borrador" && above.has(form.id)))
}

/** La ficha en uso (o la última versión) de cada una que vino con el producto y sigue en la lista. */
function productForms(listed: readonly FormTemplate[][]): FormTemplate[] {
  return listed.flatMap((versions) => {
    const shown = versions.find((version) => version.status === "publicado") ?? versions[0]
    return shown?.fromProduct ? [shown] : []
  })
}

/**
 * «Miraste 1 de 4»: de las fichas en la lista que vinieron con el producto,
 * cuántas abrió ya la clínica. Null si ninguna vino con el producto.
 */
export function lookedCount(listed: readonly FormTemplate[][]): { looked: number; total: number } | null {
  const forms = productForms(listed)
  if (forms.length === 0) return null
  return { looked: forms.filter((form) => form.looked !== false).length, total: forms.length }
}

/** La lista de Fichas de consulta con las que faltan mirar primero; las demás, en su orden. */
export function lookFirst(listed: readonly FormTemplate[][]): FormTemplate[][] {
  const toLook = (versions: FormTemplate[]) =>
    unlooked(versions.find((version) => version.status === "publicado") ?? versions[0]) ? 0 : 1
  return [...listed].sort((a, b) => toLook(a) - toLook(b))
}

/** Vino con el producto y nadie de la clínica la abrió todavía. */
export function unlooked(template: Pick<FormTemplate, "fromProduct" | "looked"> | undefined): boolean {
  return template?.fromProduct === true && template.looked === false
}

/**
 * Dónde aparece sola una ficha, dicho bajo su título: «Aparece en la atención
 * de: Odontopediatría, y de cualquier menor de 12 años». Sin especialidad no
 * aparece sola: se elige en «Otra ficha…».
 */
export function appearsWords(
  template: Pick<FormTemplate, "specialtyId" | "offeredUnderYears">,
  specialtyName: string | null,
): string {
  if (!template.specialtyId || !specialtyName) return "No aparece sola: se elige en «Otra ficha…»"
  const byAge = template.offeredUnderYears ? `, y de cualquier menor de ${template.offeredUnderYears} años` : ""
  return `Aparece en la atención de: ${specialtyName}${byAge}`
}

/** Una respuesta ya dada, en palabras, para leerla al lado de la de hoy. «—» si no se respondió. */
export function answerWords(field: Pick<FormFieldDef, "type" | "unit">, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  if (value === true) return "Sí"
  if (value === false) return "No"
  if (Array.isArray(value)) return value.length > 0 ? value.map(String).join(", ") : "—"
  // Una firma o un archivo no se leen como texto: se abren en su ficha.
  if (typeof value === "object" || field.type === "adjunto" || field.type === "firma") return "En la ficha anterior"
  const text = String(value)
  return field.unit && (field.type === "numero" || field.type === "texto") ? `${text} ${field.unit}` : text
}

/**
 * Quién responde por una ficha nueva: el de la atención, si atiende; si no se
 * dice (desde Documentos), quien la empieza, si atiende. Vacío es «Sin asignar».
 */
export function defaultResponsible(
  given: string | undefined,
  me: string,
  responsibles: ReadonlyArray<{ userId: string }>,
): string {
  const attends = (id: string | undefined) => Boolean(id) && responsibles.some((member) => member.userId === id)
  if (given !== undefined) return attends(given) ? (given ?? "") : ""
  return attends(me) ? me : ""
}

/**
 * Lo que «Usar» copia de la anterior a la de hoy: la misma respuesta, si la
 * pregunta de hoy la admite (mismo tipo y, en las de opciones, opciones que
 * siguen). Una firma o un archivo no se copian; nada se copia solo.
 */
export function reusableAnswer(
  field: Pick<FormFieldDef, "type" | "options">,
  before: Pick<FormFieldDef, "type">,
  value: unknown,
): unknown {
  if (value === null || value === undefined || value === "") return undefined
  if (field.type !== before.type || field.type === "firma" || field.type === "adjunto") return undefined
  if (field.type === "opcion_unica") return field.options?.includes(String(value)) ? value : undefined
  if (field.type === "opcion_multiple") {
    const kept = Array.isArray(value) ? value.filter((option) => field.options?.includes(String(option))) : []
    return kept.length > 0 ? kept : undefined
  }
  return value
}

/**
 * Cómo se llama en una lista lo que hay en `clinical_form_response`: la ficha
 * que llenó el equipo es «Ficha»; el cuestionario antiguo que respondió el
 * paciente queda en el mismo filtro, dicho como lo que es.
 */
export function formKindWords(response: Pick<FormResponse, "source">): "Ficha" | "Lo que respondió el paciente" {
  return response.source === "portal" ? "Lo que respondió el paciente" : "Ficha"
}

/** El título de una fila: «Ficha · Ficha de ortodoncia», «Lo que respondió el paciente · Cuestionario previo a la cita». */
export function formRowTitle(response: Pick<FormResponse, "source" | "templateTitle">): string {
  const title = response.templateTitle ?? "Sin título"
  // «Ficha de ortodoncia» ya dice lo que es: no se repite «Ficha · Ficha de ortodoncia».
  if (response.source !== "portal" && /^ficha\b/i.test(title)) return title
  return `${formKindWords(response)} · ${title}`
}
