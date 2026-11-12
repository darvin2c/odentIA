/**
 * Cargar la configuración de una clínica nueva desde la administración (ADR 0104):
 * el ensayo y la carga del plan que preparó la skill de carga (`clinic-setup-plan.ts`).
 * Cada cosa se escribe con la operación de siempre de su pantalla (`saveOrgProfile`,
 * `createBranch`, `createService`, `createPaymentMethod`, `noteRecurringExpense`…), con
 * sus validaciones y su auditoría, a nombre del personal que carga.
 *
 * El ensayo es la misma carga dentro de una transacción que no se guarda (la ruta la
 * deshace): lo que dice es lo que haría. Cada cosa va en su punto de guardado: si una
 * falla, se dice y las demás siguen. Volver a cargar el mismo plan no duplica nada: lo
 * que ya está se reconoce por su nombre, su clave o su documento.
 *
 * Lo que necesita a una persona del equipo (su perfil, su horario, su comisión, su
 * sueldo) espera a que esa persona sea parte de la clínica. Las invitaciones del equipo
 * se crean aquí y el correo lo envía la ruta después de guardar. Nada de esto escribe a
 * pacientes.
 */
import type { ClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { agentKnowledgeEntry } from "@odentia/db/schema/agent"
import { scheduleRoom } from "@odentia/db/schema/agenda"
import { orgSpecialty, serviceCatalog, treatmentTemplate } from "@odentia/db/schema/clinical"
import { clinicalFormTemplate, consentTemplate } from "@odentia/db/schema/clinical-forms"
import { expenseRecurring } from "@odentia/db/schema/finance"
import { product as productTable, supplier } from "@odentia/db/schema/inventory"
import { invitation, member, organization, user } from "@odentia/db/schema/auth"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { organizationPaymentMethod } from "@odentia/db/schema/org-payments"
import { and, eq } from "drizzle-orm"
import { createHash, randomUUID } from "node:crypto"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { createRoom, setBranchDefaultDuration } from "./appointments.js"
import { createScheduleBlock, setProfessionalSchedule } from "./availability.js"
import { createBranch, updateBranch } from "./branches.js"
import { setClinicBrandColor, setClinicLogo } from "./clinic-identity.js"
import { type ClinicSetupPlan, clinicSetupPlanSha256 } from "./clinic-setup-plan.js"
import { createFormTemplate, publishFormTemplate, saveConsentTemplate, setProfessionalSpecialties } from "./clinical-forms.js"
import { ServiceError, validation } from "./errors.js"
import { noteRecurringExpense } from "./expense-recurring.js"
import { setCommissionRate } from "./finance.js"
import { addStock, createProduct, createSupplier } from "./inventory.js"
import { createKnowledgeEntry, KNOWLEDGE_BASICS, setKnowledgeStatus } from "./knowledge.js"
import { getCurrentLetterhead, type LetterheadInput, saveLetterhead } from "./letterhead.js"
import { saveOrgProfile } from "./org-profile-save.js"
import { createPaymentMethod } from "./payment-methods.js"
import { setProfessionalProfile } from "./professional-profiles.js"
import { createService, updateService } from "./service-catalog.js"

export const CLINIC_SETUP_AREAS = [
  "Empresa",
  "Marca",
  "Papeles",
  "Sedes",
  "Servicios",
  "Caja",
  "Inventario",
  "Asistente",
  "Formatos propios",
  "Equipo",
  "Profesionales",
] as const
export type ClinicSetupArea = (typeof CLINIC_SETUP_AREAS)[number]

/**
 * Qué pasa con cada cosa: `nueva` (se crea), `cambia` (ya estaba y se actualiza),
 * `igual` (ya estaba así), `espera` (necesita que esa persona sea parte de la clínica) o
 * `error` (no se carga, con su motivo).
 */
export type ClinicSetupStatus = "nueva" | "cambia" | "igual" | "espera" | "error"

export interface ClinicSetupItem {
  area: ClinicSetupArea
  label: string
  status: ClinicSetupStatus
  detail?: string
}

/** Lo que la ruta ya subió al almacenamiento: el logo y la hoja, listos para guardar. */
export interface ClinicSetupFiles {
  logoUrl?: string
  letterhead?: LetterheadInput
}

export interface ClinicSetupResult {
  planSha256: string
  items: ClinicSetupItem[]
  totals: Record<ClinicSetupStatus, number>
  /** Las invitaciones creadas en esta carga: la ruta envía su correo después de guardar. */
  invitations: Array<{ id: string; email: string; role: string }>
  /** Lo que hay que subir antes de cargar (el ensayo lo dice; la carga lo espera listo). */
  needs: { logo: boolean; letterhead: boolean }
}

function requireSetupAdmin(actor: AdminActor | null): AdminActor {
  if (!actor) throw new ServiceError("FORBIDDEN", 403, "Se requiere personal de administración")
  if (actor.role !== "admin") throw new ServiceError("FORBIDDEN", 403, "Solo un administrador carga datos de una clínica")
  return actor
}

/** Sin tildes ni mayúsculas ni espacios de más: así se reconoce lo que ya está. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim()
}

/** Un UUID que sale siempre igual de la clínica y la clave: la carga repetida es el mismo pedido. */
function stableUuid(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("|")).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/**
 * Ensaya o carga el plan en la clínica. En el ensayo (`files` sin subir), la ruta deshace
 * la transacción al terminar; en la carga, la guarda.
 */
export async function runClinicSetup(
  tx: Db,
  orgId: string,
  actor: AdminActor | null,
  plan: ClinicSetupPlan,
  files: ClinicSetupFiles = {},
  mode: "ensayo" | "carga" = "ensayo",
): Promise<ClinicSetupResult> {
  const staff = requireSetupAdmin(actor)
  const by = staff.userId
  const [profile] = await tx
    .select({ product: orgProfile.product, country: orgProfile.countryCode, tradeName: orgProfile.tradeName })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  const [org] = await tx.select({ name: organization.name, logo: organization.logo }).from(organization).where(eq(organization.id, orgId)).limit(1)
  if (!org) throw new ServiceError("NOT_FOUND", 404, "Clínica no encontrada")
  const product: ClinicalProduct = (profile?.product as ClinicalProduct | undefined) ?? plan.product
  if (product !== plan.product) throw validation("El plan es de otro producto que la clínica: prepáralo con el de la clínica")
  if (profile && profile.country !== plan.countryCode)
    throw validation(`El plan es para ${plan.countryCode} y la clínica es de ${profile.country}: prepáralo con el país de la clínica`)

  const items: ClinicSetupItem[] = []
  const invitations: ClinicSetupResult["invitations"] = []
  const needs = { logo: false, letterhead: false }

  /** Cada cosa en su punto de guardado: si falla, se dice y las demás siguen. */
  const step = async (area: ClinicSetupArea, label: string, run: (sp: Db) => Promise<ClinicSetupStatus | { status: ClinicSetupStatus; detail?: string }>) => {
    try {
      const outcome = await tx.transaction(run)
      items.push(typeof outcome === "string" ? { area, label, status: outcome } : { area, label, ...outcome })
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error
      const fields = error.fields ? Object.values(error.fields).filter(Boolean) : []
      items.push({ area, label, status: "error", detail: fields[0] ?? error.message })
    }
  }

  // --- Empresa y papeles: «Datos de la clínica» (enciende la clínica si aún no tiene sede) ---
  if (plan.identity || plan.papers) {
    const { secondCurrency, exchangeRate, ...identity } = plan.identity ?? {}
    await step("Empresa", "Datos de la clínica", async (sp) => {
      await saveOrgProfile(
        sp,
        orgId,
        by,
        { ...identity, ...(secondCurrency !== undefined ? { secondCurrency, exchangeRate } : {}), ...(plan.papers ?? {}) },
        product,
      )
      return profile ? "cambia" : "nueva"
    })
  }

  // --- Marca ---
  if (plan.brand?.color) {
    const color = plan.brand.color
    await step("Marca", `Color ${color}`, async (sp) => {
      await setClinicBrandColor(sp, orgId, by, color)
      return "cambia"
    })
  }
  if (plan.brand?.logo) {
    needs.logo = true
    await step("Marca", `Logo (${plan.brand.logo.name})`, async (sp) => {
      if (!files.logoUrl) return { status: org.logo ? "cambia" : "nueva", detail: "Se sube al cargar" }
      await setClinicLogo(sp, orgId, by, files.logoUrl)
      return org.logo ? "cambia" : "nueva"
    })
  }
  if (plan.letterhead) {
    const sheet = plan.letterhead
    const current = await getCurrentLetterhead(tx, orgId)
    if (current?.fileName === sheet.file.name) items.push({ area: "Papeles", label: `Hoja membretada (${sheet.file.name})`, status: "igual" })
    else {
      needs.letterhead = true
      await step("Papeles", `Hoja membretada (${sheet.file.name})`, async (sp) => {
        if (!files.letterhead) return { status: current ? "cambia" : "nueva", detail: "Se mide y se sube al cargar" }
        await saveLetterhead(sp, orgId, by, files.letterhead, current?.id ?? null)
        return current ? "cambia" : "nueva"
      })
    }
  }

  // --- Sedes y sus unidades ---
  const branchIdOf = new Map<string, string>()
  const existingBranches = await tx.select({ id: branch.id, name: branch.name }).from(branch).where(eq(branch.organizationId, orgId))
  for (const wanted of plan.branches) {
    // La sede que la clínica ya creó en su alta: si tiene una sola y el plan trae una sola, es esa.
    const same =
      existingBranches.find((b) => fold(b.name) === fold(wanted.name)) ??
      (existingBranches.length === 1 && plan.branches.length === 1 ? existingBranches[0] : undefined)
    const address = {
      name: wanted.name,
      addressLine1: wanted.addressLine1,
      district: wanted.district,
      city: wanted.city,
      region: wanted.region,
      postalCode: wanted.postalCode,
      phone: wanted.phone,
      email: wanted.email,
    }
    await step("Sedes", wanted.name, async (sp) => {
      if (same) {
        await updateBranch(sp, orgId, by, same.id, address)
        branchIdOf.set(wanted.key, same.id)
        return "cambia"
      }
      const created = await createBranch(sp, orgId, by, address)
      branchIdOf.set(wanted.key, created.id)
      return "nueva"
    })
    const branchId = branchIdOf.get(wanted.key)
    if (!branchId) continue
    const rooms = await tx.select({ name: scheduleRoom.name }).from(scheduleRoom).where(and(eq(scheduleRoom.organizationId, orgId), eq(scheduleRoom.branchId, branchId)))
    for (const room of wanted.rooms) {
      if (rooms.some((r) => fold(r.name) === fold(room))) {
        items.push({ area: "Sedes", label: `${wanted.name} · ${room}`, status: "igual" })
        continue
      }
      await step("Sedes", `${wanted.name} · ${room}`, async (sp) => {
        await createRoom(sp, orgId, { branchId, name: room })
        return "nueva"
      })
    }
    if (wanted.appointmentMinutes) {
      const minutesWanted = wanted.appointmentMinutes
      await step("Sedes", `${wanted.name} · cita de ${minutesWanted} minutos`, async (sp) => {
        await setBranchDefaultDuration(sp, orgId, by, { branchId, minutes: minutesWanted })
        return "cambia"
      })
    }
  }
  const anyBranchId = branchIdOf.values().next().value as string | undefined
  const branchFor = (key: string | undefined) => (key ? branchIdOf.get(key) : anyBranchId)

  // --- Servicios: de la biblioteca, con su código; los propios, como excepción ---
  const templates = await tx
    .select({ id: treatmentTemplate.id, key: treatmentTemplate.key, name: treatmentTemplate.name })
    .from(treatmentTemplate)
    .where(eq(treatmentTemplate.product, product))
  const templateOf = new Map(templates.map((t) => [t.key, t]))
  const specialties = await tx.select({ id: orgSpecialty.id, name: orgSpecialty.name }).from(orgSpecialty).where(eq(orgSpecialty.organizationId, orgId))
  const services = await tx
    .select({ id: serviceCatalog.id, name: serviceCatalog.name, priceCents: serviceCatalog.priceCents, currency: serviceCatalog.currency })
    .from(serviceCatalog)
    .where(eq(serviceCatalog.organizationId, orgId))
  for (const wanted of plan.services) {
    const template = wanted.template ? templateOf.get(wanted.template) : undefined
    const name = wanted.name ?? template?.name ?? wanted.template ?? "Servicio"
    const price = `${wanted.currency} ${(wanted.priceCents / 100).toFixed(2)}${wanted.priceDisclosure === "desde" ? " (desde)" : ""}`
    await step("Servicios", `${name} · ${price}`, async (sp) => {
      if (wanted.template && !template) return { status: "error", detail: `«${wanted.template}» no está en la biblioteca de este producto` }
      const same = services.find((s) => fold(s.name) === fold(name))
      if (same) {
        if (same.priceCents === wanted.priceCents && same.currency === wanted.currency) return "igual"
        await updateService(sp, orgId, by, same.id, {
          priceCents: wanted.priceCents,
          currency: wanted.currency,
          ...(wanted.priceDisclosure ? { priceDisclosure: wanted.priceDisclosure } : {}),
        })
        return "cambia"
      }
      const specialtyId = wanted.specialty ? specialties.find((s) => fold(s.name) === fold(wanted.specialty!))?.id : undefined
      if (wanted.specialty && !specialtyId) return { status: "error", detail: `La especialidad «${wanted.specialty}» no está en la clínica` }
      await createService(sp, orgId, by, {
        templateId: template?.id ?? null,
        name,
        priceCents: wanted.priceCents,
        currency: wanted.currency,
        priceDisclosure: wanted.priceDisclosure ?? null,
        durationMin: wanted.durationMin ?? null,
        usualSessions: wanted.usualSessions ?? null,
        specialtyId: specialtyId ?? null,
        ...(template ? {} : { scope: wanted.scope ?? "general" }),
        code: wanted.code ?? null,
        ...(wanted.officialCode ? { officialCode: wanted.officialCode } : {}),
      })
      return template ? "nueva" : { status: "nueva", detail: "Servicio propio (excepción)" }
    })
  }

  // --- Caja: medios de pago y gastos que se repiten ---
  const methods = await tx.select({ name: organizationPaymentMethod.name }).from(organizationPaymentMethod).where(eq(organizationPaymentMethod.organizationId, orgId))
  for (const wanted of plan.paymentMethods) {
    if (methods.some((m) => fold(m.name) === fold(wanted.name))) {
      items.push({ area: "Caja", label: `Medio de pago: ${wanted.name}`, status: "igual" })
      continue
    }
    await step("Caja", `Medio de pago: ${wanted.name}`, async (sp) => {
      await createPaymentMethod(sp, orgId, by, { name: wanted.name, typeCode: wanted.typeCode ?? null, atEnd: true })
      return "nueva"
    })
  }

  // Quién del plan ya es parte de la clínica: lo suyo se carga; lo de los demás, espera.
  const members = await tx
    .select({ userId: member.userId, email: user.email, role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, orgId))
  const memberOf = (email: string) => members.find((m) => m.email.toLowerCase() === email.toLowerCase())

  for (const expense of plan.recurringExpenses) {
    const label = `Gasto fijo: ${expense.concept} · ${expense.currency ?? ""} ${(expense.amountCents / 100).toFixed(2)}`.replace("·  ", "· ")
    const person = expense.person ? memberOf(expense.person) : undefined
    if (expense.person && !person) {
      items.push({ area: "Caja", label, status: "espera", detail: `Espera a que ${expense.person} sea parte de la clínica` })
      continue
    }
    const branchId = branchFor(expense.branch)
    const requestId = stableUuid(orgId, "gasto", expense.key)
    const [noted] = await tx
      .select({ id: expenseRecurring.id })
      .from(expenseRecurring)
      .where(and(eq(expenseRecurring.organizationId, orgId), eq(expenseRecurring.requestId, requestId)))
      .limit(1)
    if (noted) {
      items.push({ area: "Caja", label, status: "igual" })
      continue
    }
    await step("Caja", label, async (sp) => {
      if (!branchId) return { status: "error", detail: "Necesita una sede" }
      await noteRecurringExpense(
        sp,
        orgId,
        by,
        {
          branchId,
          category: expense.category,
          concept: expense.concept,
          amountCents: expense.amountCents,
          ...(expense.currency ? { currency: expense.currency } : {}),
          everyMonths: expense.everyMonths,
          day: expense.day,
          firstMonth: expense.firstMonth ?? null,
          memberUserId: person?.userId ?? null,
          requestId,
        },
        { seesPeople: true },
      )
      return "nueva"
    })
  }

  // --- Inventario y proveedores ---
  const suppliers = await tx.select({ name: supplier.name, docNumber: supplier.docNumber }).from(supplier).where(eq(supplier.organizationId, orgId))
  for (const wanted of plan.suppliers) {
    const same = suppliers.find((s) => (wanted.docNumber && s.docNumber === wanted.docNumber) || fold(s.name) === fold(wanted.name))
    if (same) {
      items.push({ area: "Inventario", label: `Proveedor: ${wanted.name}`, status: "igual" })
      continue
    }
    await step("Inventario", `Proveedor: ${wanted.name}`, async (sp) => {
      await createSupplier(sp, orgId, by, wanted)
      return "nueva"
    })
  }
  const products = await tx.select({ name: productTable.name }).from(productTable).where(eq(productTable.organizationId, orgId))
  for (const wanted of plan.products) {
    if (products.some((p) => fold(p.name) === fold(wanted.name))) {
      items.push({ area: "Inventario", label: wanted.name, status: "igual" })
      continue
    }
    const branchId = branchFor(wanted.branch)
    await step("Inventario", wanted.name, async (sp) => {
      const created = await createProduct(sp, orgId, by, {
        name: wanted.name,
        ...(wanted.unit ? { unit: wanted.unit } : {}),
        ...(wanted.minQuantity !== undefined ? { minQuantity: wanted.minQuantity } : {}),
        idempotencyKey: `carga-${fold(wanted.name)}`,
      })
      if (wanted.onHand && branchId)
        await addStock(sp, orgId, by, {
          productId: created.id,
          branchId,
          quantity: wanted.onHand,
          lotCode: wanted.lotCode ?? null,
          expiresAt: wanted.expiresAt ?? null,
          reason: "otro",
          note: "Carga inicial",
          idempotencyKey: `carga-${fold(wanted.name)}`,
        })
      return "nueva"
    })
  }

  // --- Asistente: «Lo que solo tú sabes», publicado ---
  const entries = await tx
    .select({ title: agentKnowledgeEntry.title, basicKey: agentKnowledgeEntry.basicKey })
    .from(agentKnowledgeEntry)
    .where(eq(agentKnowledgeEntry.organizationId, orgId))
  for (const wanted of plan.knowledge) {
    const basic = wanted.basicKey ? KNOWLEDGE_BASICS.find((b) => b.key === wanted.basicKey) : undefined
    const title = wanted.title ?? basic?.question
    const label = basic?.label ?? title ?? "Pregunta"
    if (!title) {
      items.push({ area: "Asistente", label, status: "error", detail: "Falta la pregunta" })
      continue
    }
    if (entries.some((e) => (basic && e.basicKey === basic.key) || fold(e.title) === fold(title))) {
      items.push({ area: "Asistente", label, status: "igual" })
      continue
    }
    await step("Asistente", label, async (sp) => {
      const entry = await createKnowledgeEntry(sp, orgId, by, { kind: "faq", title, body: wanted.body, basicKey: basic?.key ?? null })
      await setKnowledgeStatus(sp, orgId, by, entry.id, "publicada")
      return "nueva"
    })
  }

  // --- Formatos propios: consentimientos y formularios ---
  const consents = await tx.select({ title: consentTemplate.title }).from(consentTemplate).where(eq(consentTemplate.organizationId, orgId))
  for (const wanted of plan.consents) {
    if (consents.some((c) => fold(c.title) === fold(wanted.title))) {
      items.push({ area: "Formatos propios", label: `Consentimiento: ${wanted.title}`, status: "igual" })
      continue
    }
    await step("Formatos propios", `Consentimiento: ${wanted.title}`, async (sp) => {
      await saveConsentTemplate(sp, orgId, by, { title: wanted.title, sections: wanted.sections })
      return "nueva"
    })
  }
  const forms = await tx.select({ title: clinicalFormTemplate.title }).from(clinicalFormTemplate).where(eq(clinicalFormTemplate.organizationId, orgId))
  for (const wanted of plan.forms) {
    if (forms.some((f) => fold(f.title) === fold(wanted.title))) {
      items.push({ area: "Formatos propios", label: `Formulario: ${wanted.title}`, status: "igual" })
      continue
    }
    await step("Formatos propios", `Formulario: ${wanted.title}`, async (sp) => {
      const created = await createFormTemplate(sp, orgId, by, {
        title: wanted.title,
        description: wanted.description ?? null,
        schema: wanted.schema,
        ...(wanted.respondent ? { respondent: wanted.respondent as "staff" | "portal" } : {}),
      })
      await publishFormTemplate(sp, orgId, by, created.id)
      return "nueva"
    })
  }

  // --- Equipo: invitar a quien todavía no es parte; lo de cada profesional, cuando ya lo es ---
  const pending = await tx
    .select({ email: invitation.email })
    .from(invitation)
    .where(and(eq(invitation.organizationId, orgId), eq(invitation.status, "pending")))
  for (const person of plan.team) {
    const label = person.name ? `${person.name} (${person.email})` : person.email
    const joined = memberOf(person.email)
    if (!joined) {
      if (pending.some((p) => p.email.toLowerCase() === person.email.toLowerCase()))
        items.push({ area: "Equipo", label, status: "igual", detail: "Ya tiene su invitación" })
      else if (person.role === "owner")
        items.push({ area: "Equipo", label, status: "espera", detail: "La propietaria se invita en el alta; su invitación no está pendiente" })
      else
        await step("Equipo", label, async (sp) => {
          const id = randomUUID()
          await sp.insert(invitation).values({
            id,
            organizationId: orgId,
            email: person.email.toLowerCase(),
            role: person.role,
            status: "pending",
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            inviterId: by,
          })
          invitations.push({ id, email: person.email.toLowerCase(), role: person.role })
          return { status: "nueva", detail: "Le llega un correo con su invitación" }
        })
      const waits = [
        person.profile ? "su perfil profesional" : null,
        person.specialties.length ? "sus especialidades" : null,
        person.schedule.length ? "su horario" : null,
        person.absences.length ? "sus ausencias" : null,
        person.commissionBps !== undefined ? "su comisión" : null,
      ].filter(Boolean)
      if (waits.length)
        items.push({ area: "Profesionales", label, status: "espera", detail: `Espera a que entre: ${waits.join(", ")}` })
      continue
    }
    items.push({ area: "Equipo", label, status: "igual", detail: "Ya es parte de la clínica" })
    const userId = joined.userId
    if (person.profile) {
      const profileInput = person.profile
      await step("Profesionales", `${label} · perfil profesional`, async (sp) => {
        await setProfessionalProfile(sp, orgId, by, userId, profileInput)
        return "cambia"
      })
    }
    if (person.specialties.length) {
      const ids = person.specialties.map((name) => specialties.find((s) => fold(s.name) === fold(name))?.id)
      await step("Profesionales", `${label} · especialidades`, async (sp) => {
        if (ids.some((id) => !id)) return { status: "error", detail: "Una especialidad no está en la clínica" }
        await setProfessionalSpecialties(sp, orgId, by, userId, ids as string[])
        return "cambia"
      })
    }
    const byBranch = new Map<string, { weekday: number; startMin: number; endMin: number }[]>()
    for (const rule of person.schedule) {
      const branchId = branchFor(rule.branch)
      if (!branchId) continue
      byBranch.set(branchId, [...(byBranch.get(branchId) ?? []), { weekday: rule.weekday, startMin: minutes(rule.start), endMin: minutes(rule.end) }])
    }
    for (const [branchId, rules] of byBranch)
      await step("Profesionales", `${label} · horario (${rules.length} turnos)`, async (sp) => {
        await setProfessionalSchedule(sp, orgId, by, { branchId, professionalUserId: userId, rules })
        return "cambia"
      })
    for (const absence of person.absences) {
      const branchId = branchFor(absence.branch)
      await step("Profesionales", `${label} · ausencia ${absence.from} a ${absence.to}`, async (sp) => {
        if (!branchId) return { status: "error", detail: "Necesita una sede" }
        await createScheduleBlock(sp, orgId, by, {
          branchId,
          professionalUserId: userId,
          kind: "ausencia",
          ...(absence.reason ? { reason: absence.reason } : {}),
          startsAt: `${absence.from}T00:00:00`,
          endsAt: `${absence.to}T23:59:00`,
        })
        return "nueva"
      })
    }
    if (person.commissionBps !== undefined) {
      const rateBps = person.commissionBps
      await step("Profesionales", `${label} · comisión ${rateBps / 100} %`, async (sp) => {
        await setCommissionRate(sp, orgId, by, { professionalUserId: userId, rateBps })
        return "cambia"
      })
    }
  }

  const totals = { nueva: 0, cambia: 0, igual: 0, espera: 0, error: 0 } satisfies Record<ClinicSetupStatus, number>
  for (const item of items) totals[item.status]++
  const planSha256 = clinicSetupPlanSha256(plan)
  if (mode === "carga")
    await writeAdminAudit(tx, staff, {
      action: "org.setup_import",
      organizationId: orgId,
      metadata: { planSha256, ...totals, invitations: invitations.length },
    })
  return { planSha256, items, totals, invitations, needs }
}

/** Para que un ensayo no se guarde: la ruta lo lanza dentro de la transacción y lo atrapa afuera. */
export class ClinicSetupRehearsal extends Error {
  constructor(readonly result: ClinicSetupResult) {
    super("Ensayo")
  }
}
