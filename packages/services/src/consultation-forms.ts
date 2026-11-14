import { type Db, withOrgContext } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { encounter, orgSpecialty, serviceCatalog } from "@odentia/db/schema/clinical"
import {
  clinicalFormResponse,
  clinicalFormTemplate,
  professionalSpecialty,
} from "@odentia/db/schema/clinical-forms"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm"
import {
  assertFormSchema,
  type FormResponseListed,
  type FormTemplateRow,
  listFormResponses,
} from "./clinical-forms.js"
import { notFound } from "./errors.js"
import { findOrgCountry } from "./locale.js"
import { specialtyForKind } from "./product-catalog.js"
import { productHooks } from "./products.js"
import { patientAge } from "./responsibilities.js"

/**
 * Fichas de consulta (ADR 0117): el formulario que llena el equipo en la
 * atención. Aquí vive lo que las hace aparecer solas: las que vienen con el
 * producto, cuáles miró ya la clínica, las que la atención ofrece y la anterior
 * del mismo tipo. Guardar, versionar y finalizar siguen en `clinical-forms.ts`.
 *
 * Nada de esto traba la atención: una ficha ofrecida no se exige, y la atención
 * se abre, se firma y se cobra sin tocar ninguna.
 */

const TEMPLATE_ENTITY = "clinical_form_template"
/** «La miraste»: alguien de la clínica abrió una ficha que vino con el producto. */
const LOOK_ACTION = "form_template.look"

/**
 * Las fichas del producto que le faltan a la clínica (por clave), ya en uso y
 * unidas a su especialidad: nace con ellas, sin armar nada. Lo que la clínica
 * ya tiene con esa clave —cambiado, dejado de usar o propio con ese título— no
 * se toca ni se duplica. Nacen sin autor: así se sabe que vinieron con el producto.
 */
export async function ensureClinicForms(tx: Db, orgId: string): Promise<FormTemplateRow[]> {
  const { suggestions } = (await productHooks(tx, orgId)).forms
  if (suggestions.length === 0) return []
  const existing = await tx
    .selectDistinct({ key: clinicalFormTemplate.key, title: clinicalFormTemplate.title })
    .from(clinicalFormTemplate)
    .where(eq(clinicalFormTemplate.organizationId, orgId))
  const known = new Set(existing.map((row) => row.key))
  // Una que se llama igual, aunque su clave sea otra (una ficha antigua de la clínica o de la demo,
  // «evaluacion-endodoncia»), tampoco se duplica: la lista mostraría dos con el mismo nombre.
  const titles = new Set(existing.map((row) => sameTitle(row.title)))
  const missing = suggestions.filter(
    (suggestion) => !known.has(suggestion.key) && !titles.has(sameTitle(suggestion.title)),
  )
  if (missing.length === 0) return []
  // Se une a la especialidad que la clínica ya tiene activa. Si no la tiene o la desactivó, entra
  // sin especialidad (no aparece sola; se elige en «Otra ficha…»): copiar fichas nunca crea ni
  // reactiva especialidades de paso.
  const specialtyOf = new Map<string, string>()
  for (const kind of new Set(missing.map((suggestion) => suggestion.kind))) {
    const [id] = await specialtyIdsOfKind(tx, orgId, kind)
    if (id) specialtyOf.set(kind, id)
  }
  const now = new Date()
  const created: FormTemplateRow[] = []
  for (const suggestion of missing) {
    const [row] = await tx
      .insert(clinicalFormTemplate)
      .values({
        organizationId: orgId,
        specialtyId: specialtyOf.get(suggestion.kind) ?? null,
        key: suggestion.key,
        title: suggestion.title,
        description: suggestion.description,
        version: 1,
        status: "publicado",
        schema: assertFormSchema(suggestion.schema) as unknown as Record<string, unknown>,
        respondent: "staff",
        createdBy: null,
        publishedAt: now,
      })
      .returning()
    if (!row) continue
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId: null,
      action: "form_template.publish",
      entity: TEMPLATE_ENTITY,
      entityId: row.id,
      metadata: { key: row.key, version: row.version, archived: [], product: true },
    })
    created.push(row)
  }
  return created
}

/** El título como se compara: sin mayúsculas, tildes ni espacios de más. */
function sameTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * A cada clínica ya dada de alta, las fichas del producto que le falten, como
 * al nacer (la misma regla de los consentimientos sugeridos). Lo corre el
 * worker; una clínica que falla no frena a las demás.
 */
