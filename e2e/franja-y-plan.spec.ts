import { randomUUID } from "node:crypto"
import { member } from "@odentia/db/schema/auth"
import { saasCharge, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { PANEL, tenant, tenantPattern } from "./env"
import { expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Plan y pagos dentro de la clínica y la franja de avisos (ADR 0065): quién ve
 * cada aviso, que el pago siga abierto en solo lectura, el selector con su
 * botón y las direcciones viejas del panel.
 */
const DAY = 86_400_000

test("franja y plan: el cargo por vencer, solo lectura para el equipo y el selector con «Pagar»", async ({ owner, createOwner, fixtureDb }, testInfo) => {
  test.setTimeout(180_000)
  const { page, org } = owner
  const shot = (target: typeof page, name: string) => target.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false })
  const now = Date.now()

  const [plan] = await fixtureDb
    .insert(saasPlan)
    .values({
      code: `franja-${randomUUID().slice(0, 8)}`,
      name: "Plan odentIA",
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationMicros: 500_000,
      consultationMicros: 400_000,
      recoveryMicros: 4_000_000,
      trialCreditCents: 5000,
      trialMaxCreditCents: 13000,
    })
    .returning()
  await fixtureDb
    .update(saasSubscription)
    .set({ planId: plan!.id, status: "activa", trialEndsAt: null, activatedAt: new Date(now - 10 * DAY), currentPeriodStart: new Date(now - 10 * DAY), currentPeriodEnd: new Date(now + 20 * DAY) })
    .where(eq(saasSubscription.organizationId, org.id))
  const [cargo] = await fixtureDb
    .insert(saasCharge)
    .values({
      organizationId: org.id,
      planId: plan!.id,
      planCode: plan!.code,
      planName: plan!.name,
      periodStart: new Date(now - 10 * DAY),
      periodEnd: new Date(now + 20 * DAY),
      amountCents: 3276,
      currency: "USD",
      dueAt: new Date(now + 1.5 * DAY),
      dedupeKey: randomUUID(),
    })
    .returning()

  // La franja, encima de todo: ámbar dos días antes, con el monto para quien administra.
  await page.setViewportSize({ width: 1280, height: 860 })
  await gotoHydrated(page, tenant(org.slug, "/home"))
  const strip = page.getByRole("region", { name: "Avisos de la clínica" })
  // La franja pinta el escritorio y el teléfono: se mira la que está a la vista.
  await expect(strip.getByText("vence el", { exact: false }).filter({ visible: true })).toBeVisible()
  await expect(strip.getByText("32.76", { exact: false }).filter({ visible: true })).toBeVisible()
  const stripBox = await strip.boundingBox()
  expect(stripBox?.y).toBe(0)
  await shot(page, "franja-escritorio")

  // «Registrar pago» lleva a Plan y pagos dentro de la clínica, con de qué clínica es.
  await strip.getByRole("link", { name: "Registrar pago" }).click()
  await expect(page).toHaveURL(tenantPattern(org.slug, "/settings/plan"))
  await expect(page.getByRole("heading", { level: 1, name: "Plan y pagos" })).toBeVisible()
  await expect(page.getByText(`${org.name} · ${org.slug}.`, { exact: false })).toBeVisible()
  await expect(page.getByRole("region", { name: "Próximo cobro" })).toBeVisible()
  await shot(page, "plan-en-la-clinica")

  // La X la cierra por hoy, solo para esta persona.
  await strip.getByRole("button", { name: "Cerrar aviso" }).click()
  await expect(strip).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("region", { name: "Avisos de la clínica" })).toHaveCount(0)

  // En el teléfono, una sola línea.
  const phone = await owner.context.newPage()
  await phone.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(phone, tenant(org.slug, "/home"))
  // Lo cerrado es de esta persona en este navegador: se olvida para ver la franja otra vez.
  await phone.evaluate(() => localStorage.clear())
  await gotoHydrated(phone, tenant(org.slug, "/home"))
  const phoneStrip = phone.getByRole("region", { name: "Avisos de la clínica" })
  await expect(phoneStrip.getByRole("button", { name: /Tu cargo vence el/ })).toBeVisible()
  expect((await phoneStrip.boundingBox())?.height ?? 99).toBeLessThanOrEqual(48)
  await shot(phone, "franja-telefono")
  await phone.close()

  // Solo lectura: todo el equipo lo ve, sin montos ni botón; Plan y pagos sigue abierto para quien administra.
  await fixtureDb.update(saasCharge).set({ dueAt: new Date(now - 10 * DAY) }).where(eq(saasCharge.id, cargo!.id))
  await fixtureDb.update(saasSubscription).set({ status: "restringida", restrictReason: "gracia_vencida" }).where(eq(saasSubscription.organizationId, org.id))
  const dentist = await createOwner("equipo")
  await fixtureDb.insert(member).values({ id: randomUUID(), organizationId: org.id, userId: dentist.user.id, role: "dentist", createdAt: new Date() })
  await gotoHydrated(dentist.page, tenant(org.slug, "/home"))
  const teamStrip = dentist.page.getByRole("region", { name: "Avisos de la clínica" })
  await expect(teamStrip.getByText("solo lectura", { exact: false }).filter({ visible: true })).toBeVisible()
  await expect(teamStrip.getByText("32.76", { exact: false })).toHaveCount(0)
  await expect(teamStrip.getByRole("link")).toHaveCount(0)
  await expect(teamStrip.getByRole("button", { name: "Cerrar aviso" })).toHaveCount(0)
  await shot(dentist.page, "franja-equipo-solo-lectura")

  await gotoHydrated(page, tenant(org.slug, "/settings/plan"))
  await expect(page.getByRole("heading", { level: 2, name: "Registrar comprobante" })).toBeVisible()

  // El selector: la clínica dice qué pasa y ofrece «Pagar»; el «⋯» queda solo para salir.
  await gotoHydrated(page, `${PANEL}/?cambiar=1`)
  const row = page.getByRole("listitem").filter({ hasText: org.name })
  await expect(row.getByText("Solo lectura", { exact: false })).toBeVisible()
  await expect(row.getByText("1 sede", { exact: false })).toBeVisible()
  await expect(row.getByRole("link", { name: "Pagar" })).toHaveAttribute("href", tenantPattern(org.slug, "/settings/plan"))
  await shot(page, "selector-con-pagar")

  // La dirección vieja del panel lleva a la clínica.
  await gotoHydrated(page, `${PANEL}/billing/${org.id}`)
  await expect(page).toHaveURL(tenantPattern(org.slug, "/settings/plan"))
})
