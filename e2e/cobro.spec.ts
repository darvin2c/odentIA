import { randomUUID } from "node:crypto"
import { adminSessionVerification, adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { aiUsage } from "@odentia/db/schema/agent"
import { session } from "@odentia/db/schema/auth"
import { reportQuestion } from "@odentia/db/schema/reports"
import { saasAction, saasPlan, saasSubscription, storageUsageDay } from "@odentia/db/schema/saas-billing"
import { desc, eq } from "drizzle-orm"
import { hostUrl, tenant } from "./env"
import { expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/**
 * Cobro por acción (ADR 0031 y 0085): lo que hicieron los agentes en Plan y
 * pagos por tipo y fila por fila, las preguntas a Argos y lo guardado, el
 * presupuesto alcanzado con lo cobrado después y su aviso, y en la
 * administración el plan, la ficha de la clínica y Hoy. Los datos de cobro se
 * preparan por la base: contarlos ya lo prueban los servicios; aquí se recorre
 * lo que se ve.
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
      // Los precios por tipo del lienzo «Cobro por tipo» (ADR 0085).
      conversationInformMicros: 100_000,
      conversationMicros: 500_000,
      conversationAgendaMicros: 1_000_000,
      consultationSimpleMicros: 100_000,
      consultationStandardMicros: 200_000,
      consultationMicros: 500_000,
      recoveryMicros: 2_000_000,
      argosIncludedQuestions: 300,
      argosPackQuestions: 100,
      argosPackMicros: 3_000_000,
      storageIncludedGb: 20,
      storageGbMicros: 200_000,
      fixedPriceTiers: ["informa", "simple", "estandar", "preguntas"],
      maxDiscountBps: 4000,
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
  type Kind = "conversacion" | "consulta" | "cita" | "preguntas"
  /** Una acción con su precio congelado: lo fijo sin descuento, lo demás con el 10 %. */
  const action = (kind: Kind, tier: string | null, minutesAgo: number, base: number, detail: string, channel: string | null, fixed = false, units: number | null = null) => ({
    organizationId: org.id,
    kind,
    tier,
    units,
    occurredAt: new Date(now - minutesAgo * 60_000),
    contactId: randomUUID(),
    channel,
    detail,
    currency: "USD",
    basePriceMicros: base,
    priceMicros: fixed ? base : Math.round(base * 0.9),
    discountBps: fixed ? 0 : 1000,
    dedupeKey: randomUUID(),
  })
  await fixtureDb.insert(saasAction).values([
    ...Array.from({ length: 30 }, (_, index) => action("conversacion", "informa", 9_000 + index * 60, 100_000, "Atendió una conversación por WhatsApp", "whatsapp", true)),
    ...Array.from({ length: 52 }, (_, index) => action("conversacion", "gestiona", 3_000 + index * 60, 500_000, "Atendió una conversación y gestionó una cita por WhatsApp", "whatsapp")),
    action("consulta", "simple", 2_400, 100_000, "Dejó lista una cosa de la consulta dictada por Ana Pruebas", null, true),
    action("consulta", "simple", 2_300, 100_000, "Dejó lista una cosa de la consulta dictada por Ana Pruebas", null, true),
    action("consulta", "estandar", 2_200, 200_000, "Ordenó la consulta dictada por Ana Pruebas", null, true),
    action("consulta", "completa", 2_100, 500_000, "Ordenó la consulta dictada y armó el presupuesto por Ana Pruebas", null),
    action("preguntas", null, 2_000, 3_000_000, "Sumó 100 preguntas a Argos", null, true, 100),
    // Ya pasado el presupuesto: resultados de un trabajo ya hecho, que se cobran igual.
    action("conversacion", "agenda", 300, 500_000, "Vino a la cita que reservó Sofi: sube de Gestiona a Agenda", "whatsapp"),
    action("cita", null, 200, 2_000_000, "Volvió tras «Seguir un presupuesto» y reservó desde el enlace", "enlace"),
  ])
  // 150 preguntas a Argos este mes y 14,2 GB guardados.
  await fixtureDb.insert(reportQuestion).values(
    Array.from({ length: 150 }, () => ({ organizationId: org.id, userId: user.id, outcome: "respondida", usedModel: true, createdAt: new Date(now - day) })),
  )
  await fixtureDb
    .insert(storageUsageDay)
    .values({ organizationId: org.id, day: new Date(now).toISOString().slice(0, 10), bytes: Math.round(14.2 * 1024 ** 3) })
    .onConflictDoNothing()
  await fixtureDb.insert(aiUsage).values([
    { organizationId: org.id, origin: "recepcion", provider: "openai", model: "gpt-6-luna", calls: 120, inputTokens: 360_000, cachedInputTokens: 240_000, cacheWriteTokens: 12_000, outputTokens: 6_000, costMicros: 17_700 },
    { organizationId: org.id, origin: "dictado", provider: "openai", model: "gpt-6-luna", calls: 3, inputTokens: 6_000, outputTokens: 900, costMicros: 1_050 },
    { organizationId: org.id, origin: "ya_aviso", provider: "jev", model: "jev-1.13.0", calls: 4, inputTokens: 1_200, outputTokens: 8, costMicros: 50 },
  ])

  // Plan y pagos: cada agente con sus tipos, cuántas y a cuánto (tablero C1).
  await gotoHydrated(page, tenant(org.slug, "/settings/plan"))
  const consumption = page.getByRole("region", { name: "Lo que hicieron tus agentes este mes" })
  await expect(consumption).toBeVisible()
  await expect(consumption.getByText("Informa", { exact: true })).toBeVisible()
  await expect(consumption.getByText(/^30 × 0[.,]10$/)).toBeVisible()
  await expect(consumption.getByText(/^52 × 0[.,]45$/)).toBeVisible()
  await expect(consumption.getByText("Completa", { exact: true })).toBeVisible()
  await expect(consumption.getByText("Citas recuperadas", { exact: true })).toBeVisible()
  await expect(consumption.getByText("150 de 400 incluidas y sumadas")).toBeVisible()
  await expect(consumption.getByText(/^14[.,]2 GB$/)).toBeVisible()
  await expect(consumption.getByText("Se factura al cerrar tu mes", { exact: false })).toBeVisible()
  for (const meter of ["Crédito del mes", "Presupuesto del mes", "Preguntas a Argos", "Almacenamiento"]) {
    await expect(consumption.getByRole("meter", { name: meter })).toBeVisible()
  }
  // Pasado el presupuesto, lo que se cobró igual por un trabajo ya hecho (tablero C4).
  const after = consumption.getByRole("region", { name: "Cobrado tras el presupuesto" })
  await expect(after).toBeVisible()
  await expect(after.getByText("1 paciente vino a la cita que reservó Sofi")).toBeVisible()
  await expect(after.getByText("1 cita recuperada")).toBeVisible()
  await expect(page.getByText("Te devolvemos los", { exact: false }).first()).toBeVisible()
  await expect(page.getByText("100 preguntas más")).toBeVisible()
  await shot("panel-plan-y-pagos")

  // El presupuesto se cambia en su panel lateral, con lo que pasa al llegar dicho antes de guardar.
  await consumption.getByRole("button", { name: "Cambiar presupuesto" }).click()
  await expect(page.getByText("Cuando llegue al presupuesto")).toBeVisible()
  await shot("panel-presupuesto")
  await page.keyboard.press("Escape")

  // Ver cada acción: la factura suma exactamente estas filas, cada una con su tipo (tablero C2).
  await consumption.getByRole("button", { name: "Ver cada acción" }).click()
  await expect(page.getByRole("heading", { name: "Cada acción de tus agentes" })).toBeVisible()
  await expect(page.getByText("Por encima del crédito").first()).toBeVisible()
  await expect(page.getByText("Del crédito del mes").first()).toBeVisible()
  await expect(page.getByText("Agenda", { exact: true }).first()).toBeVisible()
  await shot("panel-cada-accion")
  await page.getByRole("tab", { name: "Argos" }).click()
  await expect(page.getByText("100 preguntas", { exact: true })).toBeVisible()
  await expect(page.getByText("Cita recuperada", { exact: true })).toBeVisible()
  await shot("panel-cada-accion-argos")

  // En el teléfono, el mismo orden y el detalle en tarjetas.
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoHydrated(page, tenant(org.slug, "/settings/plan"))
  await expect(page.getByRole("region", { name: "Lo que hicieron tus agentes este mes" })).toBeVisible()
  await shot("panel-telefono")
  await page.setViewportSize({ width: 1280, height: 900 })

  // La plataforma avisa arriba de cada pantalla, con su acción.
  await gotoHydrated(page, tenant(org.slug, "/home"))
  // Con el crédito y el presupuesto pasados, avisa primero el presupuesto (ADR 0085).
  // La franja pinta el escritorio y el teléfono: se mira la que está a la vista.
  await expect(page.getByText("Llegaste al presupuesto del mes", { exact: false }).filter({ visible: true })).toBeVisible()
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
      tier: "gestiona",
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
  await expect(page.getByRole("heading", { name: "Planes", exact: true })).toBeVisible()
  await page.getByText(plan!.name).first().scrollIntoViewIfNeeded()
  await shot("admin-facturacion")
  const planRow = page.getByRole("listitem").filter({ hasText: plan!.code })
  await planRow.getByRole("button", { name: "Editar" }).click()
  // Exacto: la nota de las condiciones comerciales también nombra esta comprobación (tablero O1).
  await expect(page.getByText("Comprobación antes de guardar", { exact: true })).toBeVisible()
  const checks = page.getByRole("region", { name: "Comprobación antes de guardar" })
  // Gestiona a USD 0,50, al mínimo (40 % menos) USD 0,30, frente a su peor costo de USD 0,06: 5 veces.
  await expect(checks.getByRole("row").filter({ hasText: "Gestiona" })).toContainText("5")
  // Simple no se negocia y vale menos del doble en el caso extremo: «Atento», y se guarda igual.
  await expect(checks.getByRole("row").filter({ hasText: "Simple" })).toContainText("Atento")
  await expect(page.getByLabel("Informa")).toHaveValue("0.1")
  await shot("admin-plan")
  await page.keyboard.press("Escape")

  // La ficha: el mes con lo cobrado, lo que costó y el margen, y lo que hizo cada agente.
  await gotoHydrated(page, hostUrl("admin", `/organizations/${org.id}`))
  const month = page.getByRole("region", { name: "El mes, en curso" })
  await expect(month).toBeVisible()
  await expect(month.getByText("Nos costó", { exact: true })).toBeVisible()
  await expect(month.getByText("Margen", { exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "Lo que hicieron los agentes" })).toContainText("82 conversaciones")
  await shot("admin-ficha")
  // Gastos: costo y margen por agente y tipo, también lo que no se cobra (tablero O2).
  await page.getByRole("tab", { name: "Gastos" }).click()
  const byType = page.getByRole("region", { name: "Por agente y tipo" })
  await expect(byType.getByRole("columnheader", { name: "Nos costó" })).toBeVisible()
  await expect(byType.getByRole("row").filter({ hasText: "Sofi · Gestiona" })).toContainText("52")
  await expect(byType.getByText("Jev · decide cada mensaje")).toBeVisible()
  await shot("admin-ficha-gastos")

  // Hoy: las pruebas por vencer y el costo y margen de todas las clínicas (tablero O3).
  await gotoHydrated(page, hostUrl("admin", "/"))
  await expect(page.getByRole("heading", { name: "Pruebas por vencer o sin saldo" })).toBeVisible()
  await expect(page.getByRole("listitem").filter({ hasText: trial.org.name })).toBeVisible()
  const overview = page.getByRole("region", { name: "Costo y margen" })
  await expect(overview).toBeVisible()
  await expect(overview.getByRole("row").filter({ hasText: org.name })).toBeVisible()
  await shot("admin-hoy")
})
