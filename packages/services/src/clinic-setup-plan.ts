/**
 * El plan de la configuración de una clínica nueva (`clinica.json`), que arma la
 * skill de carga con lo que la clínica envió y carga la administración en «Cargar
 * datos» (`clinic-setup.ts`). Es la otra mitad de la carga de pacientes
 * (`clinic-import-plan.ts`): la empresa, la marca y sus papeles, las sedes y sus
 * unidades, los servicios de la biblioteca con su precio, el inventario, la caja,
 * lo que responde el asistente, sus formatos propios y su equipo.
 *
 * Cada parte es opcional: un plan puede traer solo lo que llegó. Lo que necesita a
 * una persona del equipo (su perfil, su horario, su comisión) se carga cuando esa
 * persona ya es parte de la clínica; antes, el ensayo lo dice como «espera».
 *
 * Los archivos (logo y hoja membretada) van dentro del plan en base64, para que la
 * administración elija un solo archivo. El plan no lleva datos de pacientes.
 */
import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import { createHash } from "node:crypto"
import { z } from "zod"

/** Un archivo dentro del plan: su nombre, su tipo y su contenido en base64. */
const planFile = (types: readonly [string, ...string[]], maxBytes: number) =>
  z
    .strictObject({
      name: z.string().trim().min(1).max(200),
      mime: z.enum(types),
      base64: z.string().min(4),
    })
    .refine((file) => Math.floor((file.base64.length * 3) / 4) <= maxBytes, {
      message: `El archivo pesa más de ${Math.round(maxBytes / 1024 / 1024)} MB`,
      path: ["base64"],
    })

/** El logo: lo mismo que acepta «Logo» en Datos de la clínica. */
export const PLAN_LOGO_MAX_BYTES = 2 * 1024 * 1024
/** La hoja membretada, como imagen de la hoja entera (la skill la mejora y le quita el contacto). */
export const PLAN_LETTERHEAD_MAX_BYTES = 5 * 1024 * 1024

const text = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (max: number) => z.string().trim().max(max).nullish()
const cents = z.number().int().min(0).max(100_000_000)
const currency = z.string().trim().length(3).toUpperCase()
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora HH:MM, de 00:00 a 23:59")
const isoDate = z.iso.date({ error: "Fecha AAAA-MM-DD que exista en el calendario" })

const identitySchema = z.strictObject({
  /** El nombre que ven sus pacientes. */
  tradeName: text(200).optional(),
  legalName: text(200).optional(),
  fiscalDocType: optionalText(20),
  fiscalDocNumber: optionalText(20),
  fiscalAddress: optionalText(300),
  /** Teléfono de urgencias en E.164. */
  emergencyPhone: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, "El teléfono de urgencias con su código de país, empezando por «+»")
    .nullish(),
  /** La otra moneda en que cobra (dólares) y su cambio de hoy, en palabras del servicio («3.75»). */
  secondCurrency: currency.nullish(),
  exchangeRate: z.string().trim().max(40).nullish(),
})

const papersSchema = z.strictObject({
  receiptWidth: z.enum(["58", "80"]).optional(),
  sheetSize: z.enum(["A4", "Letter"]).optional(),
  ticketFooter: text(280).optional(),
  /** Días que vale un presupuesto (1 a 365). */
  budgetValidDays: z.number().int().min(1).max(365).optional(),
})

const brandSchema = z.strictObject({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "El color como #rrggbb").optional(),
  logo: planFile(["image/png", "image/jpeg", "image/webp"], PLAN_LOGO_MAX_BYTES).optional(),
})

const letterheadSchema = z.strictObject({
  /** La hoja entera como imagen (PNG o JPG), A4 o Carta. */
  file: planFile(["image/png", "image/jpeg"], PLAN_LETTERHEAD_MAX_BYTES),
  /** Si la hoja ya trae la dirección y el teléfono: entonces el papel no los repite. */
  hasContact: z.boolean().default(false),
})

const branchSchema = z.strictObject({
  /** Cómo la nombran los demás puntos del plan (horarios, gastos, inventario). */
  key: text(40),
  name: text(120),
  addressLine1: optionalText(300),
  district: optionalText(100),
  city: optionalText(100),
  region: optionalText(100),
  postalCode: optionalText(20),
  phone: optionalText(30),
  email: z.email().nullish(),
  /** Sus unidades dentales, consultorios o salas, por nombre. Sin decirlo, la que nace sola. */
  rooms: z.array(text(80)).max(40).default([]),
  /** Lo que dura la cita regular en esa sede, en minutos. */
  appointmentMinutes: z.number().int().min(5).max(480).optional(),
})

