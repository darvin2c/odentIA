import { type ConsentSections, SUGGESTED_CONSENT_TEMPLATES } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { clinicalFormResponse } from "@odentia/db/schema/clinical-forms"
import { orgProfile } from "@odentia/db/schema/org"
import { demoSignatureStrokes } from "./demo-signature.js"
import { and, eq, ilike, sql } from "drizzle-orm"
import {
  advanceClinicalOrder,
  archiveFormTemplate,
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
import { ensureClinicForms, markFormTemplateLooked } from "./consultation-forms.js"

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

  // Las fichas de consulta que vienen con el producto (ADR 0117), como en toda clínica nueva. La de
  // endodoncia ya la abrió alguien: la lista dice «Miraste 1 de 4».
  await ensureClinicForms(tx, orgId)
  const template = (await listFormTemplates(tx, orgId, { status: "publicado" })).find(
    (t) => t.key === "evaluacion-de-endodoncia",
  )
  if (!template) throw new Error("Falta la ficha de endodoncia del producto en la semilla")
  await markFormTemplateLooked(tx, orgId, ownerUserId, template.id)

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
        pieza: 36,
        dolor: "Provocado",
        frio: "Aumentada, persiste",
        percusion: "Positiva",
        palpacion: "Negativa",
        diagnostico_pulpar: "Pulpitis irreversible sintomática",
        diagnostico_apical: "Periodontitis apical sintomática",
        observaciones: "Dolor provocado al frío en la pieza 36, que persiste al retirar el estímulo.",
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
          // Lo de su salud (alergias, medicamentos, enfermedades) ya lo pregunta «Tus datos y tu
          // salud» de su enlace: el cuestionario no lo repite (entrega 2). Pregunta lo de la visita.
          id: "visita",
          title: "Tu visita",
          fields: [
            {
              id: "nervios",
              label: "¿Te pone nerviosa o nervioso ir al dentista?",
              type: "booleano",
              required: true,
            },
            {
              id: "nervios_que",
              label: "¿Qué te ayudaría a estar más tranquila o tranquilo?",
              type: "texto",
              showIf: { field: "nervios", equals: true },
            },
            { id: "antes", label: "¿Algo que quieras que sepamos antes de empezar?", type: "texto_largo" },
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
        nervios: true,
        nervios_que: "Que me expliquen antes cada paso",
        antes: "Trabajo de noche: prefiero las citas por la tarde.",
      },
    })
  }

  // Un formulario que la clínica dejó de usar: la demo muestra «Ya no se usan» y «Volver a usar».
  // Solo la primera vez: si alguien lo volvió a usar en la demo, sembrar otra vez no lo toca.
  const everHadPeriodontal = (await listFormTemplates(tx, orgId, {})).some((t) => t.key === "ficha-periodontal")
  if (!everHadPeriodontal) {
    const draft = await createFormTemplate(tx, orgId, ownerUserId, {
      key: "ficha-periodontal",
      title: "Ficha periodontal",
      description: "Evaluación de encías antes de un tratamiento periodontal.",
      schema: {
        sections: [
          {
            id: "encias",
            title: "Encías",
            fields: [
              { id: "sangrado", label: "¿Sangran al sondaje?", type: "booleano", required: true },
              {
                id: "zonas",
                label: "¿Dónde?",
                type: "opcion_multiple",
                options: ["Superior derecha", "Superior izquierda", "Inferior derecha", "Inferior izquierda"],
                showIf: { field: "sangrado", equals: true },
              },
              { id: "higiene", label: "Higiene", type: "opcion_unica", options: ["Buena", "Regular", "Deficiente"] },
              { id: "observaciones", label: "Observaciones", type: "texto_largo" },
            ],
          },
        ],
      },
    })
    const published = await publishFormTemplate(tx, orgId, ownerUserId, draft.id)
    await archiveFormTemplate(tx, orgId, ownerUserId, published.id)
  }

  const consents = await listConsentDocuments(tx, orgId, { patientId })
  if (consents.length === 0) {
    const document = await createConsentDocument(tx, orgId, ownerUserId, {
      templateId: consentTpl.id,
      patientId,
      procedureRef: "Tratamiento de conducto pieza 36 (primer molar inferior izquierdo)",
    })
    await signConsentDocument(tx, orgId, ownerUserId, document.id, {
      signerKind: "paciente",
      signerContactId: input.contactId,
      comprehensionConfirmed: true,
      // Un trazo con forma de firma; la del profesional se copia de la que guardó en su perfil (ADR 0131).
      signatureData: { strokes: demoSignatureStrokes(input.contactId) },
    })
    // Pendiente de firma para la exodoncia planificada: aparece en el Resumen.
    await createConsentDocument(tx, orgId, ownerUserId, {
      templateId: consentTemplates.get("exodoncia")!.id,
      patientId,
      procedureRef: "Exodoncia pieza 38 (tercer molar inferior izquierdo, muela del juicio)",
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
  // Las endodoncias propias de la demo (la posterior vital, sin plantilla de la biblioteca) también
  // piden el consentimiento de endodoncia: sin esto la de la 46 se firmaba sin él (QA del 9 nov).
  const endodontics = await tx
    .select({ id: serviceCatalog.id })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.organizationId, orgId), ilike(serviceCatalog.name, "%endodoncia%")))
  if (endodontics.length > 0) {
    const linked = await tx.execute<{ serviceId: string }>(sql`
      select service_id as "serviceId" from consent_template_service
      where organization_id = ${orgId} and template_key = ${consentTpl.key}`)
    await setConsentTemplateServices(tx, orgId, ownerUserId, consentTpl.id, [
      ...new Set([...linked.map((row) => row.serviceId), ...endodontics.map((row) => row.id)]),
    ])
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
