import { randomUUID } from "node:crypto"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { aiUsage } from "@odentia/db/schema/agent"
import { session } from "@odentia/db/schema/auth"
import { saasAction, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { desc, eq } from "drizzle-orm"
import { hostUrl, tenant } from "./env"
import { expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Cobro por acción (ADR 0031): lo que hicieron los agentes en Plan y pagos y
 * fila por fila, el aviso de la plataforma, y en la administración el plan,
 * la ficha de la clínica y Hoy. Los datos de cobro se preparan por la base:
 * contarlos ya lo prueban los servicios; aquí se recorre lo que se ve.
 */
test("cobro por acción: la clínica ve sus acciones y su aviso; la administración, el plan, la ficha y Hoy", async ({ owner, createOwner, fixtureDb }, testInfo) => {
  test.setTimeout(180_000)
  const { page, org, user } = owner
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true })
  const day = 86_400_000
  const now = Date.now()

  const [plan] = await fixtureDb
    .insert(saasPlan)
    .values({
      code: `cobro-${randomUUID().slice(0, 8)}`,
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
  // Clínica activa desde hace 10 días, con 10 % negociado y un tope de USD 1 por encima del crédito.
  await fixtureDb
    .update(saasSubscription)
    .set({
      planId: plan!.id,
      status: "activa",
      trialEndsAt: null,
      discountBps: 1000,
      spendCapCents: 100,
      activatedAt: new Date(now - 10 * day),
      currentPeriodStart: new Date(now - 10 * day),
      currentPeriodEnd: new Date(now + 20 * day),
    })
    .where(eq(saasSubscription.organizationId, org.id))
  const action = (kind: "conversacion" | "consulta" | "cita", minutesAgo: number, base: number, detail: string, channel: string | null) => ({
    organizationId: org.id,
    kind,
    occurredAt: new Date(now - minutesAgo * 60_000),
    contactId: randomUUID(),
    channel,
    detail,
    currency: "USD",
    basePriceMicros: base,
    priceMicros: Math.round(base * 0.9),
    discountBps: 1000,
    dedupeKey: randomUUID(),
  })
  await fixtureDb.insert(saasAction).values([
    ...Array.from({ length: 64 }, (_, index) => action("conversacion", 600 + index * 60, 500_000, "Atendió una conversación por WhatsApp", "whatsapp")),
    action("consulta", 300, 400_000, "Ordenó la consulta dictada por Ana Pruebas", null),
    action("cita", 200, 4_000_000, "Volvió tras «Seguir un presupuesto» y reservó desde el enlace", "enlace"),
  ])
  await fixtureDb.insert(aiUsage).values([
    { organizationId: org.id, origin: "recepcion", provider: "openai", model: "gpt-6-luna", calls: 120, inputTokens: 360_000, cachedInputTokens: 240_000, cacheWriteTokens: 12_000, outputTokens: 6_000, costMicros: 17_700 },
    { organizationId: org.id, origin: "dictado", provider: "openai", model: "gpt-6-luna", calls: 3, inputTokens: 6_000, outputTokens: 900, costMicros: 1_050 },
    { organizationId: org.id, origin: "ya_aviso", provider: "jev", model: "jev-1.13.0", calls: 4, inputTokens: 1_200, outputTokens: 8, costMicros: 50 },
  ])

  // Plan y pagos: lo que hicieron los agentes con el precio base y el propio.
  await gotoHydrated(page, tenant(org.slug, "/settings/plan"))
  const consumption = page.getByRole("region", { name: "Lo que hicieron tus agentes este mes" })
  await expect(consumption).toBeVisible()
  await expect(consumption.getByText("64 conversaciones atendidas")).toBeVisible()
  await expect(consumption.getByText("Se factura al cerrar tu mes", { exact: false })).toBeVisible()
  await expect(consumption.getByRole("meter", { name: "Crédito del mes" })).toBeVisible()
  await expect(consumption.getByRole("meter", { name: "Tope por encima del crédito" })).toBeVisible()
  await expect(page.getByText("Te devolvemos los", { exact: false }).first()).toBeVisible()
  await shot("panel-plan-y-pagos")

  // El tope se cambia en su panel lateral, con lo que pasa al llegar dicho antes de guardar.
  await consumption.getByRole("button", { name: "Cambiar tope" }).click()
  await expect(page.getByText("Cuando llegue al tope")).toBeVisible()
  await shot("panel-tope")
  await page.keyboard.press("Escape")

  // Ver cada acción: la factura suma exactamente estas filas.
  await consumption.getByRole("button", { name: "Ver cada acción" }).click()
  await expect(page.getByRole("heading", { name: "Cada acción de tus agentes" })).toBeVisible()
  await expect(page.getByText("Por encima del crédito").first()).toBeVisible()
  await expect(page.getByText("Del crédito del mes").first()).toBeVisible()
  await shot("panel-cada-accion")

  // En el teléfono, el mismo orden y el detalle en tarjetas.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/settings/plan"))
  await expect(page.getByRole("region", { name: "Lo que hicieron tus agentes este mes" })).toBeVisible()
  await shot("panel-telefono")
  await page.setViewportSize({ width: 1280, height: 900 })

  // La plataforma avisa arriba de cada pantalla, con su acción.
  await gotoHydrated(page, tenant(org.slug, "/home"))
  // Con el crédito y el tope en el límite, avisa primero el tope: corta los casos nuevos.
  // La franja pinta el escritorio y el teléfono: se mira la que está a la vista.
  await expect(page.getByText("Llegaste a tu tope de gasto", { exact: false }).filter({ visible: true })).toBeVisible()
  await shot("plataforma-aviso")

  // Una segunda clínica en prueba con el saldo casi agotado, para Hoy.
  const trial = await createOwner("prueba")
  await fixtureDb
    .update(saasSubscription)
    .set({ planId: plan!.id, status: "prueba", trialStartedAt: new Date(now - 20 * day), trialEndsAt: new Date(now + 10 * day), currentPeriodStart: new Date(now - 20 * day), currentPeriodEnd: new Date(now + 10 * day) })
    .where(eq(saasSubscription.organizationId, trial.org.id))
  await fixtureDb.insert(saasAction).values(
    Array.from({ length: 92 }, (_, index) => ({
      organizationId: trial.org.id,
      kind: "conversacion",
      occurredAt: new Date(now - (index + 1) * 3_600_000),
      contactId: randomUUID(),
      detail: "Atendió una conversación por WhatsApp",
      currency: "USD",
      basePriceMicros: 500_000,
      priceMicros: 500_000,
      dedupeKey: randomUUID(),
    })),
  )

  // La administración: la misma persona, como personal con su segundo factor verificado en esta sesión.
  const [current] = await fixtureDb.select({ id: session.id }).from(session).where(eq(session.userId, user.id)).orderBy(desc(session.createdAt)).limit(1)
  const factorId = randomUUID()
  await fixtureDb.insert(adminStaff).values({ userId: user.id, role: "admin" })
  await fixtureDb.insert(twoFactor).values({ id: factorId, userId: user.id, secret: "e2e", backupCodes: "[]", verified: true })
  await fixtureDb.insert(adminSessionVerification).values({ userId: user.id, sessionId: current!.id, factorId, method: "totp", expiresAt: new Date(now + day) })

  await gotoHydrated(page, hostUrl("admin", "/billing"))
  await expect(page.getByRole("heading", { name: "Planes" })).toBeVisible()
  await page.getByText(plan!.name).first().scrollIntoViewIfNeeded()
  await shot("admin-facturacion")
  const planRow = page.getByRole("listitem").filter({ hasText: plan!.code })
  await planRow.getByRole("button", { name: "Editar" }).click()
  await expect(page.getByText("Comprobación antes de guardar")).toBeVisible()
  await expect(page.getByText("12.5 veces su peor costo", { exact: false })).toBeVisible()
  await expect(page.getByText("margen de 86 %", { exact: false })).toBeVisible()
  await shot("admin-plan")
  await page.keyboard.press("Escape")

  await gotoHydrated(page, hostUrl("admin", `/organizations?org=${org.id}`))
  await expect(page.getByText("Cobro y consumo")).toBeVisible()
  await expect(page.getByText("Costo real de IA", { exact: false })).toBeVisible()
  await shot("admin-ficha")

  await gotoHydrated(page, hostUrl("admin", "/"))
  await expect(page.getByRole("heading", { name: "Pruebas por vencer o sin saldo" })).toBeVisible()
  await expect(page.getByRole("listitem").filter({ hasText: trial.org.name })).toBeVisible()
  await shot("admin-hoy")
})