const serviceSchema = z
  .strictObject({
    /** La clave de la biblioteca (`seeds/biblioteca.csv`): de ahí sale su código oficial. */
    template: text(120).optional(),
    /** El nombre que verá la clínica; sin él, el de la biblioteca. Obligatorio en uno propio. */
    name: text(200).optional(),
    priceCents: cents,
    currency,
    /** «desde»: el precio es el mínimo; «exacto»; «evaluacion»: se da después de evaluar. */
    priceDisclosure: z.enum(["exacto", "desde", "evaluacion"]).optional(),
    durationMin: z.number().int().min(5).max(600).optional(),
    usualSessions: z.number().int().min(1).max(200).optional(),
    /** Solo en uno propio (excepción): su especialidad, dónde se hace y su código oficial del país. */
    specialty: text(120).optional(),
    scope: text(20).optional(),
    officialCode: text(40).optional(),
    /** Su código interno, si la clínica usa uno. */
    code: text(40).optional(),
  })
  .refine((service) => service.template || (service.name && service.specialty), {
    message: "Uno propio (sin biblioteca) lleva nombre y especialidad",
    path: ["name"],
  })

const paymentMethodSchema = z.strictObject({
  name: text(80),
  /** El tipo UN/CEFACT 4461: «10» efectivo, «48» tarjeta, «30» transferencia, «68» billetera (Yape, Plin), «20» cheque, «1» otro. */
  typeCode: z.enum(["10", "48", "30", "68", "20", "1"]).nullish(),
})

const supplierSchema = z.strictObject({
  name: text(200),
  docType: optionalText(20),
  docNumber: optionalText(50),
  email: optionalText(200),
  phone: optionalText(50),
  address: optionalText(500),
})

const productSchema = z.strictObject({
  name: text(200),
  /** Unidad de uso, en palabras («guante», «ml»). */
  unit: text(40).optional(),
  /** Lo que hay hoy y en qué sede; con lote y vencimiento si los controla. */
  onHand: z.number().min(0).max(1_000_000).optional(),
  branch: text(40).optional(),
  lotCode: optionalText(120),
  expiresAt: isoDate.nullish(),
  minQuantity: z.number().min(0).max(1_000_000).optional(),
})

const recurringExpenseSchema = z.strictObject({
  /** Cómo se reconoce al volver a cargar: no se anota dos veces. */
  key: text(60),
  branch: text(40).optional(),
  category: z.enum(["Personal", "Alquiler", "Laboratorio", "Materiales", "Servicios", "Impuestos", "Otros"]),
  concept: text(200),
  amountCents: cents,
  currency: currency.optional(),
  everyMonths: z.union([z.literal(1), z.literal(6), z.literal(12)]),
  day: z.number().int().min(1).max(31),
  firstMonth: z.string().regex(/^\d{4}-\d{2}$/, "El primer mes como AAAA-MM").nullish(),
  /** El sueldo de alguien del equipo, por su correo: se anota cuando ya es parte de la clínica. */
  person: z.email().optional(),
})

const knowledgeSchema = z.strictObject({
  /** Una de «Lo que solo tú sabes» (`KNOWLEDGE_BASICS`), o ninguna para una pregunta propia. */
  basicKey: text(40).optional(),
  /** La pregunta; en una de «Lo que solo tú sabes», la de siempre. */
  title: text(200).optional(),
  body: text(8000),
})

const consentSchema = z.strictObject({
  title: text(200),
  /** Las secciones, como las guarda «Consentimientos» (`saveConsentTemplate`). */
  sections: z.array(z.record(z.string(), z.unknown())).min(1).max(50),
})

const formSchema = z.strictObject({
  title: text(200),
  description: optionalText(1000),
  respondent: z.string().trim().max(20).optional(),
  /** Las secciones con sus campos, como las guarda «Formularios» (`createFormTemplate`). */
  schema: z.record(z.string(), z.unknown()),
})

