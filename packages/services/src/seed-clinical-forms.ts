import { type ConsentSections, SUGGESTED_CONSENT_TEMPLATES } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { eq } from "drizzle-orm"
import {
  advanceClinicalOrder,
  archiveSpecialty,
  createClinicalOrder,
  createConsentDocument,
  createConsentTemplate,
  createFormResponse,
  createFormTemplate,
  createSpecialty,
  finalizeFormResponse,
  listClinicalOrders,
  listConsentDocuments,
  listConsentTemplates,
  listFormResponses,
  listFormTemplates,
  listSpecialties,
  publishConsentTemplate,
  publishFormTemplate,
  setProfessionalSpecialties,
  setServiceSpecialties,
  signConsentDocument,
  updateFormResponseDraft,
  updateSpecialty,
  type FormSchemaDef,
} from "./clinical-forms.js"

/**
 * Semilla del dominio formularios clínicos/consentimientos/órdenes.
 * Determinista e idempotente (claves fijas por organización): el padre la
 * conecta a seed-dev con { orgId, ownerUserId, branchId, patientId, contactId }.
 */
export async function seedClinicalForms(
  tx: Db,
  input: {
    orgId: string
    ownerUserId: string
    branchId: string
    patientId: string
    contactId: string
  },
): Promise<void> {
  const { orgId, ownerUserId, patientId } = input

  const endodoncia = await upsertSpecialty(tx, orgId, ownerUserId, {
    key: "endodoncia",
    name: "Endodoncia",
    description: "Tratamiento de conducto y patología pulpar.",
  })
  const cirugia = await upsertSpecialty(tx, orgId, ownerUserId, {
    key: "cirugia-oral",
    name: "Cirugía oral",
    description: "Exodoncias y cirugía bucal.",
  })

  await setProfessionalSpecialties(tx, orgId, ownerUserId, ownerUserId, [
    endodoncia.id,
    cirugia.id,
  ])

  // Vincula la primera prestación del tarifario a endodoncia (si existe).
  const firstService = await tx
    .select({ id: serviceCatalog.id })
    .from(serviceCatalog)
    .where(eq(serviceCatalog.organizationId, orgId))
    .limit(1)
  if (firstService[0]) {
    await setServiceSpecialties(tx, orgId, ownerUserId, firstService[0].id, [
      endodoncia.id,
    ])
  }

  const evaluacionSchema: FormSchemaDef = {
    sections: [
      {
        id: "sintomas",
        title: "Síntomas",
        fields: [
          { id: "dolor", label: "¿Presenta dolor?", type: "booleano", required: true },
          {
            id: "intensidad",
            label: "Intensidad del dolor (0–10)",
            type: "numero",
            min: 0,
            max: 10,
          },
          {
            id: "zona",
            label: "Zona del dolor",
            type: "opcion_unica",
            options: ["Localizado", "Irradiado", "Generalizado"],
          },
        ],
      },
      {
        id: "examen",
        title: "Examen",
        fields: [
          { id: "hallazgos", label: "Hallazgos", type: "texto_largo", required: true },
          { id: "fecha_evaluacion", label: "Fecha de evaluación", type: "fecha", required: true },
        ],
      },
    ],
  }

  const template = await upsertFormTemplate(tx, orgId, ownerUserId, {
    key: "evaluacion-endodoncia",
    title: "Evaluación de endodoncia",
    description: "Ficha de evaluación previa al tratamiento de conducto.",
    specialtyId: endodoncia.id,
    schema: evaluacionSchema,
  })

  // Plantillas por procedimiento (secciones fijas). En la demo se publican
  // para poder usarlas; en una organización real quedan en borrador hasta
  // que alguien las revise.
  const consentTemplates = new Map<string, Awaited<ReturnType<typeof upsertConsentTemplate>>>()
  for (const suggestion of SUGGESTED_CONSENT_TEMPLATES) {
    consentTemplates.set(
      suggestion.key,
      await upsertConsentTemplate(tx, orgId, ownerUserId, {
        key: suggestion.key,
        title: suggestion.title,
        sections: suggestion.sections,
        specialtyId:
          suggestion.key === "endodoncia"
            ? endodoncia.id
            : suggestion.key === "exodoncia" || suggestion.key === "implante"
              ? cirugia.id
              : null,
      }),
    )
  }
  const consentTpl = consentTemplates.get("endodoncia")!

  // Captura de ejemplo sobre el paciente semilla (borrador → finalizado).
  const existing = await listFormResponses(tx, orgId, { patientId, templateId: template.id })
  if (existing.length === 0) {
    const response = await createFormResponse(tx, orgId, ownerUserId, {
      templateId: template.id,
      patientId,
      professionalUserId: ownerUserId,
      answers: {},
    })
    await updateFormResponseDraft(tx, orgId, ownerUserId, response.id, {
      professionalUserId: ownerUserId,
      answers: {
        dolor: true,
        intensidad: 7,
        zona: "Localizado",
        hallazgos: "Dolor provocado al frío en pieza 36, percusión positiva leve.",
        fecha_evaluacion: new Date().toISOString().slice(0, 10),
      },
    })
    await finalizeFormResponse(tx, orgId, ownerUserId, response.id)
  }

  const consents = await listConsentDocuments(tx, orgId, { patientId })
  if (consents.length === 0) {
    const document = await createConsentDocument(tx, orgId, ownerUserId, {
      templateId: consentTpl.id,
      patientId,
      procedureRef: "Tratamiento de conducto pieza 36",
    })
    await signConsentDocument(tx, orgId, ownerUserId, document.id, {
      signerKind: "paciente",
      signerContactId: input.contactId,
      comprehensionConfirmed: true,
      signatureData: { strokes: [[[80, 600], [200, 380], [320, 640], [460, 360], [600, 620]]] },
      professionalSignature: { strokes: [[[100, 500], [300, 300], [500, 520], [700, 320]]] },
    })
    // Pendiente de firma para la exodoncia planificada: aparece en el Resumen.
    await createConsentDocument(tx, orgId, ownerUserId, {
      templateId: consentTemplates.get("exodoncia")!.id,
      patientId,
      procedureRef: "Exodoncia pieza 38",
    })
  }

  const orders = await listClinicalOrders(tx, orgId, { patientId })
  if (orders.length === 0) {
    const order = await createClinicalOrder(tx, orgId, ownerUserId, {
      kind: "interconsulta",
      specialtyId: cirugia.id,
      patientId,
      recipient: "Dr. Cirujano de demostración",
      title: "Evaluación de tercer molar",
      detail: "Pieza 48 semi-retenida: evaluar exodoncia quirúrgica.",
    })
    await advanceClinicalOrder(tx, orgId, ownerUserId, order.id, "en_proceso")
  }

  // Especialidad archivada de muestra (sin plantillas publicadas).
  const muestra = await upsertSpecialty(tx, orgId, ownerUserId, {
    key: "muestra-archivada",
    name: "Muestra archivada",
    description: "Especialidad de ejemplo desactivada.",
  })
  if (muestra.isActive) {
    await archiveSpecialty(tx, orgId, ownerUserId, muestra.id)
  }
}

