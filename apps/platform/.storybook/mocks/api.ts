/**
 * Transporte falso de la API para las maquetas de Storybook.
 *
 * Las maquetas usan los componentes REALES del platform (odontograma, ficha de
 * la pieza, paneles). Para que se comporten igual que en producción, este
 * módulo reemplaza solo `lib/api`: mismos contratos `{ data }`, mismos códigos
 * de error y un almacén en memoria que se muta de verdad, de modo que registrar
 * un hallazgo mueve el odontograma y el historial.
 *
 * Nada de esto entra en el bundle de la app: el plugin de Vite
 * (`.storybook/data-mocks.ts`) solo remapea `lib/api` dentro de Storybook.
 */
import type {
  OdontogramAssessment,
  OdontogramEntry,
  OdontogramState,
  PatientDocument,
  PlanItem,
  ProcedureItem,
  TreatmentPlan,
} from "../../src/lib/patients"

/** Mensaje de error en la forma que consumen los componentes reales. */
export class ApiError extends Error {
  shape: { message?: string; code?: string }
  status: number

  constructor(status: number, shape: { message?: string; code?: string }) {
    super(shape.message ?? `Error ${status}`)
    this.shape = shape
    this.status = status
  }
}

export const DEMO_PATIENT_ID = "demo-patient"

const at = (hoursAgo: number): string =>
  new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString()

let counter = 0
const nextId = (prefix: string): string => `${prefix}-${++counter}`

/** Hallazgos vigentes: códigos normativos reales de `@odentia/clinical`. */
let entries: OdontogramEntry[] = [
  {
    id: nextId("entry"),
    toothNumber: 11,
    condition: "diastema",
    status: "recorded",
    details: {},
    createdAt: at(720),
  },
  {
    id: nextId("entry"),
    toothNumber: 16,
    condition: "sealant",
    status: "recorded",
    details: { quality: "good" },
    createdAt: at(720),
  },
  {
    id: nextId("entry"),
    toothNumber: 26,
    condition: "definitive_restoration",
    status: "recorded",
    details: { quality: "good", specifications: "Resina compuesta, oclusal" },
    createdAt: at(96),
  },
  {
    id: nextId("entry"),
    toothNumber: 26,
    condition: "caries",
    surface: "vestibular",
    diagnosisCode: "K02.1",
    note: "Lesión activa en vestibular",
    status: "recorded",
    details: {},
    createdAt: at(96),
  },
  {
    id: nextId("entry"),
    toothNumber: 36,
    condition: "caries",
    surface: "oclusal",
    diagnosisCode: "K02.1",
    note: "Caries oclusal profunda, sin respuesta pulpar.",
    status: "recorded",
    details: {},
    createdAt: at(2),
  },
  {
    id: nextId("entry"),
    toothNumber: 36,
    condition: "root_canal_treatment",
    status: "recorded",
    details: { quality: "good", specifications: "Endodoncia en curso" },
    createdAt: at(1),
  },
  {
    id: nextId("entry"),
    toothNumber: 46,
    condition: "missing_tooth",
    status: "recorded",
    details: { specifications: "Extraída en 2024" },
    createdAt: at(5000),
  },
]

const plans: TreatmentPlan[] = [
  {
    id: "plan-1",
    title: "Plan de tratamiento",
    originEncounterId: null,
    isLegacy: false,
    createdAt: at(3),
  },
]

let planItems: PlanItem[] = [
  {
    id: "item-endo-36",
    planId: "plan-1",
    budgetId: null,
    decision: "aceptado",
    decisionStatus: "aceptado",
    decidedAt: at(30),
    decidedByContactId: null,
    decidedByName: "Lucía Quispe",
    decisionNote: null,
    supersedesItemId: null,
    statusReason: null,
    startedAt: at(2),
    completedAt: null,
    serviceId: "svc-endo",
    toothNumber: 36,
    scope: "tooth",
    surfaces: [],
    quadrant: null,
    arch: null,
    title: "Endodoncia unirradicular",
    detail: "Pieza 36 con caries oclusal profunda.",
    diagnosisCode: "K02.1",
    priceCents: 48000,
    currency: "PEN",
    status: "en_curso",
    sourceEncounterId: null,
    createdAt: at(30),
  },
  {
    id: "item-resina-36",
    planId: "plan-1",
    budgetId: null,
    decision: "pendiente",
    decisionStatus: "pendiente",
    decidedAt: null,
    decidedByContactId: null,
    decidedByName: null,
    decisionNote: null,
    supersedesItemId: null,
    statusReason: null,
    startedAt: null,
    completedAt: null,
    serviceId: "svc-resina",
    toothNumber: 36,
    scope: "tooth",
    surfaces: [],
    quadrant: null,
    arch: null,
    title: "Restauración con resina compuesta",
    detail: null,
    diagnosisCode: "K02.1",
    priceCents: 19000,
    currency: "PEN",
    status: "pendiente",
    sourceEncounterId: null,
    createdAt: at(30),
  },
  {
    id: "item-resina-26",
    planId: "plan-1",
    budgetId: null,
    decision: "pendiente",
    decisionStatus: "pendiente",
    decidedAt: null,
    decidedByContactId: null,
    decidedByName: null,
    decisionNote: null,
    supersedesItemId: null,
    statusReason: null,
    startedAt: null,
    completedAt: null,
    serviceId: "svc-resina",
    toothNumber: 26,
    scope: "tooth",
    surfaces: [],
    quadrant: null,
    arch: null,
    title: "Restauración con resina compuesta",
    detail: null,
    diagnosisCode: "K02.1",
    priceCents: 19000,
    currency: "PEN",
    status: "pendiente",
    sourceEncounterId: null,
    createdAt: at(96),
  },
]

