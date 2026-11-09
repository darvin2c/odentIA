import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { automationRule } from "@odentia/db/schema/automation"
import { agentConfig } from "@odentia/db/schema/crm"
import { auditEvent, orgProfile, patientRegistrationConfig } from "@odentia/db/schema/org"
import { portalPolicy } from "@odentia/db/schema/portal-access"
import { reportDigest } from "@odentia/db/schema/reports"
import { saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { ADMIN_LINES } from "./admin-lines.js"
import { upsertAgentConfig } from "./agentConfig.js"
import { setLine } from "./automation.js"
import { refreshSuggestedNotice, SUGGESTED_NOTICE_ACTION, setUpNewClinic, suggestedPrivacyNotice } from "./new-clinic.js"
import { getPatientRegistrationConfig, registrationNoticeSuggested, savePatientRegistrationConfig } from "./patient-registration.js"
import { chooseSaasPlan, createSaasPlan } from "./saas-billing.js"
import { privacyNoticeOf } from "./privacy-notice.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

// El plan de lista de odentIA, con su cuota: de ahí sale el presupuesto del mes.
beforeAll(async () => {
  await ownerDb.insert(user).values({ id: "nueva-admin", name: "Administración", email: "admin@nueva.test" }).onConflictDoNothing()
  await ownerDb.update(saasPlan).set({ isDefault: false })
  await createSaasPlan(ownerDb, "nueva-admin", {
    code: "nueva-lista",
    name: "Plan odentIA",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 4_000_000,
    trialCreditCents: 5000,
    trialMaxCreditCents: 13000,
    isDefault: true,
  })
})

async function newClinic(product: "dental" | "medical" | "optical" = "dental") {
  const orgId = randomUUID()
  const ownerId = `owner-${orgId}`
  await insertOrg(ownerDb, orgId, `nueva-${orgId}`)
  await ownerDb
    .update(orgProfile)
    .set({ legalName: "Sonríe S.A.C.", tradeName: "Clínica Sonríe", fiscalDocNumber: "20123456789", product })
    .where(eq(orgProfile.organizationId, orgId))
  await ownerDb.insert(user).values({ id: ownerId, name: "Dueña", email: `${ownerId}@nueva.test`, emailVerified: true })
  await ownerDb.insert(member).values({ id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() })
  const run = <T,>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  return { orgId, ownerId, run }
}

describe("una clínica nueva nace con todo encendido (ADR 0141)", () => {
  it("una óptica de vistIA nace con Sofi y Argos, y Clío apagado: en una óptica no dicta (ADR 0166)", async () => {
    const c = await newClinic("optical")
    await c.run((tx) => setUpNewClinic(tx, c.orgId, c.ownerId))
    const [agent] = await ownerDb.select().from(agentConfig).where(eq(agentConfig.organizationId, c.orgId))
    expect(agent).toMatchObject({ enabled: true, clinicalAssistantEnabled: false, advisor: { enabled: true } })
    // Tampoco se enciende después: Clío no dicta en una óptica.
    await expect(
      c.run((tx) => upsertAgentConfig(tx, c.orgId, { clinicalAssistantEnabled: true }, { actorUserId: c.ownerId })),
    ).rejects.toMatchObject({ status: 400, fields: { clinicalAssistantEnabled: expect.any(String) } })
  })

  it("Sofi, Clío, Argos y sus líneas, el registro, el portal y el resumen del lunes, a nombre de quien la crea", async () => {
    const c = await newClinic()
    await c.run((tx) => setUpNewClinic(tx, c.orgId, c.ownerId))

    const rules = await ownerDb.select().from(automationRule).where(eq(automationRule.organizationId, c.orgId))
    expect(rules.map((rule) => rule.kind).sort()).toEqual(ADMIN_LINES.map((line) => line.key).sort())
    expect(rules.every((rule) => rule.enabled && rule.enabledBy === c.ownerId)).toBe(true)

    const [agent] = await ownerDb.select().from(agentConfig).where(eq(agentConfig.organizationId, c.orgId))
    expect(agent).toMatchObject({ enabled: true, clinicalAssistantEnabled: true, advisor: { enabled: true } })

    const [registration] = await ownerDb
      .select()
      .from(patientRegistrationConfig)
      .where(eq(patientRegistrationConfig.organizationId, c.orgId))
    expect(registration?.enabled).toBe(true)
    expect(registration?.privacyNotice).toBe(
      suggestedPrivacyNotice({
        legalName: "Sonríe S.A.C.",
        tradeName: "Clínica Sonríe",
        fiscalDocNumber: "20123456789",
        fiscalAddress: null,
        countryCode: "PE",
        productName: "odentIA",
      }),
    )
    expect(registration?.privacyNotice).toContain("Clínica Sonríe (Sonríe S.A.C., 20123456789) usará tus datos")
    expect(registration?.privacyNotice).toContain("Ley 29733")
    // Dice «Sugerido, sin revisar» hasta que alguien de la clínica lo cambie o diga que lo revisó.
    expect(registration?.noticeSuggestedAt).not.toBeNull()

    const [portal] = await ownerDb.select().from(portalPolicy).where(eq(portalPolicy.organizationId, c.orgId))
    expect(portal).toMatchObject({ portalEnabled: true, allowedScope: { appointments: true, budgets: true, account: true, documents: true } })

    const digests = await ownerDb.select().from(reportDigest).where(eq(reportDigest.organizationId, c.orgId))
    expect(digests.map((row) => [row.userId, row.enabled])).toEqual([[c.ownerId, true]])

    // El presupuesto del mes nace con la cuota del plan de lista (en la prueba aún no eligió uno).
    const [sub] = await ownerDb.select({ cap: saasSubscription.spendCapCents }).from(saasSubscription).where(eq(saasSubscription.organizationId, c.orgId))
    expect(sub?.cap).toBe(2900)

    // Cada cosa encendida queda en Actividad del equipo, a su nombre.
    const trail = await ownerDb
      .select({ action: auditEvent.action, actor: auditEvent.actorUserId })
      .from(auditEvent)
      .where(eq(auditEvent.organizationId, c.orgId))
    const actions = trail.map((row) => row.action)
    expect(actions.filter((action) => action === "admin_line.default_on")).toHaveLength(ADMIN_LINES.length)
    expect(actions).toEqual(expect.arrayContaining([SUGGESTED_NOTICE_ACTION, "portal.default_on", "report_digest.default_on"]))
    expect(trail.every((row) => row.actor === c.ownerId)).toBe(true)
  })

  it("repetirlo no cambia lo que alguien ya decidió", async () => {
    const c = await newClinic()
    await c.run((tx) => setUpNewClinic(tx, c.orgId, c.ownerId))
    // La dueña apaga una línea y a Sofi antes de crear la sede.
    await c.run((tx) => setLine(tx, c.orgId, c.ownerId, "recordatorio_cita", { enabled: false }))
    await c.run((tx) => upsertAgentConfig(tx, c.orgId, { enabled: false }, { actorUserId: c.ownerId }))
    const before = await ownerDb.select({ id: auditEvent.id }).from(auditEvent).where(eq(auditEvent.organizationId, c.orgId))

    await c.run((tx) => setUpNewClinic(tx, c.orgId, c.ownerId))

    const rules = await ownerDb.select().from(automationRule).where(eq(automationRule.organizationId, c.orgId))
    expect(rules.find((rule) => rule.kind === "recordatorio_cita")?.enabled).toBe(false)
    const [agent] = await ownerDb.select().from(agentConfig).where(eq(agentConfig.organizationId, c.orgId))
    expect(agent?.enabled).toBe(false)
    // Y no deja registros nuevos: no encendió nada.
    const after = await ownerDb.select({ id: auditEvent.id }).from(auditEvent).where(eq(auditEvent.organizationId, c.orgId))
    expect(after).toHaveLength(before.length)
  })

  it("el aviso sugerido dice quién es la clínica sin repetir su nombre", () => {
    expect(suggestedPrivacyNotice({ legalName: "Clínica Sonríe", tradeName: null, fiscalDocNumber: null })).toMatch(/^Clínica Sonríe usará tus datos/)
    // Fuera de Perú no nombra una ley que no es la suya.
    expect(suggestedPrivacyNotice({ legalName: "Clínica Sonríe", tradeName: null, fiscalDocNumber: null, countryCode: "ES" })).not.toContain("29733")
    expect(suggestedPrivacyNotice({ legalName: "Clínica Sonríe", tradeName: "Clínica Sonríe", fiscalDocNumber: "20123456789" })).toMatch(
      /^Clínica Sonríe \(20123456789\) usará tus datos/,
    )
  })

  it("mientras nadie lo revisa, el aviso sigue los datos de la clínica; revisado, es de la clínica", async () => {
    const c = await newClinic()
    await c.run((tx) => setUpNewClinic(tx, c.orgId, c.ownerId))
    await ownerDb.update(orgProfile).set({ fiscalAddress: "Av. Larco 345, Miraflores" }).where(eq(orgProfile.organizationId, c.orgId))
    await c.run((tx) => refreshSuggestedNotice(tx, c.orgId, c.ownerId))
    const config = await c.run((tx) => getPatientRegistrationConfig(tx, c.orgId))
    expect(config.privacyNotice).toContain("con domicilio en Av. Larco 345, Miraflores,")
    expect(await c.run((tx) => registrationNoticeSuggested(tx, c.orgId))).toBe(true)

    // «Lo revisé» sin cambiar el texto: pasa a ser de la clínica y ya no se vuelve a armar.
    await c.run((tx) => savePatientRegistrationConfig(tx, c.orgId, c.ownerId, { expectedVersion: config.version, enabled: true, fields: config.fields, privacyNotice: config.privacyNotice, noticeReviewed: true }))
    expect(await c.run((tx) => registrationNoticeSuggested(tx, c.orgId))).toBe(false)
    await ownerDb.update(orgProfile).set({ fiscalAddress: "Jr. Unión 100" }).where(eq(orgProfile.organizationId, c.orgId))
    await c.run((tx) => refreshSuggestedNotice(tx, c.orgId, c.ownerId))
    expect((await c.run((tx) => getPatientRegistrationConfig(tx, c.orgId))).privacyNotice).toContain("Av. Larco 345")
  })

  it("cambiar el texto del aviso sugerido lo hace de la clínica", async () => {
    const c = await newClinic()
    await c.run((tx) => setUpNewClinic(tx, c.orgId, c.ownerId))
    const config = await c.run((tx) => getPatientRegistrationConfig(tx, c.orgId))
    await c.run((tx) => savePatientRegistrationConfig(tx, c.orgId, c.ownerId, { expectedVersion: config.version, enabled: true, fields: config.fields, privacyNotice: `${config.privacyNotice} Escríbenos a hola@example.com.` }))
    expect(await c.run((tx) => registrationNoticeSuggested(tx, c.orgId))).toBe(false)
    // Guardar otra cosa sin tocar el aviso, en cambio, no lo marca como revisado.
    const other = await newClinic()
    await other.run((tx) => setUpNewClinic(tx, other.orgId, other.ownerId))
    const otherConfig = await other.run((tx) => getPatientRegistrationConfig(tx, other.orgId))
    await other.run((tx) => savePatientRegistrationConfig(tx, other.orgId, other.ownerId, { expectedVersion: otherConfig.version, enabled: false, fields: otherConfig.fields, privacyNotice: otherConfig.privacyNotice }))
    expect(await other.run((tx) => registrationNoticeSuggested(tx, other.orgId))).toBe(true)
  })

  it("una clínica de antes que elige plan no recibe un tope que no eligió", async () => {
    const c = await newClinic()
    await c.run((tx) => chooseSaasPlan(tx, c.orgId, c.ownerId, "nueva-lista"))
    const [sub] = await ownerDb.select({ cap: saasSubscription.spendCapCents }).from(saasSubscription).where(eq(saasSubscription.organizationId, c.orgId))
    expect(sub?.cap).toBeNull()
  })

  it("sin aviso propio, el que ve el paciente es el sugerido y Configuración lo marca sin revisar", async () => {
    const c = await newClinic()
    expect(await c.run((tx) => registrationNoticeSuggested(tx, c.orgId))).toBe(true)
    expect(await c.run((tx) => privacyNoticeOf(tx, c.orgId))).toMatch(/^Clínica Sonríe \(Sonríe S\.A\.C\., 20123456789\) usará tus datos/)
  })
})