async function upsertSpecialty(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { key: string; name: string; description: string },
) {
  const existing = (await listSpecialties(tx, orgId)).find((s) => s.key === input.key)
  if (existing) {
    if (!existing.isActive || existing.name !== input.name) {
      return updateSpecialty(tx, orgId, actorUserId, existing.id, {
        name: input.name,
        description: input.description,
        isActive: true,
      })
    }
    return existing
  }
  return createSpecialty(tx, orgId, actorUserId, input)
}

async function upsertFormTemplate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: {
    key: string
    title: string
    description: string
    specialtyId: string
    schema: FormSchemaDef
  },
) {
  const published = (await listFormTemplates(tx, orgId, { status: "publicado" })).find(
    (t) => t.key === input.key,
  )
  if (published) return published
  const draft = await createFormTemplate(tx, orgId, actorUserId, input)
  return publishFormTemplate(tx, orgId, actorUserId, draft.id)
}

async function upsertConsentTemplate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { key: string; title: string; sections: ConsentSections; specialtyId: string | null },
) {
  const published = (await listConsentTemplates(tx, orgId, { status: "publicado" })).find(
    (t) => t.key === input.key,
  )
  if (published) return published
  const draft = await createConsentTemplate(tx, orgId, actorUserId, input)
  return publishConsentTemplate(tx, orgId, actorUserId, draft.id)
}