const documents: PatientDocument[] = [
  {
    id: "doc-1",
    category: "radiografia",
    label: "Radiografía periapical 36",
    contentType: "image/png",
    sizeBytes: 240_000,
    encounterId: null,
    planItemId: "item-endo-36",
    budgetId: null,
    encounterProcedureId: null,
    prescriptionId: null,
    followUpId: null,
    paymentId: null,
    toothNumbers: [36],
    tags: ["endodoncia"],
    contextVersion: 1,
    createdAt: at(2),
  },
]

/** Actos de la atención abierta: la pieza 36 ya tiene la apertura cameral de hoy. */
let procedures: ProcedureItem[] = [
  {
    id: "proc-1",
    encounterId: "demo-encounter",
    serviceId: "svc-endo",
    toothNumber: 36,
    scope: "tooth",
    surfaces: [],
    quadrant: null,
    arch: null,
    description: "Endodoncia unirradicular · sesión 1",
    diagnosisCode: "K02.1",
    planItemId: "item-endo-36",
    priceCents: 48000,
    currency: "PEN",
    createdAt: at(2),
  },
]

const assessments: OdontogramAssessment[] = []

const services = [
  {
    id: "svc-limpieza",
    templateId: "LIMPIEZA",
    source: "template" as const,
    code: "LIMPIEZA",
    name: "Limpieza dental (profilaxis)",
    specialty: "prevencion",
    scope: "general" as const,
    priceCents: 12000,
    currency: "PEN",
    durationMin: 30,
    isActive: true,
  },
  {
    id: "svc-endo",
    templateId: "ENDO",
    source: "template" as const,
    code: "ENDO",
    name: "Endodoncia unirradicular",
    specialty: "endodoncia",
    scope: "tooth" as const,
    priceCents: 48000,
    currency: "PEN",
    durationMin: 90,
    isActive: true,
  },
  {
    id: "svc-resina",
    templateId: "RESINA",
    source: "template" as const,
    code: "RESINA",
    name: "Restauración con resina compuesta",
    specialty: "restauradora",
    scope: "surfaces" as const,
    priceCents: 19000,
    currency: "PEN",
    durationMin: 45,
    isActive: true,
  },
]

const cie10 = [
  { code: "K02.1", description: "Caries de la dentina" },
  { code: "K04.0", description: "Pulpitis" },
  { code: "K08.1", description: "Pérdida de dientes por accidente, extracción o enfermedad" },
]

/** Vista vigente del odontograma: el servidor la calcula, aquí sale del historial. */
function odontogramState(): OdontogramState {
  return { teeth: {}, history: entries }
}

function json(data: unknown): unknown {
  return data
}

