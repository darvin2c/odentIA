/**
 * El armazón de gestorIA (paso B1 del lienzo B), contra una base real y un token firmado como
 * el de la cuenta: entrar, crear la tienda, invitar y los permisos de cada rol; la copia de las
 * cuentas con los avisos firmados y la revisión diaria.
 */
import { accountCopy, storeEvent, storeMember } from "@gestoria/db"
import { startTestDb, type TestDb } from "@gestoria/db/testing"
import { eq, sql } from "drizzle-orm"
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "./app.js"
import { type AccountConfig, reviewAccountCopies } from "./cuenta.js"
import { signMessage } from "./firma.js"
import { seedDemoStore } from "./semilla.js"

const ACCOUNT = "https://api.gestoria.test"
const WEB = "https://app.gestoria.test"
const SECRET = `whsec_${Buffer.alloc(32, 4).toString("base64")}`

let db: TestDb
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let jwk: JWK
let app: ReturnType<typeof createApp>
let asked: string[][] = []
let accountAnswer: (ids: string[]) => unknown = (ids) => ({
  accounts: ids.map((userId) => ({ userId, found: false })),
})
let accountDown = false

const fakeAccount = (async (_url: URL, init: RequestInit) => {
  if (accountDown) return new Response(null, { status: 502 })
  const ids = (JSON.parse(String(init.body)) as { userIds: string[] }).userIds
  asked.push(ids)
  return Response.json(accountAnswer(ids))
}) as unknown as typeof fetch

function config(): AccountConfig {
  return {
    url: ACCOUNT,
    eventsSecret: SECRET,
    keys: createLocalJWKSet({ keys: [jwk] }),
    fetch: fakeAccount,
  }
}

beforeAll(async () => {
  db = await startTestDb()
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  privateKey = pair.privateKey
  jwk = { ...(await exportJWK(pair.publicKey)), alg: "EdDSA", kid: "k1" }
  app = createApp({ appDb: db.appDb, ownerDb: db.ownerDb, account: config(), webURL: WEB })
})

afterAll(async () => {
  await db?.stop()
})

/** Un token como el de la cuenta en la entrada de gestorIA. */
async function tokenFor(
  userId: string,
  email: string,
  name: string,
  extra: { audience?: string; issuer?: string; iat?: number; emailVerified?: boolean } = {},
) {
  const iat = extra.iat ?? Math.floor(Date.now() / 1000)
  return new SignJWT({ email, emailVerified: extra.emailVerified ?? true, name, image: null })
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setSubject(userId)
    .setIssuer(extra.issuer ?? ACCOUNT)
    .setAudience(extra.audience ?? "gestoria")
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900)
    .sign(privateKey)
}

