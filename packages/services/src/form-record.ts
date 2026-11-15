/**
 * Un formulario finalizado, listo para leerse: cada pregunta con su respuesta en
 * palabras, sus adendas y quién y cuándo. Lo leen igual la copia de la historia
 * (el PDF y el `QuestionnaireResponse` de FHIR), la atención firmada y la
 * Historia: una sola regla para decir una respuesta, no una por pantalla.
 *
 * Solo lo finalizado es registro clínico. Un borrador no entra aquí; lo que la
 * persona envió y el equipo aún no revisó, solo si se pide (`unreviewed`): la copia
 * de la historia lo trae marcado «sin revisar», como lo que declaró de su salud.
 */
import { whoWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { encounter, patient, patientContact, patientDocument } from "@odentia/db/schema/clinical"
import { clinicalFormAddendum, clinicalFormResponse } from "@odentia/db/schema/clinical-forms"
import { contact } from "@odentia/db/schema/crm"
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { declarantOfLink } from "./clinical.js"
import { clioMarksFor, conditionMet, type FieldType, type FormFieldDef, type FormSchemaDef } from "./clinical-forms.js"
import { dayTimeWords, type Zone } from "./document-kit.js"
import { findOrgLocale } from "./locale.js"
import type { ProductSite } from "./product-hooks.js"
import { productHooks } from "./products.js"

/** La respuesta como se guardó, sin lo que solo sirve para dibujarla (el trazo de una firma). */
export type FormAnswerValue = string | number | boolean | string[] | null

export interface FormRecordItem {
  /** El id de la pregunta en su plantilla (`linkId` en FHIR). */
  id: string
  label: string
  type: FieldType
  options: string[] | null
  unit: string | null
  /** La respuesta en palabras; null si quedó sin responder. */
  words: string | null
  value: FormAnswerValue
  /** Solo en una pieza: el sitio como lo dice el producto para FHIR (`ProductSite.bodySite`). */
  bodySite?: { text: string } | null
  /**
   * Lo propuso Clío al dictar y una persona lo confirmó, mientras siga siendo eso:
   * «Clío · confirmó Ana Torres el 14/11/2026 14:06» (entrega 11, criterio C8).
   */
  clio?: string | null
}

export interface FormRecordSection {
  id: string
  title: string
  /** Solo las preguntas que se mostraron: las que su condición ocultó no se hicieron. */
  items: FormRecordItem[]
}

export interface FormRecord {
  id: string
  title: string
  version: number
  /** La atención en la que se llenó, si fue en una. */
  encounterId: string | null
  /** Lo llenó el equipo o lo respondió la persona (o quien la representa) y el equipo lo revisó. */
  source: "staff" | "portal"
  /** Por dónde llegó lo que envió la persona: su enlace o el portal. null en lo del equipo o si no quedó guardado. */
  via: "enlace" | "portal" | null
  /** Quién lo llenó: quien lo empezó en la clínica, o la persona que lo respondió. */
  filledBy: string | null
  /** Quien lo respondió es el propio paciente; null si lo llenó el equipo o no se sabe quién. */
  filledByPatient: boolean | null
  /** El contacto que lo respondió, para nombrarlo en FHIR (`RelatedPerson`). */
  respondentContactId: string | null
  /**
   * Quién lo respondió, con las palabras de la ficha y de Documentos (`whoWords`):
   * «ella», «su madre, Carla», «el paciente» si no se sabe su sexo. null en lo del equipo
   * o si no consta quién.
   */
  respondentWords: string | null
  /** El profesional a cargo, si se indicó. */
  professionalName: string | null
  /** Cuándo lo envió la persona, si lo respondió ella. */
  submittedAt: Date | null
  /**
   * Cuándo se finalizó; en lo que envió la persona, cuándo se revisó. null: lo envió y el
   * equipo aún no lo revisó (solo se lee con `unreviewed`).
   */
  finalizedAt: Date | null
  /** Quién lo finalizó: en lo que envió la persona, quien lo revisó. null si no quedó guardado (lo de antes). */
  finalizedBy: string | null
  /**
   * Se llenó en una atención que después se anuló: se conserva, pero ya no vale como
   * registro de esa atención. La Historia lo marca igual («de una atención anulada»).
   */
  voidedAttention: { at: Date; reason: string } | null
  /**
   * Quién lo llenó y, si fue otra persona, quién lo cerró, sin fechas: «Lo llenó Ana
   * Torres», «Lo respondió Marta Ríos (paciente) · lo revisó Ana Torres». Es la frase
   * de la Historia, que ya dice el día.
   */
  whoWords: string
  /**
   * Quién lo llenó y cuándo se finalizó, en una frase con las fechas de la clínica:
   * la misma en la copia, en la atención firmada y en el texto de FHIR.
   */
  byWords: string
  sections: FormRecordSection[]
  /**
   * Lo que el equipo agregó sin cambiar las respuestas, en orden. En lo que envió la
   * persona puede ser anterior a la revisión: lo que escribió no se edita ni antes.
   */
  addenda: Array<{
    id: string
    text: string
    /** Por qué se corrigió, si quien corrigió lo dijo. */
    reason: string | null
    authorName: string | null
    createdAt: Date
  }>
  /** Cómo se llaman: «Correcciones» en lo que envió la persona, «Adendas» en lo del equipo. */
  addendaTitle: "Adendas" | "Correcciones"
  /** Lo respondido en una línea, para verlo sin abrirlo. */
  summary: string
}

/** «13/11/2026»: una fecha sin hora es ese día en cualquier zona. */
export function civilDay(value: string): string {
  const [year, month, day] = value.split("-")
  return `${day}/${month}/${year}`
}

/** El esquema congelado en la respuesta, leído sin fallar: una pregunta mal guardada no tumba la copia. */
function schemaOf(snapshot: unknown): FormSchemaDef {
  const sections = (snapshot as { sections?: unknown } | null)?.sections
  if (!Array.isArray(sections)) return { sections: [] }
  return {
    sections: sections
      .filter((section) => section && typeof section === "object" && Array.isArray(section.fields))
      .map((section) => ({
        id: String(section.id),
        title: String(section.title ?? ""),
        fields: (section.fields as FormFieldDef[]).filter(
          (field) => field && typeof field.id === "string" && typeof field.label === "string",
        ),
      })),
  }
}

/** Una respuesta en palabras y como valor simple; `words` null si quedó sin responder. */
function answerOf(
  field: FormFieldDef,
  raw: unknown,
  context: { site: ProductSite; documentLabels: Map<string, string> },
): Pick<FormRecordItem, "words" | "value" | "bodySite"> {
  const empty = { words: null, value: null }
  if (raw === null || raw === undefined || raw === "") return empty
  switch (field.type) {
    case "texto":
    case "texto_largo":
    case "opcion_unica":
      return typeof raw === "string" ? { words: raw, value: raw } : empty
    case "numero":
      return typeof raw === "number" ? { words: `${raw}${field.unit ? ` ${field.unit}` : ""}`, value: raw } : empty
    case "escala": {
      if (typeof raw !== "number") return empty
      const [min, max] = [field.min ?? 0, field.max ?? 10]
      return { words: min === 0 ? `${raw} de ${max}` : `${raw} (de ${min} a ${max})`, value: raw }
    }
    case "booleano":
      return typeof raw === "boolean" ? { words: raw ? "Sí" : "No", value: raw } : empty
    case "opcion_multiple": {
      const chosen = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : []
      return chosen.length ? { words: chosen.join(", "), value: chosen } : empty
    }
    case "fecha":
      return typeof raw === "string" ? { words: civilDay(raw), value: raw } : empty
    case "pieza": {
      if (typeof raw !== "number") return empty
      // El «dónde» lo dice el producto (odentIA: «Pieza 46»).
      const { site } = context
      const place = { siteSystem: site.system, siteCode: site.code(raw), siteQualifiers: [] }
      return { words: site.words(place, "full") ?? String(raw), value: raw, bodySite: site.bodySite(place) }
    }
    case "firma": {
      // El trazo se queda en el formulario: aquí consta quién firmó.
      const signer = (raw as { signerName?: unknown }).signerName
      return typeof signer === "string" && signer.trim()
        ? { words: `Firmó ${signer.trim()}`, value: null }
        : { words: "Firmado", value: null }
    }
    case "adjunto":
      return typeof raw === "string"
        ? { words: context.documentLabels.get(raw) ?? "Archivo adjunto", value: raw }
        : empty
    default:
      return empty
  }
}

type FormHead = Omit<FormRecord, "whoWords" | "byWords" | "summary" | "sections" | "addenda" | "addendaTitle">

/**
 * Quién lo llenó: alguien del equipo, o la persona que lo respondió, que puede ser
 * el paciente o quien habla por él. La única frase para decirlo: la usan la copia,
 * la atención firmada y la Historia.
 */
function filledWordsOf(form: FormHead): string {
  if (form.source !== "portal") return `Lo llenó ${form.filledBy ?? "el equipo"}`
  return `Lo respondió ${form.respondentWords ?? "la persona"}`
}

/**
 * Quién lo cerró: lo que envió la persona lo revisa el equipo; lo del equipo se
 * finaliza. Sin quién (lo de antes de guardarlo) no se afirma un nombre.
 */
function closedWordsOf(form: FormHead): string {
  if (form.source === "portal") {
    if (!form.finalizedAt) return "sin revisar"
    return form.finalizedBy ? `lo revisó ${form.finalizedBy}` : "el equipo lo revisó"
  }
  return form.finalizedBy ? `lo finalizó ${form.finalizedBy}` : "finalizado"
}

/** La misma persona lo llenó y lo finalizó: se nombra una vez. */
function sameHandOf(form: FormHead): boolean {
  return form.source !== "portal" && (!form.finalizedBy || form.finalizedBy === form.filledBy)
}

/** Quién lo llenó y quién lo cerró, sin fechas. En lo del equipo, quien lo finalizó solo si fue otra persona. */
function whoWordsOf(form: FormHead): string {
  return sameHandOf(form) ? filledWordsOf(form) : `${filledWordsOf(form)} · ${closedWordsOf(form)}`
}

/**
 * «Lo llenó y lo finalizó Ana Torres el 13 de noviembre de 2026, 15:02», «Lo respondió
 * Marta Ríos (paciente) desde su enlace el … · lo revisó Ana Torres el …», o «… · sin
 * revisar» si nadie del equipo lo revisó todavía.
 */
function byWordsOf(form: FormHead, zone: Zone): string {
  const closedAt = form.finalizedAt ? ` el ${dayTimeWords(form.finalizedAt, zone)}` : ""
  if (form.source === "portal") {
    const via = form.via === "enlace" ? " desde su enlace" : form.via === "portal" ? " desde el portal" : ""
    const sent = form.submittedAt ? ` el ${dayTimeWords(form.submittedAt, zone)}` : ""
    // Con quien habla por ella, su nombre va entre comas: «Lo respondió su madre, Carla, desde su enlace».
    const comma = form.respondentWords?.includes(",") && (via || sent) ? "," : ""
    return `${filledWordsOf(form)}${comma}${via}${sent} · ${closedWordsOf(form)}${closedAt}`
  }
  const charge =
    form.professionalName && form.professionalName !== form.filledBy ? ` · a cargo de ${form.professionalName}` : ""
  // Quien lo llenó y lo finalizó se nombra una vez (QA de la entrega 2: «Lo llenó Ana · lo finalizó Ana»).
  if (sameHandOf(form) && form.filledBy) return `Lo llenó y lo finalizó ${form.filledBy}${closedAt}${charge}`
  return `${filledWordsOf(form)}${charge} · ${closedWordsOf(form)}${closedAt}`
}

/**
 * Cuándo va en la historia: lo que respondió la persona, cuando lo envió (aunque se
 * revise días después); lo del equipo, cuando se finalizó. Una sola expresión para la
 * copia y la Historia (`getTimeline`), que ordenan igual.
 */
export const formRecordAtSql = sql`coalesce(case when ${clinicalFormResponse.source} = 'portal' then ${clinicalFormResponse.submittedAt} end, ${clinicalFormResponse.finalizedAt}, ${clinicalFormResponse.submittedAt})`

/** La misma hora que `formRecordAtSql`, de una ficha ya leída. */
export function formRecordAt(form: Pick<FormRecord, "source" | "submittedAt" | "finalizedAt">): Date | null {
  return (form.source === "portal" ? form.submittedAt : null) ?? form.finalizedAt ?? form.submittedAt
}

/**
 * «con 1 corrección», «con 2 adendas»: lo agregado después, para que una línea
 * plegada no se lea como si nadie lo hubiera precisado. Vacío si no tiene.
 */
export function addedWords(form: Pick<FormRecord, "addenda" | "source">): string {
  const count = form.addenda.length
  if (count === 0) return ""
  const [one, many] = form.source === "portal" ? ["corrección", "correcciones"] : ["adenda", "adendas"]
  return `con ${count} ${count === 1 ? one : many}`
}

/** Lo que cabe en una línea de la Historia. */
const SUMMARY_MAX = 180

/**
 * Lo respondido en una línea: lo escrito va tal cual y lo demás con su pregunta
 * («Presenta dolor: Sí»). Las firmas y los adjuntos no resumen nada. Lo que no
 * cabe se deja entero para «Ver»: una respuesta no se corta por la mitad, salvo
 * que sea la primera y sola no quepa.
 */
function summaryOf(sections: FormRecordSection[]): string {
  const parts = sections
    .flatMap((section) => section.items)
    .filter((item) => item.words !== null && item.type !== "firma" && item.type !== "adjunto")
    .map((item) =>
      (item.type === "texto" || item.type === "texto_largo" || item.type === "pieza"
        ? (item.words as string)
        : // La pregunta sin sus signos: «¿Cuánto te duele? (0 a 10)» se lee «Cuánto te duele (0 a 10): 7 de 10».
          `${item.label.replace(/[¿?]/g, "").replace(/\s+/g, " ").trim().replace(/\s*:$/, "")}: ${item.words}`
      ).replace(/\s+/g, " "),
    )
  let line = ""
  for (const part of parts) {
    const next = line ? `${line} · ${part}` : part
    if (next.length > SUMMARY_MAX) return line ? `${line} · …` : `${part.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
    line = next
  }
  return line
}

/**
 * Los formularios finalizados de la persona, del más antiguo al más nuevo. Con
 * `encounterIds`, solo los que se llenaron en esas atenciones; con `ids`, solo esos;
 * con `unreviewed`, también lo que la persona envió y el equipo aún no revisó.
 */
export async function loadFormRecords(
  tx: Db,
  orgId: string,
  patientId: string,
  scope: { encounterIds?: readonly string[]; ids?: readonly string[]; unreviewed?: boolean } = {},
): Promise<FormRecord[]> {
  if (scope.encounterIds?.length === 0 || scope.ids?.length === 0) return []
  const author = alias(user, "form_author")
  const professional = alias(user, "form_professional")
  const finalizer = alias(user, "form_finalizer")
  const rows = await tx
    .select({
      row: clinicalFormResponse,
      authorName: author.name,
      professionalName: professional.name,
      finalizerName: finalizer.name,
      respondentName: contact.displayName,
      respondentRelationship: patientContact.relationship,
      respondentRelationshipDetail: patientContact.relationshipDetail,
      respondentKinship: patientContact.kinship,
      encounterStatus: encounter.status,
      encounterVoidedAt: encounter.voidedAt,
      encounterVoidReason: encounter.voidReason,
    })
    .from(clinicalFormResponse)
    .leftJoin(author, eq(author.id, clinicalFormResponse.authorUserId))
    .leftJoin(professional, eq(professional.id, clinicalFormResponse.professionalUserId))
    .leftJoin(finalizer, eq(finalizer.id, clinicalFormResponse.finalizedBy))
    .leftJoin(
      contact,
      and(eq(contact.id, clinicalFormResponse.respondentContactId), eq(contact.organizationId, orgId)),
    )
    // Su vínculo con el paciente, para nombrarlo como la ficha y Documentos («su madre, Carla»).
    .leftJoin(
      patientContact,
      and(
        eq(patientContact.organizationId, clinicalFormResponse.organizationId),
        eq(patientContact.patientId, clinicalFormResponse.patientId),
        eq(patientContact.contactId, clinicalFormResponse.respondentContactId),
      ),
    )
    .leftJoin(encounter, and(eq(encounter.id, clinicalFormResponse.encounterId), eq(encounter.organizationId, orgId)))
    .where(
      and(
        eq(clinicalFormResponse.organizationId, orgId),
        eq(clinicalFormResponse.patientId, patientId),
        scope.unreviewed
          ? or(
              eq(clinicalFormResponse.status, "finalizado"),
              // Lo que envió y nadie revisó: es lo que dijo, aunque todavía no sea registro clínico.
              and(
                eq(clinicalFormResponse.status, "borrador"),
                eq(clinicalFormResponse.source, "portal"),
                isNotNull(clinicalFormResponse.submittedAt),
              ),
            )
          : eq(clinicalFormResponse.status, "finalizado"),
        ...(scope.encounterIds ? [inArray(clinicalFormResponse.encounterId, [...scope.encounterIds])] : []),
        ...(scope.ids ? [inArray(clinicalFormResponse.id, [...scope.ids])] : []),
      ),
    )
    // Lo que respondió la persona va en el momento en que lo envió, revisado o no; lo del equipo, en
    // el que se finalizó (revisor, QA de la entrega 2).
    .orderBy(asc(formRecordAtSql), asc(clinicalFormResponse.id))
  if (rows.length === 0) return []
  const responseIds = rows.map(({ row }) => row.id)
  const addenda = await tx
    .select({
      id: clinicalFormAddendum.id,
      responseId: clinicalFormAddendum.responseId,
      text: clinicalFormAddendum.text,
      reason: clinicalFormAddendum.reason,
      authorName: user.name,
      createdAt: clinicalFormAddendum.createdAt,
    })
    .from(clinicalFormAddendum)
    .leftJoin(user, eq(user.id, clinicalFormAddendum.createdBy))
    .where(and(eq(clinicalFormAddendum.organizationId, orgId), inArray(clinicalFormAddendum.responseId, responseIds)))
    .orderBy(asc(clinicalFormAddendum.createdAt), asc(clinicalFormAddendum.id))
  // Lo que propuso Clío y confirmó una persona: la marca va en su pregunta, en la Historia y en la copia.
  const marksOf = await clioMarksFor(tx, orgId, patientId)
  const schemas = new Map(rows.map(({ row }) => [row.id, schemaOf(row.templateSnapshot)]))
  // Un adjunto se nombra por su papel, aunque después se haya retirado.
  const attachmentIds = rows.flatMap(({ row }) =>
    (schemas.get(row.id) as FormSchemaDef).sections
      .flatMap((section) => section.fields)
      .filter((field) => field.type === "adjunto")
      .map((field) => (row.answers as Record<string, unknown>)[field.id])
      .filter((value): value is string => typeof value === "string"),
  )
  const documentLabels = new Map(
    attachmentIds.length
      ? (
          await tx
            .select({ id: patientDocument.id, label: patientDocument.label })
            .from(patientDocument)
            .where(
              and(
                eq(patientDocument.organizationId, orgId),
                eq(patientDocument.patientId, patientId),
                inArray(patientDocument.id, attachmentIds),
              ),
            )
        ).map((doc) => [doc.id, doc.label] as const)
      : [],
  )
  const context = { site: (await productHooks(tx, orgId)).site, documentLabels }
  const zone = await findOrgLocale(tx, orgId)
  // Persona única: el paciente es una persona, y quien respondió puede ser ella u otra que la representa.
  const self = alias(contact, "form_self")
  const [patientRow] = await tx
    .select({ personId: patient.personId, sex: self.sex })
    .from(patient)
    .leftJoin(self, and(eq(self.id, patient.personId), eq(self.organizationId, orgId)))
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
    .limit(1)
  return rows.map((joined) => {
    const { row, authorName, professionalName, finalizerName, respondentName } = joined
    // Quién respondió, con las palabras de la ficha y de Documentos: «ella», «su madre, Carla».
    const byPatient = row.respondentContactId !== null && row.respondentContactId === patientRow?.personId
    const respondentWords =
      row.source !== "portal" || (!byPatient && respondentName === null)
        ? null
        : whoWords(
            byPatient
              ? { kind: "patient", name: respondentName, relation: null }
              : declarantOfLink({
                  name: respondentName ?? "",
                  relationship: joined.respondentRelationship,
                  relationshipDetail: joined.respondentRelationshipDetail,
                  kinship: joined.respondentKinship,
                }),
            patientRow?.sex ?? null,
          ) || (byPatient ? "el paciente" : null)
    const answers = (row.answers ?? {}) as Record<string, unknown>
    const marks = marksOf(row)
    const clioOf = (fieldId: string): string | null => {
      const mark = marks[fieldId]
      return mark ? `Clío · ${mark.atSign ? "confirmó al firmar" : "confirmó"} ${mark.byName ?? "alguien del equipo"} el ${dayTimeWords(mark.at, zone)}` : null
    }
    const sections = (schemas.get(row.id) as FormSchemaDef).sections
      .map((section) => ({
        id: section.id,
        title: section.title,
        items: section.fields
          .filter((field) => !field.showIf || conditionMet(field.showIf, answers[field.showIf.field]))
          .map((field) => ({
            id: field.id,
            label: field.label,
            type: field.type,
            options: field.options ?? null,
            unit: field.unit ?? null,
            ...answerOf(field, answers[field.id], context),
            clio: clioOf(field.id),
          })),
      }))
      .filter((section) => section.items.length > 0)
    const fromPerson = row.source === "portal"
    const via: FormRecord["via"] =
      fromPerson && (row.submittedVia === "enlace" || row.submittedVia === "portal") ? row.submittedVia : null
    const head = {
      id: row.id,
      title: row.templateTitle ?? "Formulario clínico",
      version: row.templateVersion,
      encounterId: row.encounterId,
      source: fromPerson ? ("portal" as const) : ("staff" as const),
      via,
      filledBy: fromPerson ? respondentName : authorName,
      filledByPatient: fromPerson && row.respondentContactId ? byPatient : null,
      respondentWords,
      respondentContactId: fromPerson ? row.respondentContactId : null,
      professionalName,
      submittedAt: row.submittedAt,
      // Un finalizado siempre tiene su hora; la de creación solo cubre una fila antigua sin ella. Lo
      // enviado y sin revisar no tiene ninguna.
      finalizedAt: row.status === "finalizado" ? (row.finalizedAt ?? row.createdAt) : null,
      finalizedBy: row.status === "finalizado" ? finalizerName : null,
      voidedAttention:
        joined.encounterStatus === "anulada" && joined.encounterVoidedAt
          ? { at: joined.encounterVoidedAt, reason: joined.encounterVoidReason ?? "" }
          : null,
    }
    return {
      ...head,
      whoWords: whoWordsOf(head),
      byWords: byWordsOf(head, zone),
      sections,
      addenda: addenda
        .filter((addendum) => addendum.responseId === row.id)
        .map(({ id, text, reason, authorName: addendumAuthor, createdAt }) => ({
          id,
          text,
          reason: reason?.trim() || null,
          authorName: addendumAuthor,
          createdAt,
        })),
      addendaTitle: fromPerson ? ("Correcciones" as const) : ("Adendas" as const),
      summary: summaryOf(sections),
    }
  })
}
