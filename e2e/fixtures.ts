import { LEGAL } from "@odentia/auth/legal"
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { account, user as users } from "@odentia/db/schema/auth"
import { test as base, expect, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { hashPassword } from "better-auth/crypto"
import { API, PANEL } from "./env"
import { openFixtureDb } from "./fixture-db"
import { gotoHydrated } from "./hydration"

export { expect }
export type TestIdentity = { id: string; name: string; firstName: string; lastName: string; email: string; password: string }
export type OwnerFixture = {
  context: BrowserContext
  page: Page
  user: TestIdentity
  org: { id: string; name: string; slug: string }
  branchId: string
}

export async function api<T>(page: Page, method: string, path: string, slug: string | undefined, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ apiBase, method, path, slug, body }) => {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (slug) headers["x-odentia-org"] = slug
    const response = await fetch(`${apiBase}${path}`, {
      method, headers, credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as T }
  }, { apiBase: API, method, path, slug, body })
}

export async function call<T>(page: Page, method: string, path: string, slug: string | undefined, body?: unknown, expected = 200): Promise<T> {
  const result = await api<{ data: T }>(page, method, path, slug, body)
  expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBe(expected)
  return result.body.data
}

const PASSWORD = "e2e-secreto-123"
type TestFixtures = { createOwner: (tag: string) => Promise<OwnerFixture>; owner: OwnerFixture }
type WorkerFixtures = { fixtureDb: Db; passwordHash: string; nextEventId: () => number }

export const test = base.extend<TestFixtures, WorkerFixtures>({
  fixtureDb: [async ({}, use) => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("Ejecuta pnpm e2e para crear un entorno aislado")
    const connection = openFixtureDb(url)
    try { await use(connection.db) } finally { await connection.close() }
  }, { scope: "worker" }],
  passwordHash: [async ({}, use) => { await use(await hashPassword(PASSWORD)) }, { scope: "worker" }],
  nextEventId: [async ({}, use, workerInfo) => {
    let counter = 0
    await use(() => {
      if (++counter >= 1_000_000) throw new Error("Se agotaron los IDs de eventos del worker")
      return (workerInfo.workerIndex + 1) * 1_000_000 + counter
    })
  }, { scope: "worker" }],
  createOwner: async ({ browser, fixtureDb, passwordHash }, use) => {
    const contexts: BrowserContext[] = []
    try {
      await use(async (tag) => {
        const id = randomUUID()
        const user: TestIdentity = {
          id, firstName: "Ana", lastName: "Pruebas", name: "Ana Pruebas",
          email: `${tag}-${id}@test.dev`, password: PASSWORD,
        }
        await fixtureDb.transaction(async tx => {
          await tx.insert(users).values({ id, name: user.name, firstName: user.firstName, lastName: user.lastName, email: user.email, emailVerified: true,
            // Ya aceptó los documentos vigentes; su clínica copia el contrato de encargo al crearse.
            termsVersion: LEGAL.terms.version, termsAcceptedAt: new Date(),
            processingAgreementVersion: LEGAL.agreement.version, processingAgreementAcceptedAt: new Date() })
          await tx.insert(account).values({ id: randomUUID(), accountId: id, userId: id, providerId: "credential", password: passwordHash, updatedAt: new Date() })
        })
        const context = await browser.newContext({ baseURL: PANEL, ignoreHTTPSErrors: true })
        contexts.push(context)
        const page = await context.newPage()
        await gotoHydrated(page, `${PANEL}/login`)
        const signedIn = await api<{ user: { id: string } }>(page, "POST", "/api/auth/sign-in/email", undefined, { email: user.email, password: user.password })
        expect(signedIn.status).toBe(200)
        expect(signedIn.body.user.id).toBe(id)
        const session = await api<{ user: { id: string } }>(page, "GET", "/api/auth/get-session", undefined)
        expect(session.status).toBe(200)
        expect(session.body.user.id).toBe(id)
        const org = { id: "", name: `Clínica ${tag} ${id}`, slug: `${tag}-${id}` }
        const created = await api<{ id: string }>(page, "POST", "/api/auth/organization/create", undefined, { name: org.name, slug: org.slug })
        expect(created.status).toBe(200)
        expect(typeof created.body.id).toBe("string")
        org.id = created.body.id
        const active = await api<{ id: string }>(page, "POST", "/api/auth/organization/set-active", undefined, { organizationId: org.id })
        expect(active.status).toBe(200)
        expect(active.body.id).toBe(org.id)
        await call(page, "PUT", "/api/org-profile", org.slug, { legalName: `${org.name} S.A.C.`, countryCode: "PE" })
        const branch = await call<{ id: string }>(page, "POST", "/api/branches", org.slug, { name: "Sede Central" }, 201)
        return { context, page, user, org, branchId: branch.id }
      })
    } finally {
      const results = await Promise.allSettled(contexts.map(context => context.close()))
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, "No se pudieron cerrar los contextos de prueba")
    }
  },
  owner: async ({ createOwner }, use) => { await use(await createOwner("owner")) },
})

/**
 * Llena «Nombres» y «Apellidos» del registro (ADR 0058): la primera palabra
 * son los nombres y el resto los apellidos; el nombre visible se compone.
 */
export async function fillPatientNames(scope: Page | Locator, fullName: string) {
  const [given, ...rest] = fullName.trim().split(/\s+/)
  await scope.getByLabel(/^Nombres/).fill(given ?? "")
  await scope.getByLabel(/^Apellidos/).fill(rest.join(" "))
}

/**
 * Elige una opción del selector unificado de la interfaz (`ChoiceSelect` y
 * `Select` de @odentia/ui): por valor (`data-value`) o por texto visible.
 */
export async function chooseOption(trigger: Locator, choice: string | { label: string }) {
  await trigger.click()
  const page = trigger.page()
  const option =
    typeof choice === "string"
      ? page.locator(`[role="option"][data-value="${choice}"]`)
      : page.getByRole("option", { name: choice.label, exact: true })
  await option.click()
}

/**
 * Una fecha ISO (`1990-04-11`) como la escribe una persona en una clínica de
 * Perú, que es la de las pruebas: día/mes/año (`11/04/1990`). El campo
 * («Fecha de nacimiento») la guarda en ISO.
 */
export function writtenDate(iso: string): string {
  const [year, month, day] = iso.split("-")
  return `${day}/${month}/${year}`
}

/**
 * Elige un día con el control «Día» (`DatePickerButton`): abre el calendario,
 * pone el año y el mes en sus listas y toca el día. `iso` es `yyyy-mm-dd`.
 */
export async function chooseDay(trigger: Locator, iso: string) {
  await trigger.click()
  const page = trigger.page()
  const [year = 0, month = 1, date = 1] = iso.split("-").map(Number)
  const calendar = page.locator('[data-slot="calendar"]').last()
  await calendar.getByRole("combobox", { name: "Elegir el año" }).selectOption(String(year))
  await calendar.getByRole("combobox", { name: "Elegir el mes" }).selectOption(String(month - 1))
  // Cada día lleva su fecha como la escribe el navegador en español («15/6/2018»).
  const key = await page.evaluate(
    ([y, m, d]) => new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).toLocaleDateString("es"),
    [year, month, date],
  )
  await calendar.locator(`button[data-day="${key}"]`).click()
}
