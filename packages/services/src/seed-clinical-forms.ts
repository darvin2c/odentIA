import { type ConsentSections, SUGGESTED_CONSENT_TEMPLATES } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { clinicalFormResponse } from "@odentia/db/schema/clinical-forms"
import { orgProfile } from "@odentia/db/schema/org"
import { and, eq, ilike } from "drizzle-orm"
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
  linkServicesToSuggestedConsents,
  listSpecialties,
  markConsentTemplateReviewed,
  publishConsentTemplate,
  publishFormTemplate,
  setConsentTemplateServices,
  setProfessionalSpecialties,
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
  // La «Cirugía Bucal y Maxilofacial» del Perú, renombrada por la clínica (una
  // sola lista, ADR 0039; las especialidades del país, ADR 0069): a ella van los
  // servicios de cirugía de la biblioteca.
  const cirugia = await upsertSpecialty(tx, orgId, ownerUserId, {
    key: "cirugia_bucal_maxilofacial",
    name: "Cirugía oral",
    description: "Exodoncias y cirugía bucal.",
  })

  // Quien crea la clínica atiende la cirugía; la endodoncia la adscribe seed-dev.
  await setProfessionalSpecialties(tx, orgId, ownerUserId, ownerUserId, [cirugia.id])

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
  // La demo muestra el avance: dos ya revisados, los demás con su texto sugerido.
  for (const key of ["endodoncia", "exodoncia"]) {
    await markConsentTemplateReviewed(tx, orgId, ownerUserId, consentTemplates.get(key)!.id)
  }
  await linkServicesToSuggestedConsents(tx, orgId, ownerUserId)

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

  // Cuestionario previo que el paciente responde desde el portal; Rosa ya lo
  // envió y queda «declarado» para que la profesional lo revise.
  const previo = await upsertFormTemplate(tx, orgId, ownerUserId, {
    key: "cuestionario-previo",
    title: "Cuestionario previo a la cita",
    description: "Lo completa el paciente o su representante antes de la cita.",
    specialtyId: null,
    respondent: "portal",
    schema: {
      sections: [
        {
          id: "motivo",
          title: "Motivo",
          fields: [
            { id: "motivo", label: "¿Por qué vienes a la consulta?", type: "texto_largo", required: true },
            {
              id: "dolor",
              label: "¿Tienes dolor ahora?",
              type: "booleano",
              required: true,
            },
            {
              id: "intensidad",
              label: "¿Cuánto te duele? (0 sin dolor, 10 el peor dolor)",
              type: "escala",
              min: 0,
              max: 10,
              required: true,
              showIf: { field: "dolor", equals: true },
            },
          ],
        },
        {
          id: "salud",
          title: "Salud",
          fields: [
            {
              id: "alergia",
              label: "¿Eres alérgica o alérgico a algún medicamento, material o alimento?",
              type: "booleano",
              required: true,
            },
            {
              id: "alergia_cual",
              label: "¿A qué y qué te pasó?",
              type: "texto",
              required: true,
              showIf: { field: "alergia", equals: true },
              // Al finalizarlo, pasa a sus antecedentes como alergia sin confirmar.
              definition: "AllergyIntolerance.code",
            },
            { id: "medicamentos", label: "¿Tomas algún medicamento? ¿Cuál y cuánto?", type: "texto_largo" },
            {
              id: "enfermedades",
              label: "¿Te han diagnosticado alguna enfermedad?",
              type: "opcion_multiple",
              help: "Por ejemplo presión alta, diabetes, problemas del corazón o de coagulación.",
              options: ["Presión alta", "Diabetes", "Corazón", "Coagulación", "Ninguna", "Otra"],
            },
          ],
        },
      ],
    },
  })
  const declared = await listFormResponses(tx, orgId, { patientId, templateId: previo.id })
  if (declared.length === 0) {
    await tx.insert(clinicalFormResponse).values({
      organizationId: orgId,
      templateId: previo.id,
      templateVersion: previo.version,
      templateTitle: previo.title,
      templateSnapshot: previo.schema,
      patientId,
      status: "borrador",
      source: "portal",
      respondentContactId: input.contactId,
      submittedAt: new Date(),
      answers: {
        motivo: "Me duele una muela de abajo al tomar frío.",
        dolor: true,
        intensidad: 6,
        alergia: true,
        alergia_cual: "Penicilina: ronchas en la piel",
        medicamentos: "Losartán 50 mg cada mañana",
        enfermedades: ["Presión alta"],
      },
    })
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

  // «Se pide para» (fase 3, paso 2B): la exodoncia pide su consentimiento y el
  // de anestesia local; al registrarla, la atención propone prepararlos.
  const extractions = await tx
    .select({ id: serviceCatalog.id })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.organizationId, orgId), ilike(serviceCatalog.name, "%exodoncia%")))
  if (extractions.length > 0) {
    for (const key of ["exodoncia", "anestesia-local"]) {
      const consentTemplate = consentTemplates.get(key)
      if (consentTemplate)
        await setConsentTemplateServices(
          tx,
          orgId,
          ownerUserId,
          consentTemplate.id,
          extractions.map((row) => row.id),
        )
    }
  }
  // La anestesia de la exodoncia: pendiente aquí; seed-dev la deja firmada en
  // papel con la foto de la hoja.
  const anestesia = consentTemplates.get("anestesia-local")
  if (anestesia && !(await listConsentDocuments(tx, orgId, { patientId })).some((doc) => doc.templateId === anestesia.id)) {
    await createConsentDocument(tx, orgId, ownerUserId, {
      templateId: anestesia.id,
      patientId,
      procedureRef: "Anestesia local para la exodoncia de la pieza 38",
    })
  }

  const orders = await listClinicalOrders(tx, orgId, { patientId })
  // Una orden de imagen con su diagnóstico, para «Imprimir» y «Enviar».
  if (!orders.some((order) => order.kind === "imagen")) {
    // Dientes impactados, en la lista de la clínica (la demo de producción usa la CIE-11).
    const [profile] = await tx
      .select({ system: orgProfile.diagnosisSystem })
      .from(orgProfile)
      .where(eq(orgProfile.organizationId, orgId))
      .limit(1)
    await createClinicalOrder(tx, orgId, ownerUserId, {
      kind: "imagen",
      patientId,
      recipient: "Centro de imágenes Miraflores",
      title: "Radiografía panorámica",
      detail: "Evaluar tercer molar inferior izquierdo (pieza 38).",
      diagnosisCode: profile?.system === "ICD-11" ? "DA07.8" : "K01.1",
    })
  }
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
    specialtyId: string | null
    schema: FormSchemaDef
    respondent?: "staff" | "portal"
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
