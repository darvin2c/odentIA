import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { account, user as users } from "@odentia/db/schema/auth"
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test"
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
          await tx.insert(users).values({ id, name: user.name, firstName: user.firstName, lastName: user.lastName, email: user.email, emailVerified: true })
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
