import type { Db } from "@odentia/db"
import { clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { and, desc, eq, inArray, min } from "drizzle-orm"
import { type FormTemplateRow, listFormTemplates } from "./clinical-forms.js"
import { type ProductFormMark, productFormMarks } from "./consultation-forms.js"

/**
 * Las fichas de Configuración y, de los cuestionarios que respondía el paciente, cuál le llegaba.
 * Desde la entrega 8 (mesa del 13 nov) ya no se crea, publica ni vuelve a usar ninguno
 * (`PATIENT_FORMS_RETIRED`): lo que se le pregunta antes de cada cita está en `visit-answers.ts`.
 * Lo de aquí solo sirve para los de antes que todavía estén en la lista.
 */

/** El cuestionario que les llegaba a los pacientes, de los de antes que sigan publicados. */
async function currentTemplate(tx: Db, orgId: string) {
  const [template] = await tx
    .select()
    .from(clinicalFormTemplate)
    .where(
      and(
        eq(clinicalFormTemplate.organizationId, orgId),
        eq(clinicalFormTemplate.status, "publicado"),
        eq(clinicalFormTemplate.inUse, true),
        eq(clinicalFormTemplate.respondent, "portal"),
      ),
    )
    // El último publicado o vuelto a usar: encender uno apagado lo deja como el que les llega.
    .orderBy(desc(clinicalFormTemplate.updatedAt))
    .limit(1)
  return template ?? null
}

/**
 * Las plantillas para Configuración, con la que hoy reciben los pacientes
 * marcada (`reachesPatients`): de las publicadas «que responde el paciente» les
 * llega una sola, la de `currentTemplate`. La lista lo dice con esa misma regla.
 * Y de cada ficha, si vino con el producto y si la clínica ya la miró
 * (`fromProduct`, `looked`): lo dice el servidor, no la pantalla.
 * `formCreatedAt`: cuándo se creó el formulario, que es su primera versión; no
 * cambia al publicar otra ni al volver a usarlo, y por eso sirve para distinguir
 * a dos formularios con el mismo título.
 */
export async function listClinicFormTemplates(
  tx: Db,
  orgId: string,
  query: Parameters<typeof listFormTemplates>[2] = {},
): Promise<
  Array<FormTemplateRow & { reachesPatients: boolean; formCreatedAt: Date } & ProductFormMark>
> {
  const rows = await listFormTemplates(tx, orgId, query)
  const reaching = rows.some((row) => row.respondent === "portal") ? await currentTemplate(tx, orgId) : null
  const marks = rows.length > 0 ? await productFormMarks(tx, orgId) : new Map<string, ProductFormMark>()
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
    formCreatedAt: createdOf.get(row.key) ?? row.createdAt,
  }))
}

