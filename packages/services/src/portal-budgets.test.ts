/**
 * Presupuestos y cuenta en el portal: el paciente recibe los totales del
 * servidor (también de lo que se cobra por sesión) y el formato regional de
 * la clínica, y su respuesta devuelve el presupuesto con esos mismos campos.
 */
import { withOrgContext } from "@odentia/db"
import { contact } from "@odentia/db/schema/crm"
import { portalLink } from "@odentia/db/schema/portal"
import { createHash, randomBytes } from "node:crypto"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem } from "./plan.js"
import { createPortalGrant } from "./portal-access.js"
import { upsertPortalPolicy } from "./portal-policy.js"
import {
  decidePortalBudget,
  exchangePortalToken,
  getPortalAccount,
  listPortalBudgets,
  requirePortalSession,
} from "./portal.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { listWorkspaceAudit } from "./workspace.js"
setupTestDb()

const ORG = "org_a"
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

it("el portal entrega totales, líneas por sesión y el formato de la clínica", async () => {
  const f = await clinicalFixture()
  const [actor, patientId] = [f.args[1], f.args[2]]
  // Una clínica que no usa el formato por defecto: el portal debe entregar el suyo.
  await ownerDb.execute(
    sql`update "org_profile" set "locale" = 'es-CL' where "organization_id" = ${ORG}`,
  )
  await f.run((tx) =>
    tx.execute(
      sql`update "service_catalog" set "price_cents" = 15000, "billing_mode" = 'session' where "id" = ${f.service.id}`,
    ),
  )
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
      plannedSessions: 18,
    }),
  )
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))

  // Acceso del portal: política, persona vinculada verificada, enlace y canje.
  const [person] = await ownerDb
    .insert(contact)
    .values({ organizationId: ORG, displayName: "Contacto del portal" })
    .returning({ id: contact.id })
  const raw = randomBytes(32).toString("base64url")
  await withOrgContext(appDb, ORG, async (tx) => {
    await upsertPortalPolicy(tx, ORG, actor, {
      enabled: true,
      requestsEnabled: true,
      publicRequestsEnabled: false,
      channelRequestsEnabled: false,
      autoApproveVerified: false,
      allowedConnectionIds: [],
      linkTtlMinutes: 4320,
      sessionTtlHours: 48,
      grantTtlDays: null,
      allowedScope: { appointments: true, budgets: true, account: true, documents: true },
      passkeysEnabled: true,
      assistedRecoveryEnabled: true,
    })
    await createPortalGrant(tx, ORG, actor, {
      patientId,
      contactId: person!.id,
      relationship: "self",
      scope: { budgets: true, account: true },
      verifiedMethod: "presencial_documento",
      evidenceNote: "Documento revisado en recepción.",
    })
    await tx.insert(portalLink).values({
      organizationId: ORG,
      patientId,
      contactId: person!.id,
      scope: { appointments: false, budgets: true, account: true, documents: [] },
      tokenHash: hash(raw),
      pinHash: hash("123456"),
      status: "pendiente",
      expiresAt: new Date(Date.now() + 3600_000),
      createdBy: actor,
    })
  })
  const opened = await withOrgContext(appDb, ORG, (tx) =>
    exchangePortalToken(tx, ORG, raw, { pin: "123456" }),
  )
  const inPortal = <T>(
    fn: (tx: typeof appDb, ctx: Awaited<ReturnType<typeof requirePortalSession>>) => Promise<T>,
  ) =>
    withOrgContext(appDb, ORG, async (tx) =>
      fn(tx, await requirePortalSession(tx, ORG, opened.sessionToken)),
    )

  const listed = await inPortal((tx, ctx) => listPortalBudgets(tx, ctx))
  expect(listed).toHaveLength(1)
  expect(listed[0]).toMatchObject({
    locale: "es-CL",
    status: "presentado",
    totalCents: 270000,
    tariffTotalCents: 270000,
    discountCents: 0,
  })
  expect(listed[0]?.items[0]).toMatchObject({
    billingMode: "session",
    priceCents: 15000,
    sessionsPlanned: 18,
    lineTotalCents: 270000,
    tariffLineTotalCents: 270000,
  })

  const decided = await inPortal((tx, ctx) =>
    decidePortalBudget(tx, ctx, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  expect(decided.replay).toBe(false)
  expect(decided.budget).toMatchObject({
    locale: "es-CL",
    status: "aceptado",
    totalCents: 270000,
    acceptedCents: 270000,
  })
  expect(decided.budget.items[0]).toMatchObject({ decision: "aceptado", lineTotalCents: 270000 })

  // La cuenta del portal trae el mismo formato regional.
  const account = await inPortal((tx, ctx) => getPortalAccount(tx, ctx))
  expect(account.locale).toBe("es-CL")

  // Lo decidió la persona en el portal: el presupuesto no queda a nombre de quien
  // emitió el enlace, y «Actividad del equipo» lo dice como del paciente.
  const [decidedRow] = await ownerDb.execute<{ decided_by: string | null }>(
    sql`select "decided_by" from "treatment_budget" where "id" = ${budget.id}`,
  )
  expect(decidedRow?.decided_by).toBeNull()
  for (const action of ["portal.budget_decided", "budget.decision"]) {
    const activity = await withOrgContext(appDb, ORG, (tx) => listWorkspaceAudit(tx, ORG, { action }))
    expect(activity.items).toHaveLength(1)
    expect(activity.items[0]).toMatchObject({ actorName: null, who: "El paciente o su contacto" })
  }
})