export async function ensureSuggestedFormsEverywhere(
  ownerDb: Db,
  appDb: Db,
): Promise<{ clinics: number; created: number; failed: number }> {
  const rows = await ownerDb.select({ orgId: orgProfile.organizationId }).from(orgProfile)
  const summary = { clinics: 0, created: 0, failed: 0 }
  for (const { orgId } of rows) {
    try {
      const created = await withOrgContext(appDb, orgId, (tx) => ensureClinicForms(tx, orgId))
      summary.clinics++
      summary.created += created.length
    } catch (error) {
      summary.failed++
      console.error("fichas de consulta del producto", orgId, error)
    }
  }
  return summary
}

/** Lo que la lista de Configuración dice de una ficha que vino con el producto. */
export interface ProductFormMark {
  /** Vino con el producto (nació sin autor, con una de sus claves). */
  fromProduct: boolean
  /** Alguien de la clínica ya la abrió o la cambió. De una propia, siempre. */
  looked: boolean
}

/** Las claves de la clínica que vinieron con el producto, con las versiones de cada una. */
async function productFormVersions(
  tx: Db,
  orgId: string,
): Promise<Map<string, Array<{ id: string; version: number; createdBy: string | null }>>> {
  const keys = (await productHooks(tx, orgId)).forms.suggestions.map((suggestion) => suggestion.key)
  if (keys.length === 0) return new Map()
  const rows = await tx
    .select({
      id: clinicalFormTemplate.id,
      key: clinicalFormTemplate.key,
      version: clinicalFormTemplate.version,
      createdBy: clinicalFormTemplate.createdBy,
    })
    .from(clinicalFormTemplate)
    .where(and(eq(clinicalFormTemplate.organizationId, orgId), inArray(clinicalFormTemplate.key, keys)))
  const byKey = new Map<string, Array<{ id: string; version: number; createdBy: string | null }>>()
  for (const row of rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row])
  // La de la clínica con ese mismo título (su primera versión tiene autor) no vino con el producto.
  for (const [key, versions] of byKey) {
    const first = versions.reduce((a, b) => (a.version <= b.version ? a : b))
    if (first.createdBy !== null) byKey.delete(key)
  }
  return byKey
}

/**
 * Por clave: si vino con el producto y si la clínica ya la miró. «Mirarla» es
 * abrirla (queda en la auditoría, sin otra columna) o haberla cambiado: una
 * versión con autor ya es de la clínica.
 */
export async function productFormMarks(tx: Db, orgId: string): Promise<Map<string, ProductFormMark>> {
  const byKey = await productFormVersions(tx, orgId)
  const ids = [...byKey.values()].flatMap((versions) => versions.map((version) => version.id))
  if (ids.length === 0) return new Map()
  const opened = await tx
    .selectDistinct({ entityId: auditEvent.entityId })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.organizationId, orgId),
        eq(auditEvent.entity, TEMPLATE_ENTITY),
        // Abrirla o apagarla es haberla decidido; volver a encenderla no cambia la marca.
        inArray(auditEvent.action, [LOOK_ACTION, "form_template.leave"]),
        inArray(auditEvent.entityId, ids),
      ),
    )
  const openedIds = new Set(opened.map((row) => row.entityId))
  const marks = new Map<string, ProductFormMark>()
  for (const [key, versions] of byKey) {
    const looked = versions.some((version) => version.createdBy !== null || openedIds.has(version.id))
    marks.set(key, { fromProduct: true, looked })
  }
  return marks
}

/**
 * Alguien de la clínica abrió una ficha que vino con el producto: deja de decir
 * «Sin mirar». Una sola constancia por ficha; en una propia o ya mirada no hace nada.
 */
export async function markFormTemplateLooked(
  tx: Db,
  orgId: string,
  actorUserId: string,
  templateId: string,
): Promise<{ looked: true }> {
  const [template] = await tx
    .select({ id: clinicalFormTemplate.id, key: clinicalFormTemplate.key, version: clinicalFormTemplate.version })
    .from(clinicalFormTemplate)
    .where(and(eq(clinicalFormTemplate.id, templateId), eq(clinicalFormTemplate.organizationId, orgId)))
    .limit(1)
  if (!template) throw notFound("Ficha")
  const mark = (await productFormMarks(tx, orgId)).get(template.key)
  if (!mark || mark.looked) return { looked: true }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: LOOK_ACTION,
    entity: TEMPLATE_ENTITY,
    entityId: template.id,
    metadata: { key: template.key, version: template.version },
  })
  return { looked: true }
}

