import type { Db } from "@odentia/db"
import { clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { and, desc, eq, inArray, min, ne } from "drizzle-orm"
import { type FormTemplateRow, listFormTemplates } from "./clinical-forms.js"
import { ageOfferedSpecialties, type ProductFormMark, productFormMarks } from "./consultation-forms.js"
import { notFound } from "./errors.js"

/**
 * Las fichas de Configuración y, de los cuestionarios que respondía el paciente, cuál le llegaba.
 * Desde la entrega 8 (mesa del 13 nov) ya no se crea, publica ni vuelve a usar ninguno
 * (`PATIENT_FORMS_RETIRED`): lo que se le pregunta antes de cada cita está en `visit-answers.ts`.
 * Lo de aquí solo sirve para los de antes que todavía estén en la lista.
 */

/** El cuestionario que reciben los pacientes. `exceptKey`: cuál sería si ese formulario dejara de estar publicado. */
async function currentTemplate(tx: Db, orgId: string, exceptKey?: string) {
  const [template] = await tx
    .select()
    .from(clinicalFormTemplate)
    .where(
      and(
        eq(clinicalFormTemplate.organizationId, orgId),
        eq(clinicalFormTemplate.status, "publicado"),
        eq(clinicalFormTemplate.inUse, true),
        eq(clinicalFormTemplate.respondent, "portal"),
        exceptKey ? ne(clinicalFormTemplate.key, exceptKey) : undefined,
      ),
    )
    // El último publicado o vuelto a usar: encender uno apagado lo deja como el que les llega.
    .orderBy(desc(clinicalFormTemplate.updatedAt))
    .limit(1)
  return template ?? null
}

/** Un cambio de Configuración sobre una plantilla: publicar su borrador, dejar de usarla o volver a usarla. */
export const FORM_TEMPLATE_CHANGES = ["publish", "leave", "reuse"] as const
export type FormTemplateChange = (typeof FORM_TEMPLATE_CHANGES)[number]

/** Un cuestionario del paciente, nombrado para decirlo en una confirmación. */
export interface ReachedQuestionnaire {
  key: string
  title: string
}

/**
 * A quién le llega: el cuestionario que hoy reciben los pacientes (`now`) y el
 * que recibirán después del cambio (`after`), con la regla de `currentTemplate`.
 * Solo lee: la confirmación de Configuración lo dice antes de hacer el cambio y
 * no lo calcula por su cuenta. Publicar o volver a usar uno «que responde el
 * paciente» lo deja como el último publicado; en los demás casos queda el
 * último de los otros, porque la versión publicada de esta plantilla deja de estarlo.
 */
export async function previewPatientQuestionnaire(
  tx: Db,
  orgId: string,
  templateId: string,
  change: FormTemplateChange,
): Promise<{ now: ReachedQuestionnaire | null; after: ReachedQuestionnaire | null }> {
  const [template] = await tx
    .select()
    .from(clinicalFormTemplate)
    .where(and(eq(clinicalFormTemplate.id, templateId), eq(clinicalFormTemplate.organizationId, orgId)))
    .limit(1)
  if (!template) throw notFound("Ficha")
  const named = (row: FormTemplateRow | null) => (row ? { key: row.key, title: row.title } : null)
  const becomes = change !== "leave" && template.respondent === "portal"
  return {
    now: named(await currentTemplate(tx, orgId)),
    after: named(becomes ? template : await currentTemplate(tx, orgId, template.key)),
  }
}

/**
 * Las plantillas para Configuración, con la que hoy reciben los pacientes
 * marcada (`reachesPatients`): de las publicadas «que responde el paciente» les
 * llega una sola, la de `currentTemplate`. La lista lo dice con esa misma regla.
 * Y de cada ficha, si vino con el producto y si la clínica ya la miró
 * (`fromProduct`, `looked`) y si además se ofrece por la edad
 * (`offeredUnderYears`): lo dice el servidor, no la pantalla.
 * `formCreatedAt`: cuándo se creó el formulario, que es su primera versión; no
 * cambia al publicar otra ni al volver a usarlo, y por eso sirve para distinguir
 * a dos formularios con el mismo título.
 */
export async function listClinicFormTemplates(
  tx: Db,
  orgId: string,
  query: Parameters<typeof listFormTemplates>[2] = {},
): Promise<
  Array<FormTemplateRow & { reachesPatients: boolean; offeredUnderYears: number | null; formCreatedAt: Date } & ProductFormMark>
> {
  const rows = await listFormTemplates(tx, orgId, query)
  const reaching = rows.some((row) => row.respondent === "portal") ? await currentTemplate(tx, orgId) : null
  const marks = rows.length > 0 ? await productFormMarks(tx, orgId) : new Map<string, ProductFormMark>()
  const byAge = rows.length > 0 ? await ageOfferedSpecialties(tx, orgId) : null
  const keys = [...new Set(rows.map((row) => row.key))]
  // De todas las versiones de cada formulario, también las que la lista pedida no trae (las archivadas).
  const firsts = keys.length
    ? await tx
        .select({ key: clinicalFormTemplate.key, createdAt: min(clinicalFormTemplate.createdAt) })
        .from(clinicalFormTemplate)
        .where(and(eq(clinicalFormTemplate.organizationId, orgId), inArray(clinicalFormTemplate.key, keys)))
        .groupBy(clinicalFormTemplate.key)
    : []
  const createdOf = new Map(firsts.map((first) => [first.key, first.createdAt]))
  return rows.map((row) => ({
    ...row,
    reachesPatients: row.id === reaching?.id,
    ...(marks.get(row.key) ?? { fromProduct: false, looked: true }),
    offeredUnderYears:
      byAge && row.respondent === "staff" && row.specialtyId && byAge.specialtyIds.includes(row.specialtyId)
        ? byAge.underYears
        : null,
    formCreatedAt: createdOf.get(row.key) ?? row.createdAt,
  }))
}

