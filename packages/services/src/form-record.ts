/**
 * Un formulario finalizado, listo para leerse: cada pregunta con su respuesta en
 * palabras, sus adendas y quién y cuándo. Lo leen igual la copia de la historia
 * (el PDF y el `QuestionnaireResponse` de FHIR), la atención firmada y la
 * Historia: una sola regla para decir una respuesta, no una por pantalla.
 *
 * Solo lo finalizado es registro clínico. Un borrador, también el que la persona
 * envió y el equipo aún no revisó, no entra aquí.
 */
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { patient, patientDocument } from "@odentia/db/schema/clinical"
import { clinicalFormAddendum, clinicalFormResponse } from "@odentia/db/schema/clinical-forms"
import { contact } from "@odentia/db/schema/crm"
import { and, asc, eq, inArray } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { conditionMet, type FieldType, type FormFieldDef, type FormSchemaDef } from "./clinical-forms.js"
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
  /** El profesional a cargo, si se indicó. */
  professionalName: string | null
  /** Cuándo lo envió la persona, si lo respondió ella. */
  submittedAt: Date | null
  finalizedAt: Date
  /** Quién lo finalizó: en lo que envió la persona, quien lo revisó. null si no quedó guardado (lo de antes). */
  finalizedBy: string | null
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
  addenda: Array<{ id: string; text: string; authorName: string | null; createdAt: Date }>
  /** Cómo se llaman: «Correcciones» en lo que envió la persona, «Adendas» en lo del equipo. */
  addendaTitle: "Adendas" | "Correcciones"
  /** Lo respondido en una línea, para verlo sin abrirlo. */
  summary: string
}

/** «13/11/2026»: una fecha sin hora es ese día en cualquier zona. */
function civilDay(value: string): string {
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
  const role =
    form.filledByPatient === true ? " (paciente)" : form.filledByPatient === false ? " (en nombre del paciente)" : ""
  return `Lo respondió ${form.filledBy ?? "la persona"}${role}`
}

/**
 * Quién lo cerró: lo que envió la persona lo revisa el equipo; lo del equipo se
 * finaliza. Sin quién (lo de antes de guardarlo) no se afirma un nombre.
 */
function closedWordsOf(form: FormHead): string {
  if (form.source === "portal") return form.finalizedBy ? `lo revisó ${form.finalizedBy}` : "el equipo lo revisó"
  return form.finalizedBy ? `lo finalizó ${form.finalizedBy}` : "finalizado"
}

/** Quién lo llenó y quién lo cerró, sin fechas. En lo del equipo, quien lo finalizó solo si fue otra persona. */
function whoWordsOf(form: FormHead): string {
  const sameHand = form.source !== "portal" && (!form.finalizedBy || form.finalizedBy === form.filledBy)
  return sameHand ? filledWordsOf(form) : `${filledWordsOf(form)} · ${closedWordsOf(form)}`
}

/**
 * «Lo llenó Ana Torres · lo finalizó Ana Torres el 13 de noviembre de 2026, 15:02»,
 * «Lo respondió Marta Ríos (paciente) desde su enlace el … · lo revisó Ana Torres el …».
 */
function byWordsOf(form: FormHead, zone: Zone): string {
  const closed = `${closedWordsOf(form)} el ${dayTimeWords(form.finalizedAt, zone)}`
  if (form.source === "portal") {
    const via = form.via === "enlace" ? " desde su enlace" : form.via === "portal" ? " desde el portal" : ""
    const sent = form.submittedAt ? ` el ${dayTimeWords(form.submittedAt, zone)}` : ""
    return `${filledWordsOf(form)}${via}${sent} · ${closed}`
  }
  const charge =
    form.professionalName && form.professionalName !== form.filledBy ? ` · a cargo de ${form.professionalName}` : ""
  return `${filledWordsOf(form)}${charge} · ${closed}`
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
        : `${item.label.replace(/^¿\s*/, "").replace(/\s*[?:]$/, "")}: ${item.words}`
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
 * `encounterIds`, solo los que se llenaron en esas atenciones; con `ids`, solo esos.
 */
export async function loadFormRecords(
  tx: Db,
  orgId: string,
  patientId: string,
  scope: { encounterIds?: readonly string[]; ids?: readonly string[] } = {},
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
    })
    .from(clinicalFormResponse)
    .leftJoin(author, eq(author.id, clinicalFormResponse.authorUserId))
    .leftJoin(professional, eq(professional.id, clinicalFormResponse.professionalUserId))
    .leftJoin(finalizer, eq(finalizer.id, clinicalFormResponse.finalizedBy))
    .leftJoin(
      contact,
      and(eq(contact.id, clinicalFormResponse.respondentContactId), eq(contact.organizationId, orgId)),
    )
    .where(
      and(
        eq(clinicalFormResponse.organizationId, orgId),
        eq(clinicalFormResponse.patientId, patientId),
        eq(clinicalFormResponse.status, "finalizado"),
        ...(scope.encounterIds ? [inArray(clinicalFormResponse.encounterId, [...scope.encounterIds])] : []),
        ...(scope.ids ? [inArray(clinicalFormResponse.id, [...scope.ids])] : []),
      ),
    )
    .orderBy(asc(clinicalFormResponse.finalizedAt), asc(clinicalFormResponse.id))
  if (rows.length === 0) return []
  const responseIds = rows.map(({ row }) => row.id)
  const addenda = await tx
    .select({
      id: clinicalFormAddendum.id,
      responseId: clinicalFormAddendum.responseId,
      text: clinicalFormAddendum.text,
      authorName: user.name,
      createdAt: clinicalFormAddendum.createdAt,
    })
    .from(clinicalFormAddendum)
    .leftJoin(user, eq(user.id, clinicalFormAddendum.createdBy))
    .where(and(eq(clinicalFormAddendum.organizationId, orgId), inArray(clinicalFormAddendum.responseId, responseIds)))
    .orderBy(asc(clinicalFormAddendum.createdAt), asc(clinicalFormAddendum.id))
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
  const [self] = await tx
    .select({ personId: patient.personId })
    .from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
    .limit(1)
  return rows.map(({ row, authorName, professionalName, finalizerName, respondentName }) => {
    const answers = (row.answers ?? {}) as Record<string, unknown>
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
      filledByPatient: fromPerson && row.respondentContactId ? row.respondentContactId === self?.personId : null,
      respondentContactId: fromPerson ? row.respondentContactId : null,
      professionalName,
      submittedAt: row.submittedAt,
      // Un finalizado siempre tiene su hora; la de creación solo cubre una fila antigua sin ella.
      finalizedAt: row.finalizedAt ?? row.createdAt,
      finalizedBy: finalizerName,
    }
    return {
      ...head,
      whoWords: whoWordsOf(head),
      byWords: byWordsOf(head, zone),
      sections,
      addenda: addenda
        .filter((addendum) => addendum.responseId === row.id)
        .map(({ id, text, authorName: addendumAuthor, createdAt }) => ({ id, text, authorName: addendumAuthor, createdAt })),
      addendaTitle: fromPerson ? ("Correcciones" as const) : ("Adendas" as const),
      summary: summaryOf(sections),
    }
  })
}