const people = {
  rosa: { id: "u-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  mario: { id: "u-mario", email: "mario@calzados.test", name: "Mario Huamán" },
  lucia: { id: "u-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
  ajena: { id: "u-ajena", email: "ajena@otra.test", name: "Ajena" },
  dueno: { id: "u-dueno", email: "dueno@polos.test", name: "Dueño Único" },
  admin: { id: "u-admin", email: "admin@polos.test", name: "Admin Polos" },
  nueva: { id: "u-nueva", email: "nueva@polos.test", name: "Nueva" },
}
type Who = keyof typeof people

async function call(who: Who | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: WEB }
  if (who) {
    const p = people[who]
    headers.authorization = `Bearer ${await tokenFor(p.id, p.email, p.name)}`
  }
  const response = await app.request(`https://servidor.gestoria.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  // biome-ignore lint/suspicious/noExplicitAny: las pruebas leen respuestas JSON de forma libre
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, any>) : {} }
}

let storeId = ""

describe("entrar con la cuenta", () => {
  it("sin token, con un token de otra app o vencido, no entra; con el de la cuenta, sí y queda su copia", async () => {
    expect((await call(null, "GET", "/api/yo")).status).toBe(401)
    for (const extra of [
      { audience: "odentia" },
      { issuer: "https://api.odentia.test" },
      { iat: Math.floor(Date.now() / 1000) - 3600 },
      { emailVerified: false },
    ]) {
      const token = await tokenFor("u-rosa", "rosa@calzados.test", "Rosa", extra)
      const response = await app.request("https://servidor.gestoria.test/api/yo", {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.status, JSON.stringify(extra)).toBe(401)
    }
    const me = await call("rosa", "GET", "/api/yo")
    expect(me.status).toBe(200)
    expect(me.json).toMatchObject({
      person: { userId: "u-rosa", email: "rosa@calzados.test" },
      stores: [],
      invitations: [],
    })
    const [copy] = await db.ownerDb
      .select()
      .from(accountCopy)
      .where(eq(accountCopy.userId, "u-rosa"))
    expect(copy).toMatchObject({
      name: "Rosa Quispe",
      email: "rosa@calzados.test",
      state: "activa",
    })
  })

  it("una copia vista hace rato, con la hora de la base en microsegundos, se pone al día sin colgarse", async () => {
    await db.ownerDb.execute(
      sql`insert into account_copy (user_id, name, email, state_changed_at, seen_at)
          values ('u-vieja', 'Vieja', 'vieja@calzados.test', now() - interval '1 day 0.000123 seconds', now() - interval '1 day')`,
    )
    const token = await tokenFor("u-vieja", "vieja@calzados.test", "Vieja")
    const response = await app.request("https://servidor.gestoria.test/api/yo", {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    // No se queda: la revisión diaria de más abajo cuenta las copias.
    await db.ownerDb.execute(sql`delete from account_copy where user_id = 'u-vieja'`)
  })

  it("CORS solo deja llamar a la app de gestorIA", async () => {
    const preflight = (origin: string) =>
      app.request("https://servidor.gestoria.test/api/yo", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      })
    expect((await preflight(WEB)).headers.get("access-control-allow-origin")).toBe(WEB)
    expect(
      (await preflight("https://app.odentia.test")).headers.get("access-control-allow-origin"),
    ).toBeNull()
  })
})

describe("crear la tienda e invitar al equipo", () => {
  it("quien crea la tienda es su Dueño y la elige al entrar", async () => {
    expect(
      (await call("rosa", "POST", "/api/tiendas", { name: " ", currency: "PEN" })).json.error
        .fields,
    ).toHaveProperty("name")
    expect(
      (await call("rosa", "POST", "/api/tiendas", { name: "Calzados", currency: "XYZ" })).status,
    ).toBe(400)
    const created = await call("rosa", "POST", "/api/tiendas", {
      name: "Calzados Rosa",
      currency: "pen",
    })
    expect(created.status).toBe(201)
    expect(created.json.store).toMatchObject({
      name: "Calzados Rosa",
      currency: "PEN",
      role: "owner",
    })
    storeId = created.json.store.id
    const me = await call("rosa", "GET", "/api/yo")
    expect(me.json.stores).toEqual([
      expect.objectContaining({
        id: storeId,
        role: "owner",
        permissions: expect.arrayContaining(["plan"]),
      }),
    ])
  })

  it("invita por correo; solo la cuenta de ese correo acepta", async () => {
    const invited = await call("rosa", "POST", `/api/tiendas/${storeId}/invitaciones`, {
      email: "Mario@Calzados.test",
      role: "admin",
    })
    expect(invited.status).toBe(201)
    expect(invited.json.invitation.link).toBe(`${WEB}/invitacion/${invited.json.invitation.id}`)
    // Mario la ve al entrar, con el nombre de la tienda y de quien lo invitó.
    const forMario = await call("mario", "GET", "/api/yo")
    expect(forMario.json.invitations).toEqual([
      expect.objectContaining({
        id: invited.json.invitation.id,
        storeName: "Calzados Rosa",
        invitedBy: "Rosa Quispe",
        role: "admin",
      }),
    ])
    // Con otra cuenta, el enlace no sirve.
    expect(
      (await call("ajena", "POST", `/api/invitaciones/${invited.json.invitation.id}/aceptar`))
        .status,
    ).toBe(404)
    expect(
      (await call("mario", "POST", `/api/invitaciones/${invited.json.invitation.id}/aceptar`)).json,
    ).toEqual({ storeId })
    // Ya usada, no vuelve a servir.
    expect(
      (await call("mario", "POST", `/api/invitaciones/${invited.json.invitation.id}/aceptar`))
        .status,
    ).toBe(404)
    const team = await call("rosa", "GET", `/api/tiendas/${storeId}/equipo`)
    expect(team.json.members).toEqual([
      expect.objectContaining({ userId: "u-mario", role: "admin", name: "Mario Huamán" }),
      expect.objectContaining({ userId: "u-rosa", role: "owner" }),
    ])
    const [added] = await db.ownerDb
      .select()
      .from(storeMember)
      .where(eq(storeMember.userId, "u-mario"))
    expect(added?.addedBy).toBe("u-rosa")
  })

  it("invitar otra vez al mismo correo renueva la invitación; a alguien del equipo, no", async () => {
    const first = await call("mario", "POST", `/api/tiendas/${storeId}/invitaciones`, {
      email: "lucia@calzados.test",
      role: "sales",
    })
    const again = await call("mario", "POST", `/api/tiendas/${storeId}/invitaciones`, {
      email: "lucia@calzados.test",
      role: "sales",
    })
    expect(again.status).toBe(201)
    expect(again.json.invitation.id).not.toBe(first.json.invitation.id)
    const team = await call("mario", "GET", `/api/tiendas/${storeId}/equipo`)
    expect(team.json.invitations).toEqual([
      expect.objectContaining({ id: again.json.invitation.id, email: "lucia@calzados.test" }),
    ])
    expect(
      (
        await call("mario", "POST", `/api/tiendas/${storeId}/invitaciones`, {
          email: "rosa@calzados.test",
          role: "sales",
        })
      ).status,
    ).toBe(409)
    expect(
      (await call("lucia", "POST", `/api/invitaciones/${first.json.invitation.id}/aceptar`)).status,
    ).toBe(404)
    expect(
      (await call("lucia", "POST", `/api/invitaciones/${again.json.invitation.id}/aceptar`)).status,
    ).toBe(200)
  })
})

describe("los permisos de cada rol (decisión 7)", () => {
  it("Ventas atiende pero no toca el equipo; el Administrador no toca al Dueño", async () => {
    const lucia = await call("lucia", "GET", `/api/tiendas/${storeId}`)
    expect(lucia.json.store.permissions).toEqual([
      "tienda.ver",
      "equipo.ver",
      "catalogo.ver",
      "ventas.atender",
      "pagos.confirmar",
      "entregas",
    ])
    expect((await call("lucia", "GET", `/api/tiendas/${storeId}/equipo`)).status).toBe(200)
    expect(
      (
        await call("lucia", "POST", `/api/tiendas/${storeId}/invitaciones`, {
          email: "x@calzados.test",
          role: "sales",
        })
      ).status,
    ).toBe(403)
    expect((await call("lucia", "DELETE", `/api/tiendas/${storeId}/equipo/u-mario`)).status).toBe(
      403,
    )

    const mario = await call("mario", "GET", `/api/tiendas/${storeId}`)
    expect(mario.json.store.permissions).not.toContain("plan")
    expect(
      (
        await call("mario", "POST", `/api/tiendas/${storeId}/invitaciones`, {
          email: "x@calzados.test",
          role: "owner",
        })
      ).status,
    ).toBe(403)
    expect(
      (await call("mario", "PATCH", `/api/tiendas/${storeId}/equipo/u-rosa`, { role: "sales" }))
        .status,
    ).toBe(403)
    expect((await call("mario", "DELETE", `/api/tiendas/${storeId}/equipo/u-rosa`)).status).toBe(
      403,
    )
    expect(
      (await call("mario", "PATCH", `/api/tiendas/${storeId}/equipo/u-lucia`, { role: "owner" }))
        .status,
    ).toBe(403)
    expect(
      (await call("mario", "PATCH", `/api/tiendas/${storeId}/equipo/u-lucia`, { role: "admin" }))
        .status,
    ).toBe(204)
    expect(
      (await call("mario", "PATCH", `/api/tiendas/${storeId}/equipo/u-lucia`, { role: "sales" }))
        .status,
    ).toBe(204)
  })

  it("la tienda nunca se queda sin dueño", async () => {
    const lastOwner = await call("rosa", "PATCH", `/api/tiendas/${storeId}/equipo/u-rosa`, {
      role: "admin",
    })
    expect(lastOwner.status).toBe(409)
    expect(lastOwner.json.error.code).toBe("LAST_OWNER")
    expect((await call("rosa", "DELETE", `/api/tiendas/${storeId}/equipo/u-rosa`)).status).toBe(409)
    // Antes de cerrar su cuenta, la pantalla sabe que Rosa es la única con el rol de Dueño.
    expect((await call("rosa", "GET", "/api/yo")).json.stores).toEqual([
      expect.objectContaining({ id: storeId, role: "owner", onlyOwner: true }),
    ])
    expect((await call("mario", "GET", "/api/yo")).json.stores).toEqual([
      expect.objectContaining({ id: storeId, onlyOwner: false }),
    ])
  })

  it("quien no es del equipo no sabe si la tienda existe", async () => {
    expect((await call("ajena", "GET", `/api/tiendas/${storeId}`)).status).toBe(404)
    expect((await call("ajena", "GET", `/api/tiendas/${storeId}/equipo`)).status).toBe(404)
    expect((await call("ajena", "GET", "/api/tiendas/no-es-un-id")).status).toBe(404)
  })

  it("cada cambio del equipo queda anotado con quién lo hizo", async () => {
    const events = await db.ownerDb.select().from(storeEvent).where(eq(storeEvent.storeId, storeId))
    expect(events.map((e) => `${e.action}:${e.actorUserId}`)).toEqual(
      expect.arrayContaining([
        "tienda.creada:u-rosa",
        "invitacion.creada:u-rosa",
        "invitacion.aceptada:u-mario",
        "equipo.rol:u-mario",
      ]),
    )
  })
})

describe("la copia de las cuentas", () => {
  const notice = (id: string, type: string, userId: string, secret = SECRET) => {
    const body = JSON.stringify({ type, timestamp: new Date().toISOString(), data: { userId } })
    return app.request("https://servidor.gestoria.test/avisos/cuenta", {
      method: "POST",
      headers: { "content-type": "application/json", ...signMessage({ secret, id, body }) },
      body,
    })
  }

  it("firma como la especificación de Standard Webhooks", () => {
    const spec = signMessage({
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      body: '{"test": 2432232314}',
      timestamp: 1614265330,
    })
    expect(spec["webhook-signature"]).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=")
  })

  it("al cerrarse una cuenta, sale de sus equipos y no entra; un aviso repetido no se aplica dos veces", async () => {
    expect(
      (
        await notice(
          "evt-falso",
          "cuenta.cerrada",
          "u-lucia",
          `whsec_${Buffer.alloc(32, 9).toString("base64")}`,
        )
      ).status,
    ).toBe(401)
    expect((await notice("evt-1", "cuenta.cerrada", "u-lucia")).status).toBe(200)
    expect((await notice("evt-1", "cuenta.cerrada", "u-lucia")).status).toBe(200)
    const [copy] = await db.ownerDb
      .select()
      .from(accountCopy)
      .where(eq(accountCopy.userId, "u-lucia"))
    expect(copy?.state).toBe("cerrada")
    const team = await call("rosa", "GET", `/api/tiendas/${storeId}/equipo`)
    expect(team.json.members.map((m: { userId: string }) => m.userId)).not.toContain("u-lucia")
    const closures = await db.ownerDb
      .select()
      .from(storeEvent)
      .where(eq(storeEvent.action, "cuenta.cerrada"))
    expect(closures).toHaveLength(1)
    // Con un token de antes del cierre, no entra.
    const before = await tokenFor("u-lucia", "lucia@calzados.test", "Lucía", {
      iat: Math.floor(Date.now() / 1000) - 60,
    })
    const response = await app.request("https://servidor.gestoria.test/api/yo", {
      headers: { authorization: `Bearer ${before}` },
    })
    expect(response.status).toBe(403)
    // Un aviso de alguien que nunca usó gestorIA se recibe y no hace nada.
    expect((await notice("evt-2", "cuenta.cerrada", "u-desconocida")).status).toBe(200)
  })

  it("un token emitido después del cierre prueba que la cuenta volvió a abrirse", async () => {
    const later = await tokenFor("u-lucia", "lucia@calzados.test", "Lucía", {
      iat: Math.floor(Date.now() / 1000) + 2,
    })
    const response = await app.request("https://servidor.gestoria.test/api/yo", {
      headers: { authorization: `Bearer ${later}` },
    })
    expect(response.status).toBe(200)
    // Volvió sin tiendas: su lugar en el equipo se perdió con el cierre.
    expect(((await response.json()) as { stores: unknown[] }).stores).toEqual([])
  })

  it("otro aviso de la cuenta se resuelve preguntándole lo vigente de esa persona", async () => {
    asked = []
    accountAnswer = (ids) => ({
      accounts: ids.map((userId) => ({
        userId,
        found: true,
        blocked: true,
        name: "Mario H.",
        email: "mario@calzados.test",
        emailVerified: true,
        image: null,
      })),
    })
    expect((await notice("evt-3", "cuenta.bloqueada", "u-mario")).status).toBe(200)
    expect(asked).toEqual([["u-mario"]])
    const [copy] = await db.ownerDb
      .select()
      .from(accountCopy)
      .where(eq(accountCopy.userId, "u-mario"))
    expect(copy).toMatchObject({ state: "bloqueada", name: "Mario H." })
    // Bloqueado no se le saca del equipo, pero no entra.
    expect(
      await db.ownerDb.select().from(storeMember).where(eq(storeMember.userId, "u-mario")),
    ).toHaveLength(1)
    const before = await tokenFor("u-mario", "mario@calzados.test", "Mario", {
      iat: Math.floor(Date.now() / 1000) - 60,
    })
    expect(
      (
        await app.request("https://servidor.gestoria.test/api/yo", {
          headers: { authorization: `Bearer ${before}` },
        })
      ).status,
    ).toBe(403)
    // Si la cuenta no responde, el aviso falla y la cuenta lo reintenta.
    accountDown = true
    expect((await notice("evt-4", "cuenta.reabierta", "u-mario")).status).toBe(503)
    accountDown = false
  })

  it("la revisión diaria pone al día cada copia una vez al día, y no toca la que la cuenta no conoce", async () => {
    asked = []
    accountAnswer = (ids) => ({
      accounts: ids.map((userId) =>
        userId === "u-rosa"
          ? {
              userId,
              found: true,
              blocked: false,
              name: "Rosa Q. de Torres",
              email: "rosa@calzados.test",
              emailVerified: true,
              image: null,
            }
          : userId === "u-mario"
            ? {
                userId,
                found: true,
                blocked: false,
                name: "Mario Huamán",
                email: "mario@calzados.test",
                emailVerified: true,
                image: null,
              }
            : {
                userId,
                found: false,
                blocked: false,
                name: null,
                email: null,
                emailVerified: false,
                image: null,
              },
      ),
    })
    const run = await reviewAccountCopies(db.ownerDb, config())
    expect(run.failed).toBe(false)
    // Mario se revisó hoy con su aviso: no se pregunta otra vez. La cerrada tampoco.
    expect(asked.flat().sort()).toEqual(["u-ajena", "u-lucia", "u-rosa"])
    const copies = await db.ownerDb.select().from(accountCopy)
    const byId = Object.fromEntries(copies.map((c) => [c.userId, c]))
    expect(byId["u-rosa"]?.name).toBe("Rosa Q. de Torres")
    expect(byId["u-mario"]?.state).toBe("bloqueada")
    expect(byId["u-ajena"]?.state).toBe("activa")
    // En el mismo día no vuelve a preguntar.
    asked = []
    expect((await reviewAccountCopies(db.ownerDb, config())).reviewed).toBe(0)
    expect(asked).toEqual([])
  })
})

describe("cuando quien manda deja de poder", () => {
  it("al cerrar su cuenta el único Dueño, el Administrador más antiguo pasa a Dueño y sus invitaciones se anulan", async () => {
    const created = await call("dueno", "POST", "/api/tiendas", { name: "Polos", currency: "PEN" })
    const polos = created.json.store.id as string
    const toAdmin = await call("dueno", "POST", `/api/tiendas/${polos}/invitaciones`, {
      email: "admin@polos.test",
      role: "admin",
    })
    expect(
      (await call("admin", "POST", `/api/invitaciones/${toAdmin.json.invitation.id}/aceptar`))
        .status,
    ).toBe(200)
    const toNew = await call("dueno", "POST", `/api/tiendas/${polos}/invitaciones`, {
      email: "nueva@polos.test",
      role: "owner",
    })
    const body = JSON.stringify({
      type: "cuenta.cerrada",
      timestamp: new Date().toISOString(),
      data: { userId: "u-dueno" },
    })
    const closed = await app.request("https://servidor.gestoria.test/avisos/cuenta", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signMessage({ secret: SECRET, id: "evt-dueno", body }),
      },
      body,
    })
    expect(closed.status).toBe(200)
    const team = await call("admin", "GET", `/api/tiendas/${polos}/equipo`)
    expect(team.json.members).toEqual([
      expect.objectContaining({ userId: "u-admin", role: "owner" }),
    ])
    expect(team.json.invitations).toEqual([])
    expect(
      (await call("nueva", "POST", `/api/invitaciones/${toNew.json.invitation.id}/aceptar`)).status,
    ).toBe(404)
  })

  it("si quien invitó ya no puede dar ese rol, su invitación no vale", async () => {
    const created = await call("admin", "GET", "/api/yo")
    const polos = (created.json.stores as { id: string; name: string }[]).find(
      (s) => s.name === "Polos",
    )!.id
    // Un Administrador invita como Ventas y después lo quitan del equipo.
    const first = await call("admin", "POST", `/api/tiendas/${polos}/invitaciones`, {
      email: "nueva@polos.test",
      role: "admin",
    })
    expect(
      (await call("nueva", "POST", `/api/invitaciones/${first.json.invitation.id}/aceptar`)).status,
    ).toBe(200)
    const byNew = await call("nueva", "POST", `/api/tiendas/${polos}/invitaciones`, {
      email: "ajena@otra.test",
      role: "sales",
    })
    expect((await call("admin", "DELETE", `/api/tiendas/${polos}/equipo/u-nueva`)).status).toBe(204)
    expect(
      (await call("ajena", "POST", `/api/invitaciones/${byNew.json.invitation.id}/aceptar`)).status,
    ).toBe(404)
  })
})

describe("la tienda de ejemplo", () => {
  it("Calzados Rosa se siembra con su equipo y una invitación para quien la va a usar", async () => {
    await seedDemoStore(db.ownerDb, "Yo@Ejemplo.test")
    await seedDemoStore(db.ownerDb, "yo@ejemplo.test")
    const token = await tokenFor("u-yo", "yo@ejemplo.test", "Yo")
    const me = await app.request("https://servidor.gestoria.test/api/yo", {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = (await me.json()) as { invitations: { storeName: string; role: string }[] }
    expect(body.invitations).toEqual([
      expect.objectContaining({ storeName: "Calzados Rosa", role: "owner" }),
    ])
  })
})

describe("antes de cerrar la cuenta", () => {
  it("con dos Dueños, ninguno es el único; con uno solo, sí", async () => {
    const created = await call("ajena", "POST", "/api/tiendas", {
      name: "Dos Dueños",
      currency: "PEN",
    })
    const id = created.json.store.id as string
    const onlyOwner = async (who: Who) =>
      (
        (await call(who, "GET", "/api/yo")).json.stores as { id: string; onlyOwner: boolean }[]
      ).find((s) => s.id === id)?.onlyOwner
    expect(await onlyOwner("ajena")).toBe(true)
    const invited = await call("ajena", "POST", `/api/tiendas/${id}/invitaciones`, {
      email: "nueva@polos.test",
      role: "owner",
    })
    expect(
      (await call("nueva", "POST", `/api/invitaciones/${invited.json.invitation.id}/aceptar`))
        .status,
    ).toBe(200)
    expect(await onlyOwner("ajena")).toBe(false)
    expect(await onlyOwner("nueva")).toBe(false)
  })
})