/** Por qué la atención ofrece una ficha. */
export type FormOfferWhy =
  /** Por la especialidad del servicio de su cita. */
  | "cita"
  /** Por la edad del paciente (odentIA: menor de 12 años). */
  | "edad"
  /** Sin especialidad que venga de la cita: por la de quien atiende. */
  | "profesional"

/** Una ficha que la atención ofrece sola. Ofrecer no es pedir: nada la exige. */
export interface FormOffer {
  templateId: string
  key: string
  title: string
  why: FormOfferWhy
  /** La especialidad por la que aparece, con el nombre que le dio la clínica. */
  specialtyName: string
  /** Con «edad»: el tope de años que la ofrece. */
  underYears: number | null
  /** La de esta atención, si ya se empezó. */
  today: { responseId: string; status: "borrador" | "finalizado" } | null
  /** La anterior del mismo tipo que ya está en su historia, para verla al lado. */
  previous: { responseId: string; finalizedAt: Date; professionalUserId: string | null } | null
}

/** Las especialidades activas de la clínica que reciben un tipo de la biblioteca del producto; no crea ninguna. */
async function specialtyIdsOfKind(tx: Db, orgId: string, kind: string): Promise<string[]> {
  const { catalog } = await productHooks(tx, orgId)
  const owner = specialtyForKind(catalog.specialties(await findOrgCountry(tx, orgId)), kind)
  // Una especialidad de antes de las listas por país conserva la clave del tipo.
  const keys = [...new Set([owner?.key, kind].filter((key): key is string => Boolean(key)))]
  const rows = await tx
    .select({ id: orgSpecialty.id })
    .from(orgSpecialty)
    .where(and(eq(orgSpecialty.organizationId, orgId), inArray(orgSpecialty.key, keys), eq(orgSpecialty.isActive, true)))
  return rows.map((row) => row.id)
}

/**
 * Las especialidades cuyas fichas el producto ofrece por la edad, y hasta qué
 * edad; null si no ofrece por edad. Lo usan la atención y la lista de
 * Configuración («…y de cualquier menor de 12 años»).
 */
export async function ageOfferedSpecialties(
  tx: Db,
  orgId: string,
): Promise<{ underYears: number; specialtyIds: string[] } | null> {
  const { byAge } = (await productHooks(tx, orgId)).forms
  if (!byAge) return null
  return { underYears: byAge.underYears, specialtyIds: await specialtyIdsOfKind(tx, orgId, byAge.kind) }
}

/** Los años cumplidos el día `today` (AAAA-MM-DD). */
function yearsOn(birthDate: string, today: string): number {
  return Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4)) - (today.slice(5) < birthDate.slice(5) ? 1 : 0)
}

/** Una ficha finalizada del paciente, con la clave de su plantilla. */
interface FinalizedForm {
  id: string
  key: string
  encounterId: string | null
  finalizedAt: Date
  professionalUserId: string | null
}

/** Las fichas del equipo ya finalizadas de un paciente, de la más reciente a la más antigua; las de una atención anulada no cuentan. */
async function finalizedForms(tx: Db, orgId: string, patientId: string): Promise<FinalizedForm[]> {
  const rows = await tx
    .select({
      id: clinicalFormResponse.id,
      key: clinicalFormTemplate.key,
      encounterId: clinicalFormResponse.encounterId,
      finalizedAt: clinicalFormResponse.finalizedAt,
      professionalUserId: clinicalFormResponse.professionalUserId,
      encounterStatus: encounter.status,
    })
    .from(clinicalFormResponse)
    .innerJoin(clinicalFormTemplate, eq(clinicalFormTemplate.id, clinicalFormResponse.templateId))
    .leftJoin(
      encounter,
      and(eq(encounter.organizationId, clinicalFormResponse.organizationId), eq(encounter.id, clinicalFormResponse.encounterId)),
    )
    .where(
      and(
        eq(clinicalFormResponse.organizationId, orgId),
        eq(clinicalFormResponse.patientId, patientId),
        eq(clinicalFormResponse.status, "finalizado"),
        eq(clinicalFormResponse.source, "staff"),
        isNotNull(clinicalFormResponse.finalizedAt),
      ),
    )
    .orderBy(desc(clinicalFormResponse.finalizedAt))
  return rows.flatMap((row) =>
    row.finalizedAt && row.encounterStatus !== "anulada"
      ? [{ id: row.id, key: row.key, encounterId: row.encounterId, finalizedAt: row.finalizedAt, professionalUserId: row.professionalUserId }]
      : [],
  )
}

/**
 * La anterior del mismo tipo: la última ficha finalizada con la misma clave
 * (cualquier versión), de otra atención y terminada antes que `before`.
 */
