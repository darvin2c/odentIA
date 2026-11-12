import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { accountRecoveryCase } from "@odentia/db/schema/admin-organizations"
import { invitation, organization } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, desc, eq } from "drizzle-orm"
import { writeAdminAudit } from "./admin-core.js"
import { ensureClinicConsents } from "./clinical-forms.js"
import { initialOrgRegion } from "./organization-profile.js"
import { addDays as addCivilDays, dayStart, reportDayOf } from "./report-periods.js"
import { SEED_STAFF_ADMIN_ID } from "./seed-admin-core.js"
import { ensureClinicSpecialties } from "./specialties.js"

/**
 * Semilla dev de organizaciones y cuentas: inserciones idempotentes con
 * correos @odentia.dev claramente ficticios; nunca envía correos ni activa
 * automatizaciones. Requiere el staff interno ('seed-staff-support' y
 * 'seed-staff-admin') ya creado.
 *
 * - Una invitación pendiente de recepción en la clínica semilla, para ver el
 *   flujo invitar → aceptar → reanudar alta en el panel y en el admin.
 * - Un caso de recuperación de acceso pendiente con evidencia verificada de
 *   ejemplo, para la pantalla de usuarios del admin.
 * - «Demo Prueba» como alta asistida: con perfil y sin sede, y la propietaria
 *   invitada por Ada, con la invitación que vence hoy («Clínicas con la
 *   propietaria sin aceptar» en Inicio, «Alta incompleta» en Clínicas).
 */
export async function seedAdminOrganizations(db: Db): Promise<void> {
  const orgId = "seed-org-dental-smile"
  const inviterId = "seed-staff-support"

  const existingInvite = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, orgId),
        eq(invitation.email, "invitada.demo@odentia.dev"),
        eq(invitation.status, "pending"),
      ),
    )
    .limit(1)
  if (existingInvite.length === 0) {
    await db.insert(invitation).values({
      id: randomUUID(),
      organizationId: orgId,
      email: "invitada.demo@odentia.dev",
      role: "reception",
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      inviterId,
    })
  }

  const existingCase = await db
    .select({ id: accountRecoveryCase.id })
    .from(accountRecoveryCase)
    .where(
      and(
        eq(accountRecoveryCase.email, "recupero.demo@odentia.dev"),
        eq(accountRecoveryCase.status, "pendiente"),
      ),
    )
    .limit(1)
  if (existingCase.length === 0) {
    await db.insert(accountRecoveryCase).values({
      email: "recupero.demo@odentia.dev",
      kind: "acceso",
      status: "pendiente",
      evidence: {
        description:
          "Llamó por teléfono y dictó su documento; se validó contra la ficha de personal de la clínica semilla.",
        verifiedBy: inviterId,
        verifiedAt: new Date().toISOString(),
        method: "Verificación por llamada al número registrado de la clínica + documento dictado",
      },
      requestedBy: inviterId,
      approvals: [],
    })
  }

  await seedAssistedSignup(db)
}

/** La clínica de prueba de `seed-saas-billing.ts`, y la propietaria que Ada invitó. */
const ASSISTED_ORG = "seed-saas-prueba"
const ASSISTED_OWNER_EMAIL = "propietaria.prueba@odentia.dev"

/**
 * El alta asistida de «Demo Prueba», como la deja `createAssistedOrganization`:
 * el perfil con la región de su país, sus especialidades y consentimientos,
 * ninguna sede, y una invitación de propietaria hecha por el personal. La
 * invitación vence hoy en cada corrida, mientras siga pendiente: aceptada o
 * anulada, no se toca.
 */
async function seedAssistedSignup(db: Db): Promise<void> {
  const [org] = await db
    .select({ id: organization.id, name: organization.name, slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, ASSISTED_ORG))
    .limit(1)
  if (!org) return
  const [profile] = await db
    .select({ id: orgProfile.organizationId })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, ASSISTED_ORG))
    .limit(1)
  if (!profile) {
    const region = initialOrgRegion({ countryCode: "PE" })
    await db.insert(orgProfile).values({
      organizationId: ASSISTED_ORG,
      product: "dental",
      legalName: org.name,
      countryCode: region.countryCode,
      currency: region.currency,
      timezone: region.timezone,
      locale: region.locale,
      diagnosisSystem: region.diagnosisSystem,
    })
    await ensureClinicSpecialties(db, ASSISTED_ORG)
    await ensureClinicConsents(db, ASSISTED_ORG, null)
  }

  // Vence hoy, en Lima: a lo más en 6 horas y antes de medianoche. La hizo hace los 7 días que dura.
  const now = Date.now()
  const [year, month, day] = addCivilDays(reportDayOf("America/Lima", new Date(now)), 1)
    .split("-")
    .map(Number) as [number, number, number]
  const expiresAt = new Date(
    Math.min(dayStart("America/Lima", year, month, day).getTime() - 60_000, now + 6 * 3_600_000),
  )
  const dates = { expiresAt, createdAt: new Date(expiresAt.getTime() - 7 * 86_400_000) }
  // El alta asistida abre la clínica, su prueba y la invitación en el mismo momento
  // (`createAssistedOrganization`): si la invitación es de hace 7 días, la clínica y su
  // prueba también, con la duración que les dio la semilla de cobros. Si no, Inicio decía
  // «invitada el mié 4 nov… la prueba empezó hoy».
  await db.update(organization).set({ createdAt: dates.createdAt }).where(eq(organization.id, ASSISTED_ORG))
  const [trial] = await db
    .select({ startedAt: saasSubscription.trialStartedAt, endsAt: saasSubscription.trialEndsAt })
    .from(saasSubscription)
    .where(and(eq(saasSubscription.organizationId, ASSISTED_ORG), eq(saasSubscription.status, "prueba")))
    .limit(1)
  if (trial?.startedAt && trial.endsAt) {
    const length = trial.endsAt.getTime() - trial.startedAt.getTime()
    await db
      .update(saasSubscription)
      .set({ trialStartedAt: dates.createdAt, trialEndsAt: new Date(dates.createdAt.getTime() + length) })
      .where(eq(saasSubscription.organizationId, ASSISTED_ORG))
  }
  const [invite] = await db
    .select({ id: invitation.id, status: invitation.status })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, ASSISTED_ORG),
        eq(invitation.email, ASSISTED_OWNER_EMAIL),
        eq(invitation.role, "owner"),
      ),
    )
    .orderBy(desc(invitation.createdAt))
    .limit(1)
  if (invite) {
    if (invite.status === "pending")
      await db.update(invitation).set(dates).where(eq(invitation.id, invite.id))
    return
  }
  const invitationId = randomUUID()
  await db.insert(invitation).values({
    id: invitationId,
    organizationId: ASSISTED_ORG,
    email: ASSISTED_OWNER_EMAIL,
    role: "owner",
    status: "pending",
    ...dates,
    inviterId: SEED_STAFF_ADMIN_ID,
  })
  await writeAdminAudit(
    db,
    { userId: SEED_STAFF_ADMIN_ID, role: "admin" },
    {
      action: "org.assisted_create_invited",
      organizationId: ASSISTED_ORG,
      entityId: invitationId,
      metadata: {
        email: ASSISTED_OWNER_EMAIL,
        slug: org.slug,
        isDemo: false,
        existingAccount: false,
      },
    },
  )
}
