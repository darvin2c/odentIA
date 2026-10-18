/**
 * Términos (lienzo «Términos con Google»): cada persona acepta términos y
 * privacidad; el contrato de encargo lo acepta la clínica por quien la abre o
 * la administra. Quien entra con Google acepta después; el aviso de una versión
 * nueva sale una vez por persona.
 */
import { randomUUID } from "node:crypto"
import { AGREEMENT_VERSION, createAuth, LEGAL_VERSION } from "@odentia/auth"
import { type Db, withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { acceptClinicAgreement, claimLegalNotices, clinicAgreementAccepted } from "./legal.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const API = "http://localhost:3001/api/auth"
const PANEL = "http://localhost:3000"

function makeAuth() {
  return createAuth({
    db: ownerDb,
    ownerDb,
    mailer: { send: async () => {} },
    secret: "smoke-secret-que-supera-treinta-y-dos-bytes",
    baseURL: API,
    webURL: PANEL,
    cookieDomain: "localhost",
    trustedOrigins: [PANEL],
    googleClientId: "",
    googleClientSecret: "",
    passwordBreachCheck: false,
  })
}

function browser(auth: ReturnType<typeof makeAuth>) {
  const jar: Record<string, string> = {}
  const store = (res: Response) => {
    for (const setCookie of res.headers.getSetCookie()) {
      const pair = setCookie.split(";")[0] ?? ""
      const at = pair.indexOf("=")
      if (at > 0) jar[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
    }
  }
  const headers = () => ({
    origin: PANEL,
    cookie: Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; "),
  })
  return {
    async post(path: string, body: unknown) {
      const res = await auth.handler(
        new Request(`${API}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers() },
          body: JSON.stringify(body),
        }),
      )
      store(res)
      return res
    },
    async get(path: string) {
      const res = await auth.handler(new Request(`${API}${path}`, { headers: headers() }))
      store(res)
      return res
    },
  }
}

async function signedUp(auth: ReturnType<typeof makeAuth>, body: Record<string, unknown>) {
  const b = browser(auth)
  const email = `${randomUUID()}@legal.test`
  const res = await b.post("/sign-up/email", {
    name: "Carmen Ruiz",
    email,
    password: "una-clave-larga",
    ...body,
  })
  await ownerDb.execute(sql`update "user" set email_verified = true where email = ${email}`)
  await b.post("/sign-in/email", { email, password: "una-clave-larga" })
  return { b, email, res }
}

describe("términos", () => {
  it("quien abre una clínica acepta los tres; la clínica nace con el contrato de encargo", async () => {
    const auth = makeAuth()
    const { b, res } = await signedUp(auth, {
      termsVersion: LEGAL_VERSION,
      processingAgreementVersion: AGREEMENT_VERSION,
    })
    expect(res.status).toBeLessThan(300)
    expect(await (await b.get("/legal/status")).json()).toMatchObject({
      terms: { state: "ok" },
      agreement: { accepted: true },
    })
    const created = await b.post("/organization/create", {
      name: "Clínica Sonrisa",
      slug: `sonrisa-${randomUUID().slice(0, 8)}`,
    })
    const org = (await created.json()) as { id: string }
    const accepted = await withOrgContext(appDb as Db, org.id, (tx) =>
      clinicAgreementAccepted(tx, org.id, AGREEMENT_VERSION),
    )
    expect(accepted).toBe(true)
  }, 120_000)

  it("quien entra invitado acepta términos y privacidad; su clínica nueva pide el contrato aparte", async () => {
    const auth = makeAuth()
    const { b } = await signedUp(auth, { termsVersion: LEGAL_VERSION })
    expect(await (await b.get("/legal/status")).json()).toMatchObject({
      agreement: { accepted: false },
    })
    const created = await b.post("/organization/create", {
      name: "Clínica Andrea",
      slug: `andrea-${randomUUID().slice(0, 8)}`,
    })
    const org = (await created.json()) as { id: string; members?: { userId: string }[] }
    const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb as Db, org.id, fn)
    expect(await run((tx) => clinicAgreementAccepted(tx, org.id, AGREEMENT_VERSION))).toBe(false)
    const [me] = (await ownerDb.execute(
      sql`select user_id from member where organization_id = ${org.id}`,
    )) as unknown as {
      user_id: string
    }[]
    await run((tx) => acceptClinicAgreement(tx, org.id, me!.user_id, AGREEMENT_VERSION))
    await run((tx) => acceptClinicAgreement(tx, org.id, me!.user_id, AGREEMENT_VERSION))
    expect(await run((tx) => clinicAgreementAccepted(tx, org.id, AGREEMENT_VERSION))).toBe(true)
  }, 120_000)

  it("crear cuenta con correo sin aceptar no se puede; con Google se acepta después", async () => {
    const auth = makeAuth()
    const refused = browser(auth)
    const no = await refused.post("/sign-up/email", {
      name: "Sin",
      email: `${randomUUID()}@legal.test`,
      password: "una-clave-larga",
    })
    expect(no.status).toBe(400)

    // Una cuenta como las de Google: sin aceptación guardada.
    const { b, email } = await signedUp(auth, { termsVersion: LEGAL_VERSION })
    await ownerDb.execute(
      sql`update "user" set terms_version = null, terms_accepted_at = null where email = ${email}`,
    )
    expect(await (await b.get("/legal/status")).json()).toMatchObject({ terms: { state: "first" } })
    expect((await b.post("/legal/accept", { termsVersion: "2020-01-01" })).status).toBe(400)
    expect((await b.post("/legal/accept", { termsVersion: LEGAL_VERSION })).status).toBe(200)
    expect(await (await b.get("/legal/status")).json()).toMatchObject({
      terms: { state: "ok" },
      agreement: { accepted: false },
    })

    // Con una versión anterior aceptada, la vigente es una actualización.
    await ownerDb.execute(
      sql`update "user" set terms_version = '2026-01-01' where email = ${email}`,
    )
    expect(await (await b.get("/legal/status")).json()).toMatchObject({
      terms: { state: "updated" },
    })
  }, 120_000)

  it("el aviso de una versión nueva sale una vez y solo a quien aceptó una anterior", async () => {
    const before = randomUUID()
    const never = randomUUID()
    await ownerDb.insert(user).values([
      {
        id: before,
        name: "Rosa Quispe",
        email: `${before}@legal.test`,
        emailVerified: true,
        termsVersion: "2026-10-17",
      },
      { id: never, name: "Pedro Salas", email: `${never}@legal.test`, emailVerified: true },
    ])
    const first = await claimLegalNotices(ownerDb, "2027-03-01", 1000)
    expect(first.map((r) => r.userId)).toContain(before)
    expect(first.map((r) => r.userId)).not.toContain(never)
    const again = await claimLegalNotices(ownerDb, "2027-03-01", 1000)
    expect(again.map((r) => r.userId)).not.toContain(before)
  }, 60_000)
})