/** Latencia artificial: deja ver los estados de carga reales de los paneles. */
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** Contrato mínimo de `apiFetch`: misma forma de error y de respuesta. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  await delay(40)
  const [rawPath, rawQuery = ""] = path.split("?")
  const query = new URLSearchParams(rawQuery)
  const segments = rawPath.split("/").filter(Boolean)
  const method = (init?.method ?? "GET").toUpperCase()
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}

  // /api/patients/:id/...
  const patientId = segments[0] === "api" && segments[1] === "patients" ? segments[2] : null
  const rest = segments.slice(3).join("/")

  if (patientId) {
    if (rest === "odontogram" && method === "GET") return json({ data: odontogramState() }) as T

    if (rest === "odontogram/entries" && method === "POST") {
      const entry: OdontogramEntry = {
        id: nextId("entry"),
        toothNumber: Number(body.toothNumber),
        surface: (body.surface as string | null) ?? null,
        condition: String(body.condition),
        status: "recorded",
        diagnosisCode: (body.diagnosisCode as string | null) ?? null,
        note: (body.note as string | null) ?? null,
        encounterId: (body.encounterId as string | null) ?? null,
        details: (body.details as OdontogramEntry["details"]) ?? {},
        needsReview: false,
        createdAt: new Date().toISOString(),
      }
      entries = [entry, ...entries]
      return json({ data: entry }) as T
    }

    // El panel de la pieza: hallazgo (con su diagnóstico y tratamiento) en una sola llamada.
    if (rest === "odontogram/findings" && method === "POST") {
      const teeth = (body.toothNumbers as number[] | undefined) ?? []
      const surfaces = (body.surfaces as string[] | undefined) ?? []
      const diagnosis = body.diagnosis as { cie10Code?: string } | null | undefined
      const created: OdontogramEntry[] = teeth.flatMap((toothNumber) =>
        (surfaces.length ? surfaces : [null]).map((surface) => ({
          id: nextId("entry"),
          toothNumber,
          surface,
          condition: String(body.condition),
          status: "recorded",
          diagnosisCode: diagnosis?.cie10Code ?? null,
          note: (body.note as string | null) ?? null,
          encounterId: (body.encounterId as string | null) ?? null,
          details: (body.details as OdontogramEntry["details"]) ?? {},
          needsReview: false,
          createdAt: new Date().toISOString(),
        })),
      )
      entries = [...created, ...entries]
      return json({ data: { entries: created, diagnoses: [], planItems: [] } }) as T
    }

    const voidMatch = /^odontogram\/entries\/([^/]+)\/void$/.exec(rest)
    if (voidMatch && method === "POST") {
      const id = voidMatch[1]
      entries = entries.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              status: "voided",
              voidedAt: new Date().toISOString(),
              voidReason: (body.reason as string | null) ?? null,
            }
          : entry,
      )
      return json({ data: entries.find((entry) => entry.id === id) }) as T
    }

    if (rest === "odontogram/assessments" && method === "GET") {
      return json({ data: assessments }) as T
    }
    if (rest === "odontogram/assessments" && method === "POST") {
      const assessment = {
        id: nextId("assessment"),
        patientId,
        patientName: "Lucía Quispe",
        patientNumber: 123,
        authorUserId: "demo-user",
        createdAt: new Date().toISOString(),
        purpose: (body.purpose as OdontogramAssessment["purpose"]) ?? "personal",
        standard: "NTS 188-MINSA/DGIESP-2022",
        specifications: String(body.specifications ?? ""),
        observations: String(body.observations ?? ""),
        // Como el servidor: quién firma sale del perfil profesional, sin trazo.
        examinerName: "Ana Torres",
        examinerTitle: "Cirujano dentista",
        registrationNumber: "COP 12345",
        encounterId: null,
        entries: entries.filter((entry) => !entry.voidedAt),
      } as OdontogramAssessment
      assessments.unshift(assessment)
      return json({ data: assessment }) as T
    }

    if (rest === "plan" && method === "GET") return json({ data: planItems }) as T

    if (rest === "plan/items" && method === "POST") {
      // El precio y la moneda salen de la prestación, como en el servidor real.
      const offer = services.find((service) => service.id === body.serviceId)
      const item: PlanItem = {
        ...planItems[0],
        id: nextId("item"),
        priceCents: offer?.priceCents ?? planItems[0]?.priceCents ?? null,
        currency: offer?.currency ?? planItems[0]?.currency ?? "PEN",
        planId: String(body.planId),
        serviceId: String(body.serviceId),
        toothNumber: body.toothNumber == null ? null : Number(body.toothNumber),
        scope: (body.scope as string | null) ?? "tooth",
        surfaces: (body.surfaces as string[]) ?? [],
        title: String(body.title ?? "Tratamiento"),
        detail: (body.detail as string | null) ?? null,
        diagnosisCode: (body.diagnosisCode as string | null) ?? null,
        status: "pendiente",
        decision: "pendiente",
        decisionStatus: "pendiente",
        decidedAt: null,
        decidedByName: null,
        startedAt: null,
        completedAt: null,
        sourceEncounterId: (body.sourceEncounterId as string | null) ?? null,
        createdAt: new Date().toISOString(),
      }
      planItems = [...planItems, item]
      return json({ data: item }) as T
    }

    if (rest === "plan/items/batch" && method === "POST") {
      const toothNumber = Number(body.toothNumber)
      const created: PlanItem[] = [
        {
          ...planItems[0],
          id: nextId("item"),
          planId: String(body.planId),
          serviceId: String(body.serviceId),
          toothNumber,
          scope: "tooth",
          title: String(body.title ?? "Tratamiento"),
          detail: (body.detail as string | null) ?? null,
          status: "pendiente",
          decision: "pendiente",
          decisionStatus: "pendiente",
          startedAt: null,
          completedAt: null,
          createdAt: new Date().toISOString(),
        },
      ]
      planItems = [...planItems, ...created]
      return json({ data: created }) as T
    }

    if (rest === "plans" && method === "GET") {
      return json({
        data: plans.map((plan) => ({
          plan,
          status: "en_curso",
          pendingItems: planItems.filter((item) => item.status === "pendiente").length,
        })),
      }) as T
    }
    if (rest === "plans" && method === "POST") {
      const plan: TreatmentPlan = {
        id: nextId("plan"),
        title: String(body.title),
        originEncounterId: (body.originEncounterId as string | null) ?? null,
        isLegacy: false,
        createdAt: new Date().toISOString(),
      }
      plans.push(plan)
      return json({ data: plan }) as T
    }

    const encounterMatch = /^encounters\/([^/]+)$/.exec(rest)
    if (encounterMatch && method === "GET") {
      return json({
        data: {
          encounter: {
            id: encounterMatch[1],
            patientId,
            status: "borrador",
            reason: "Primera consulta preventiva",
            evolution: null,
            indications: null,
            examination: null,
            branchId: null,
            dentistUserId: "demo-user",
            createdAt: at(3),
            updatedAt: at(1),
          },
          teeth: [
            ...new Set(
              procedures.map((row) => row.toothNumber).filter((t): t is number => t != null),
            ),
          ],
          procedures,
          notes: [],
          odontogramEntries: entries.filter((entry) => !entry.voidedAt),
          documents,
          addenda: [],
          plannedItems: planItems.filter((item) => item.status === "en_curso"),
          indicatedItems: [],
        },
      }) as T
    }

    if (/^encounters\/[^/]+\/procedures$/.test(rest) && method === "POST") {
      const procedure: ProcedureItem = {
        id: nextId("proc"),
        encounterId: "demo-encounter",
        serviceId: (body.serviceId as string | null) ?? null,
        toothNumber: body.toothNumber == null ? null : Number(body.toothNumber),
        scope: (body.scope as string | null) ?? "tooth",
        surfaces: (body.surfaces as string[]) ?? [],
        quadrant: null,
        arch: null,
        description: String(body.description ?? "Acto registrado"),
        diagnosisCode: (body.diagnosisCode as string | null) ?? null,
        planItemId: (body.planItemId as string | null) ?? null,
        priceCents: (body.priceCents as number | null) ?? null,
        currency: (body.currency as string | null) ?? null,
        createdAt: new Date().toISOString(),
      }
      procedures = [...procedures, procedure]
      return json({ data: procedure }) as T
    }

    if (rest === "documents" && method === "GET") return json({ data: documents }) as T

    const urlMatch = /^documents\/([^/]+)\/url$/.exec(rest)
    if (urlMatch && method === "GET") {
      return json({ data: { url: "https://placehold.co/600x400?text=Radiograf%C3%ADa" } }) as T
    }

    if (method === "GET" && rest === "") {
      return json({
        data: { patient: { displayName: "Lucía Quispe", patientNumber: 123 } },
      }) as T
    }
  }

  if (segments[1] === "services" && method === "GET") {
    const q = (query.get("q") ?? "").toLowerCase()
    const specialty = query.get("specialty")
    const rows = services.filter(
      (service) =>
        (!q ||
          service.name.toLowerCase().includes(q) ||
          (service.code ?? "").toLowerCase().includes(q)) &&
        (!specialty || service.specialty === specialty),
    )
    return json({ data: rows, nextCursor: null }) as T
  }

  // Perfil profesional propio: con él se firma la evaluación del odontograma.
  if (rawPath === "/api/clinical-forms/professionals/me/profile" && method === "GET") {
    return json({
      data: {
        userId: "demo-user",
        accountName: "Ana Torres",
        signatureName: "Ana Torres",
        professionalTitle: "Cirujano dentista",
        registrationBody: "COP",
        registrationNumber: "12345",
        specialtyRegistration: null,
        complete: true,
        updatedAt: null,
      },
    }) as T
  }

  if (segments[1] === "cie10" && method === "GET") {
    const q = (query.get("q") ?? "").toLowerCase()
    const rows = cie10.filter(
      (row) =>
        !q || row.code.toLowerCase().includes(q) || row.description.toLowerCase().includes(q),
    )
    return json({ data: rows }) as T
  }

  throw new ApiError(404, {
    code: "NOT_FOUND",
    message: `La maqueta no implementa ${method} ${rawPath}`,
  })
}

export async function apiUpload<T>(): Promise<T> {
  throw new ApiError(500, { message: "La maqueta no implementa subidas." })
}