function previousOf(
  finals: readonly FinalizedForm[],
  form: { id: string | null; key: string; encounterId: string | null; before: Date | null },
): FinalizedForm | null {
  return earlierOf(finals, form)[0] ?? null
}

/** Las finalizadas del mismo tipo antes que esta, de la más reciente a la primera. */
function earlierOf(
  finals: readonly FinalizedForm[],
  form: { id: string | null; key: string; encounterId: string | null; before: Date | null },
): FinalizedForm[] {
  return finals.filter(
    (item) =>
      item.key === form.key &&
      item.id !== form.id &&
      !(item.encounterId !== null && item.encounterId === form.encounterId) &&
      (form.before === null || item.finalizedAt < form.before),
  )
}

/**
 * La de inicio: la primera ficha finalizada del mismo tipo. En un tratamiento
 * largo (desde el tercer control de ortodoncia) se compara también con ella;
 * null si es la misma que la anterior.
 */
function firstOf(
  finals: readonly FinalizedForm[],
  form: { id: string | null; key: string; encounterId: string | null; before: Date | null },
): FinalizedForm | null {
  const earlier = earlierOf(finals, form)
  return earlier.length > 1 ? (earlier[earlier.length - 1] ?? null) : null
}

/**
 * Las fichas que la atención ofrece solas, con su motivo:
 * 1. las de la especialidad del servicio de su cita;
 * 2. las que el producto ofrece por la edad (odentIA: odontopediatría a menores de 12);
 * 3. si de la cita no sale una especialidad (no tiene servicio, o es una atención sin
 *    cita), las de las especialidades de quien atiende.
 * Una ficha sale una vez, con el primer motivo. «Otra ficha…» sigue ofreciendo todas.
 * Ofrecer por servicio queda fuera: con dos fichas de la misma especialidad salen las dos.
 */
export async function getEncounterFormOffers(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<FormOffer[]> {
  const [session] = await tx
    .select({
      id: encounter.id,
      professionalUserId: encounter.professionalUserId,
      appointmentId: encounter.appointmentId,
      status: encounter.status,
    })
    .from(encounter)
    .where(and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId)))
    .limit(1)
  if (!session) throw notFound("Atención")
  // Firmada o anulada, la atención ya no empieza fichas: no se ofrece ninguna (la regla es del servidor).
  if (session.status !== "borrador") return []

  const templates = await tx
    .select({
      id: clinicalFormTemplate.id,
      key: clinicalFormTemplate.key,
      title: clinicalFormTemplate.title,
      specialtyId: clinicalFormTemplate.specialtyId,
      specialtyName: orgSpecialty.name,
    })
    .from(clinicalFormTemplate)
    .innerJoin(
      orgSpecialty,
      and(
        eq(orgSpecialty.organizationId, clinicalFormTemplate.organizationId),
        eq(orgSpecialty.id, clinicalFormTemplate.specialtyId),
        // Una especialidad desactivada no ofrece sus fichas.
        eq(orgSpecialty.isActive, true),
      ),
    )
    .where(
      and(
        eq(clinicalFormTemplate.organizationId, orgId),
        eq(clinicalFormTemplate.status, "publicado"),
        eq(clinicalFormTemplate.inUse, true),
        eq(clinicalFormTemplate.respondent, "staff"),
      ),
    )
    .orderBy(clinicalFormTemplate.title)
  if (templates.length === 0) return []

  const [visit] = session.appointmentId
    ? await tx
        .select({ specialtyId: serviceCatalog.specialtyId })
        .from(appointment)
        .innerJoin(
          serviceCatalog,
          and(eq(serviceCatalog.organizationId, appointment.organizationId), eq(serviceCatalog.id, appointment.serviceId)),
        )
        .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, session.appointmentId)))
        .limit(1)
    : []
  const visitSpecialty = visit?.specialtyId ?? null

  const byAge = await ageOfferedSpecialties(tx, orgId)
  let ageSpecialties: string[] = []
  if (byAge) {
    const age = await patientAge(tx, orgId, patientId)
    if (age.birthDate && yearsOn(age.birthDate, age.today) < byAge.underYears) ageSpecialties = byAge.specialtyIds
  }

  // Solo si de la cita no sale una especialidad: las de quien atiende.
  const ownSpecialties = visitSpecialty
    ? []
    : (
        await tx
          .select({ specialtyId: professionalSpecialty.specialtyId })
          .from(professionalSpecialty)
          .where(
            and(
              eq(professionalSpecialty.organizationId, orgId),
              eq(professionalSpecialty.userId, session.professionalUserId),
            ),
          )
      ).map((row) => row.specialtyId)

  const whyOf = (specialtyId: string | null): FormOfferWhy | null => {
    if (!specialtyId) return null
    if (specialtyId === visitSpecialty) return "cita"
    if (ageSpecialties.includes(specialtyId)) return "edad"
    if (ownSpecialties.includes(specialtyId)) return "profesional"
    return null
  }
  const ORDER: Record<FormOfferWhy, number> = { cita: 0, edad: 1, profesional: 2 }
  const offered = templates
    .flatMap((template) => {
      const why = whyOf(template.specialtyId)
      return why ? [{ ...template, why }] : []
    })
    // Estable: dentro de cada motivo, por título.
    .sort((a, b) => ORDER[a.why] - ORDER[b.why])
  if (offered.length === 0) return []

  // Lo de esta atención (cualquier versión de la misma ficha) y lo ya finalizado en su historia.
  const inEncounter = await tx
    .select({
      id: clinicalFormResponse.id,
      key: clinicalFormTemplate.key,
      status: clinicalFormResponse.status,
      finalizedAt: clinicalFormResponse.finalizedAt,
    })
    .from(clinicalFormResponse)
    .innerJoin(clinicalFormTemplate, eq(clinicalFormTemplate.id, clinicalFormResponse.templateId))
    .where(
      and(
        eq(clinicalFormResponse.organizationId, orgId),
        eq(clinicalFormResponse.encounterId, encounterId),
        eq(clinicalFormResponse.source, "staff"),
        inArray(clinicalFormResponse.status, ["borrador", "finalizado"]),
      ),
    )
    .orderBy(desc(clinicalFormResponse.createdAt))
  const finals = await finalizedForms(tx, orgId, patientId)

  return offered.map((template) => {
    const today = inEncounter.find((row) => row.key === template.key) ?? null
    const previous = previousOf(finals, {
      id: today?.id ?? null,
      key: template.key,
      encounterId,
      before: today?.finalizedAt ?? null,
    })
    return {
      templateId: template.id,
      key: template.key,
      title: template.title,
      why: template.why,
      specialtyName: template.specialtyName,
      underYears: template.why === "edad" ? (byAge?.underYears ?? null) : null,
      today: today ? { responseId: today.id, status: today.status === "finalizado" ? "finalizado" : "borrador" } : null,
      previous: previous
        ? { responseId: previous.id, finalizedAt: previous.finalizedAt, professionalUserId: previous.professionalUserId }
        : null,
    }
  })
}

