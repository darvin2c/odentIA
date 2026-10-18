import { randomUUID } from "node:crypto"
import { account, user } from "@odentia/db/schema/auth"
import { eq, sql } from "drizzle-orm"
import { PANEL, panelPattern, tenant, tenantPattern } from "./env"
import { api, expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

/** Lienzo «Términos con Google»: quien no aceptó, una versión nueva y el contrato de la clínica. */

test("términos: una cuenta sin aceptación que va a abrir su clínica acepta los tres y sigue a crearla", async ({
  browser,
  fixtureDb,
  passwordHash,
}, info) => {
  // Como una cuenta creada con Google: verificada y sin nada aceptado.
  const id = randomUUID()
  const email = `google-${id}@test.dev`
  await fixtureDb.insert(user).values({
    id,
    name: "Carmen Ruiz",
    firstName: "Carmen",
    lastName: "Ruiz",
    email,
    emailVerified: true,
  })
  await fixtureDb.insert(account).values({
    id: randomUUID(),
    accountId: id,
    userId: id,
    providerId: "credential",
    password: passwordHash,
    updatedAt: new Date(),
  })
  const context = await browser.newContext({ baseURL: PANEL, ignoreHTTPSErrors: true })
  try {
    const page = await context.newPage()
    await gotoHydrated(page, `${PANEL}/login`)
    const signedIn = await api(page, "POST", "/api/auth/sign-in/email", undefined, {
      email,
      password: "e2e-secreto-123",
    })
    expect(signedIn.status).toBe(200)
    await gotoHydrated(page, `${PANEL}/`)
    await expect(page).toHaveURL(panelPattern("/terminos"))
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Un paso antes de seguir")
    await expect(page.getByText("2 de 4")).toBeVisible()
    await expect(
      page.getByRole("link", { name: "Contrato de encargo de tratamiento" }),
    ).toBeVisible()
    await page.screenshot({ path: info.outputPath("1-un-paso-clinica-nueva.png"), fullPage: true })

    const go = page.getByRole("button", { name: /^(Obtén .+ de crédito|Seguir)$/ })
    await go.click()
    await expect(page.getByText("Marca la casilla para seguir.")).toBeVisible()
    await page.getByRole("checkbox", { name: /Acepto los Términos/ }).check()
    await go.click()
    await expect(page).toHaveURL(panelPattern("/onboarding"))
    const [row] = await fixtureDb.select().from(user).where(eq(user.id, id))
    expect(row?.termsVersion).toBeTruthy()
    expect(row?.processingAgreementVersion).toBeTruthy()
  } finally {
    await context.close()
  }
})

test("términos: quien ya trabaja en una clínica acepta términos y privacidad y vuelve adonde iba", async ({
  owner,
  fixtureDb,
}, info) => {
  await fixtureDb
    .update(user)
    .set({ termsVersion: null, termsAcceptedAt: null })
    .where(eq(user.id, owner.user.id))
  await gotoHydrated(owner.page, tenant(owner.org.slug, "/home"))
  await expect(owner.page).toHaveURL(panelPattern("/terminos?next="))
  await expect(
    owner.page.getByRole("link", { name: "Contrato de encargo de tratamiento" }),
  ).toHaveCount(0)
  await expect(owner.page.getByText("2 de 4")).toHaveCount(0)
  await owner.page.screenshot({ path: info.outputPath("2-un-paso-equipo.png"), fullPage: true })
  await owner.page.getByRole("checkbox", { name: /Acepto los Términos/ }).check()
  await owner.page.getByRole("button", { name: /^(Entrar a .+|Seguir)$/ }).click()
  await expect(owner.page).toHaveURL(tenantPattern(owner.org.slug, "/home"))
  await expect(owner.page.getByRole("heading", { name: "Inicio", level: 1 })).toBeVisible()
})

test("términos: una versión nueva y la clínica sin contrato se aceptan en una sola ventana", async ({
  owner,
  fixtureDb,
}, info) => {
  await fixtureDb.update(user).set({ termsVersion: "2026-01-01" }).where(eq(user.id, owner.user.id))
  await fixtureDb.execute(
    sql`delete from processing_agreement_acceptance where organization_id = ${owner.org.id}`,
  )
  await gotoHydrated(owner.page, tenant(owner.org.slug, "/home"))
  const dialog = owner.page.getByRole("dialog", { name: "Actualizamos los términos" })
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole("link", { name: "Contrato de encargo de tratamiento" }),
  ).toBeVisible()
  await owner.page.keyboard.press("Escape")
  await expect(dialog).toBeVisible()
  await owner.page.screenshot({ path: info.outputPath("3-actualizamos.png"), fullPage: true })
  await dialog.getByRole("checkbox", { name: /Leí y acepto/ }).check()
  await dialog.getByRole("button", { name: "Aceptar y seguir" }).click()
  await expect(dialog).toBeHidden()
  const accepted = await fixtureDb.execute(
    sql`select 1 from processing_agreement_acceptance where organization_id = ${owner.org.id}`,
  )
  expect(accepted.length).toBe(1)
  await gotoHydrated(owner.page, tenant(owner.org.slug, "/home"))
  await expect(owner.page.getByRole("heading", { name: "Inicio", level: 1 })).toBeVisible()
  await expect(owner.page.getByRole("dialog")).toHaveCount(0)
})