const ruleSchema = z.strictObject({
  branch: text(40),
  /** 0 domingo, 1 lunes … 6 sábado: como lo guarda Horarios. */
  weekday: z.number().int().min(0).max(6),
  start: hhmm,
  end: hhmm,
})

const absenceSchema = z.strictObject({
  branch: text(40),
  from: isoDate,
  to: isoDate,
  reason: optionalText(200),
})

const teamMemberSchema = z.strictObject({
  email: z.email(),
  name: text(120).optional(),
  /** Su rol en la clínica; la propietaria ya está invitada y no se vuelve a invitar. */
  role: z.enum(["owner", "admin", "reception", "clinician", "cashier", "sales", "workshop", "member"]),
  profile: z
    .strictObject({
      professionalTitle: text(120),
      registrationBody: text(40),
      registrationNumber: optionalText(40),
      specialtyRegistration: optionalText(80),
    })
    .optional(),
  /** Las especialidades de la clínica que atiende, por nombre. */
  specialties: z.array(text(120)).max(20).default([]),
  schedule: z.array(ruleSchema).max(42).default([]),
  absences: z.array(absenceSchema).max(50).default([]),
  /** Su comisión general, en puntos básicos (2500 = 25 %). */
  commissionBps: z.number().int().min(0).max(10_000).optional(),
})

export const clinicSetupPlanSchema = z
  .strictObject({
    kind: z.literal("clinica"),
    version: z.literal(1),
    product: z.enum(CLINICAL_PRODUCTS),
    /** El país de la clínica (ISO 3166-1): decide la lista de códigos de sus servicios. */
    countryCode: z.string().trim().length(2).toUpperCase(),
    /** La clínica, como la nombra quien prepara la carga: para no cargar el plan de otra. */
    clinic: text(200),
    identity: identitySchema.optional(),
    papers: papersSchema.optional(),
    brand: brandSchema.optional(),
    letterhead: letterheadSchema.optional(),
    branches: z.array(branchSchema).max(20).default([]),
    services: z.array(serviceSchema).max(500).default([]),
    paymentMethods: z.array(paymentMethodSchema).max(30).default([]),
    suppliers: z.array(supplierSchema).max(300).default([]),
    products: z.array(productSchema).max(2000).default([]),
    recurringExpenses: z.array(recurringExpenseSchema).max(100).default([]),
    knowledge: z.array(knowledgeSchema).max(60).default([]),
    consents: z.array(consentSchema).max(40).default([]),
    forms: z.array(formSchema).max(40).default([]),
    team: z.array(teamMemberSchema).max(100).default([]),
  })
  .superRefine((plan, ctx) => {
    const branches = new Set(plan.branches.map((b) => b.key))
    if (branches.size !== plan.branches.length)
      ctx.addIssue({ code: "custom", path: ["branches"], message: "Dos sedes con la misma clave" })
    const known = (key: string | undefined, path: (string | number)[]) => {
      if (key && !branches.has(key)) ctx.addIssue({ code: "custom", path, message: `La sede «${key}» no está en el plan` })
    }
    plan.products.forEach((p, i) => known(p.branch, ["products", i, "branch"]))
    plan.recurringExpenses.forEach((e, i) => known(e.branch, ["recurringExpenses", i, "branch"]))
    plan.team.forEach((m, i) => {
      m.schedule.forEach((r, j) => known(r.branch, ["team", i, "schedule", j, "branch"]))
      m.absences.forEach((a, j) => known(a.branch, ["team", i, "absences", j, "branch"]))
    })
    const emails = plan.team.map((m) => m.email.toLowerCase())
    if (new Set(emails).size !== emails.length)
      ctx.addIssue({ code: "custom", path: ["team"], message: "Una persona del equipo está dos veces" })
    const keys = plan.recurringExpenses.map((e) => e.key)
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", path: ["recurringExpenses"], message: "Dos gastos con la misma clave" })
  })

export type ClinicSetupPlan = z.output<typeof clinicSetupPlanSchema>
export type ClinicSetupPlanInput = z.input<typeof clinicSetupPlanSchema>

/** La huella del plan: la que queda en la auditoría de cada carga. */
export function clinicSetupPlanSha256(plan: ClinicSetupPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex")
}

/** Los bytes de un archivo del plan. */
export function planFileBytes(file: { base64: string }): Uint8Array {
  return new Uint8Array(Buffer.from(file.base64, "base64"))
}