/** Una ficha de la lista del paciente, con la anterior del mismo tipo (`previousId`), si la hay. */
export type PatientFormResponse = FormResponseListed & {
  previousId: string | null
  /** La de inicio del mismo tipo, si no es la anterior: «Comparar con: Anterior · Inicio». */
  firstId: string | null
}

/**
 * Las fichas de un paciente con la anterior del mismo tipo de cada una: la
 * pantalla la pone al lado de la de hoy sin salir a Documentos, con la misma
 * regla que la atención usa al ofrecerla. Solo las del equipo tienen anterior.
 */
export async function listPatientFormResponses(
  tx: Db,
  orgId: string,
  query: Parameters<typeof listFormResponses>[2],
): Promise<PatientFormResponse[]> {
  const rows = await listFormResponses(tx, orgId, query)
  const staff = rows.filter((row) => row.source === "staff")
  if (staff.length === 0) return rows.map((row) => ({ ...row, previousId: null, firstId: null }))
  const finals = await finalizedForms(tx, orgId, query.patientId)
  if (finals.length === 0) return rows.map((row) => ({ ...row, previousId: null, firstId: null }))
  const keys = await tx
    .select({ id: clinicalFormTemplate.id, key: clinicalFormTemplate.key })
    .from(clinicalFormTemplate)
    .where(
      and(
        eq(clinicalFormTemplate.organizationId, orgId),
        inArray(clinicalFormTemplate.id, [...new Set(staff.map((row) => row.templateId))]),
      ),
    )
  const keyOf = new Map(keys.map((row) => [row.id, row.key]))
  return rows.map((row) => {
    const key = row.source === "staff" ? keyOf.get(row.templateId) : undefined
    if (!key) return { ...row, previousId: null, firstId: null }
    const form = { id: row.id, key, encounterId: row.encounterId, before: row.finalizedAt }
    return { ...row, previousId: previousOf(finals, form)?.id ?? null, firstId: firstOf(finals, form)?.id ?? null }
  })
}
