import { withOrgContext } from "@odentia/db"
import { supportCase, supportMessage } from "@odentia/db/schema/admin-support"
import { member, user } from "@odentia/db/schema/auth"
import { auditEvent } from "@odentia/db/schema/org"
import { channelConnection, type ConnectionSignup } from "@odentia/db/schema/crm"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { decryptConfig, describeAuditEvent, encryptJson, listWorkspaceNotifications } from "@odentia/services"
import { and, eq, like } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { runSignupTokenTick } from "./whatsapp-tokens.js"
import { appDb, KEY, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

beforeAll(async () => {
  // Quien administra las integraciones (la dueña) y alguien de recepción, que no las administra.
  await ownerDb.insert(user).values([
    { id: "w-duena", name: "Ana Torres", email: "ana@tokens.test", emailVerified: true },
    { id: "w-recepcion", name: "Luis Prado", email: "luis@tokens.test", emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: "m-duena", userId: "w-duena", organizationId: "org_a", role: "owner", createdAt: new Date() },
    { id: "m-recepcion", userId: "w-recepcion", organizationId: "org_a", role: "reception", createdAt: new Date() },
  ])
})

/** Los avisos de la campana sobre la clave de una conexión, de quien los recibió. */
async function noticesOf(connectionId: string) {
  return ownerDb
    .select({ userId: workspaceNotification.userId, title: workspaceNotification.title, body: workspaceNotification.body, href: workspaceNotification.href, permission: workspaceNotification.permission, resolvedAt: workspaceNotification.resolvedAt })
    .from(workspaceNotification)
    .where(eq(workspaceNotification.subject, `clave-meta:${connectionId}`))
}

/** Los casos automáticos «Clave de Meta sin renovar» con sus mensajes. */
async function supportCases() {
  const cases = await ownerDb.select().from(supportCase).where(like(supportCase.dedupeKey, "clave-meta-sin-renovar:%"))
  const messages = await ownerDb.select({ caseId: supportMessage.caseId, body: supportMessage.body }).from(supportMessage)
  return cases.map((row) => ({ ...row, lines: messages.filter((m) => m.caseId === row.id).map((m) => m.body) }))
}

const APP = { appId: "APP1", appSecret: "secreto-de-la-app", graphVersion: "v25.0" }
const DAY = 86_400_000
const SIXTY_DAYS_S = 60 * 86_400

const signupOf = (extra: Partial<ConnectionSignup>): ConnectionSignup => ({
  grantedAt: "2026-09-01T12:00:00.000Z",
  subscribedAt: "2026-09-01T12:00:05.000Z",
  registeredAt: "2026-09-01T12:00:09.000Z",
  problems: {},
  ...extra,
})

async function connection(name: string, token: string, signup: ConnectionSignup | null, status = "active") {
  const [row] = await ownerDb
    .insert(channelConnection)
    .values({
      organizationId: "org_a",
      channel: "whatsapp",
      provider: "whatsapp_cloud_api",
      displayName: `WhatsApp ${name}`,
      externalId: `pn-${name}`,
      configEncrypted: encryptJson(KEY, { phoneNumberId: `pn-${name}`, wabaId: `waba-${name}`, accessToken: token, registrationPin: "123456" }),
      webhookSecret: crypto.randomUUID(),
      status,
      signup,
      accountExternalId: signup ? `waba-${name}` : null,
    })
    .returning({ id: channelConnection.id })
  return row!.id
}

async function stateOf(id: string) {
  const [row] = await ownerDb.select().from(channelConnection).where(eq(channelConnection.id, id))
  return { token: decryptConfig(KEY, row!.configEncrypted)["accessToken"], signup: row!.signup! }
}

/** Meta de prueba: responde por la clave que le llega. No acredita que Meta real lo acepte. */
function fakeMeta(now: Date, onRefresh: Record<string, () => Promise<unknown> | unknown> = {}) {
  const calls: string[] = []
  const at = (days: number) => Math.floor((now.getTime() + days * DAY) / 1000)
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url.pathname.endsWith("/debug_token")) {
      const token = url.searchParams.get("input_token") ?? ""
      calls.push(`revisar ${token}`)
      if (token === "C-VIGENTE") return json({ data: { is_valid: true, expires_at: at(50) } })
      if (token === "D-VIGENTE") return json({ data: { is_valid: true, expires_at: at(5) } })
      return json({ data: { is_valid: false, error: { code: 190 } } })
    }
    const token = url.searchParams.get("fb_exchange_token") ?? ""
    calls.push(`renovar ${token}`)
    const special = onRefresh[token]
    if (special) {
      const answer = await special()
      if (answer instanceof Response) return answer
    }
    return json({ access_token: `${token.split("-")[0]}-NUEVA`, token_type: "bearer", expires_in: SIXTY_DAYS_S })
  }) as typeof fetch
  return { calls, fetch: fetchImpl }
}

it("renueva sola la clave que vence pronto, pregunta la que no se sabe y deja intacta la que no toca", async () => {
  const now = new Date("2026-10-20T12:00:00Z")
  const soon = await connection("a", "A-VIGENTE", signupOf({ tokenExpiresAt: new Date(now.getTime() + 10 * DAY).toISOString() }))
  const later = await connection("b", "B-VIGENTE", signupOf({ tokenExpiresAt: new Date(now.getTime() + 40 * DAY).toISOString() }))
  const unknown = await connection("c", "C-VIGENTE", signupOf({}))
  const unknownSoon = await connection("d", "D-VIGENTE", signupOf({}))
  const never = await connection("f", "F-VIGENTE", signupOf({ tokenNeverExpires: true }))
  await connection("g", "G-A-MANO", null)
  await connection("h", "H-APAGADA", signupOf({ tokenExpiresAt: new Date(now.getTime() + 2 * DAY).toISOString() }), "disabled")
  const meta = fakeMeta(now)

  const result = await runSignupTokenTick(ownerDb, appDb, { app: APP, secretsKey: KEY, fetch: meta.fetch, now })

  expect(result).toEqual({ checked: 2, renewed: 2, errors: [] })
  // Solo se habla con Meta por las que tocan: ni la que falta, ni la que no vence, ni la hecha a mano, ni la apagada.
  expect(meta.calls.sort()).toEqual(["renovar A-VIGENTE", "renovar D-VIGENTE", "revisar C-VIGENTE", "revisar D-VIGENTE"])

  const renewed = await stateOf(soon)
  expect(renewed.token).toBe("A-NUEVA")
  expect(renewed.signup.tokenExpiresAt).toBe(new Date(now.getTime() + 60 * DAY).toISOString())
  expect(renewed.signup).toMatchObject({ tokenProblem: null, tokenNeverExpires: false, registeredAt: "2026-09-01T12:00:09.000Z" })
  expect((await stateOf(unknownSoon)).token).toBe("D-NUEVA")
  // La que no se sabía queda con su fecha, sin renovar todavía.
  expect(await stateOf(unknown)).toMatchObject({
    token: "C-VIGENTE",
    signup: { tokenExpiresAt: new Date(Math.floor((now.getTime() + 50 * DAY) / 1000) * 1000).toISOString() },
  })
  expect((await stateOf(later)).token).toBe("B-VIGENTE")
  expect((await stateOf(never)).token).toBe("F-VIGENTE")

  // Queda en la actividad de la clínica, como algo automático y sin la clave.
  const audits = await ownerDb
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.action, "whatsapp.token_renewed"), eq(auditEvent.entityId, soon)))
  expect(audits).toHaveLength(1)
  expect(audits[0]).toMatchObject({ organizationId: "org_a", actorUserId: null })
  expect(JSON.stringify(audits[0]!.metadata)).not.toContain("NUEVA")
  expect(describeAuditEvent("whatsapp.token_renewed")).toMatchObject({
    what: "Renovó con Meta la clave de WhatsApp antes de que venciera",
    author: "Automático",
    area: "configuracion",
  })

  // Lo que sale bien no avisa ni abre casos.
  expect(await noticesOf(soon)).toEqual([])
  expect(await supportCases()).toEqual([])

  // A la vuelta siguiente ya no toca ninguna: la renovada dura 60 días.
  const again = fakeMeta(now)
  expect(await runSignupTokenTick(ownerDb, appDb, { app: APP, secretsKey: KEY, fetch: again.fetch, now })).toEqual({ checked: 0, renewed: 0, errors: [] })
  expect(again.calls).toEqual([])
})

it("si Meta no la renueva, anota el motivo, conserva la clave y lo vuelve a intentar; si no responde, solo reintenta", async () => {
  const now = new Date("2026-10-20T12:00:00Z")
  const refused = await connection("e", "E-VIGENTE", signupOf({ tokenExpiresAt: new Date(now.getTime() + 3 * DAY).toISOString() }))
  const silent = await connection("j", "J-VIGENTE", signupOf({ tokenExpiresAt: new Date(now.getTime() + 3 * DAY).toISOString() }))
  const meta = fakeMeta(now, {
    "E-VIGENTE": () =>
      new Response(JSON.stringify({ error: { message: "Unsupported request", type: "OAuthException", code: 100 } }), { status: 400 }),
    "J-VIGENTE": () => {
      throw new TypeError("fetch failed")
    },
  })

  const result = await runSignupTokenTick(ownerDb, appDb, { app: APP, secretsKey: KEY, fetch: meta.fetch, now })
  expect(result.renewed).toBe(0)
  expect(result.errors).toHaveLength(2)
  expect(await stateOf(refused)).toMatchObject({
    token: "E-VIGENTE",
    signup: {
      tokenProblem:
        "Meta no renovó la clave: «Unsupported request». Se reintenta cada 12 horas mientras siga vigente; si vence, vuelve a conectar con Facebook.",
    },
  })
  // Meta no respondió: nada que anotar, se repite en la vuelta siguiente.
  expect((await stateOf(silent)).signup.tokenProblem).toBeUndefined()
  expect(await noticesOf(silent)).toEqual([])

  // La campana avisa a la dueña, no a recepción, sin lo que dijo Meta y con la fecha en que vence.
  expect(await noticesOf(refused)).toEqual([
    {
      userId: "w-duena",
      title: "WhatsApp no pudo renovar su conexión con Meta",
      body: "La conexión vence el 23 de octubre. odentIA lo sigue intentando y ya está avisado. Si llega esa fecha sin renovarse, vuelve a conectar con Facebook en Configuración › Integraciones › WhatsApp.",
      href: "/settings/integrations/whatsapp",
      permission: "settings.write",
      resolvedAt: null,
    },
  ])
  // Soporte de odentIA recibe el caso con lo que dijo Meta; la clínica no lo ve (sin organización).
  const [kase] = await supportCases()
  expect(kase).toMatchObject({
    organizationId: null,
    openedBy: null,
    question: "Clave de Meta sin renovar · Clínica",
    detail: "Meta (100): Unsupported request",
    screen: "/settings/integrations/whatsapp",
    dedupeKey: "clave-meta-sin-renovar:100",
  })
  expect(kase!.lines).toHaveLength(1)
  expect(kase!.lines[0]).toContain("Clínica [org_a] · WhatsApp (conexión")
  // Reintentar con el mismo motivo no repite el aviso ni el caso.
  await runSignupTokenTick(ownerDb, appDb, { app: APP, secretsKey: KEY, fetch: meta.fetch, now })
  expect(await noticesOf(refused)).toHaveLength(1)
  expect((await supportCases())[0]!.lines).toHaveLength(1)

  // Medio día después Meta sí la renueva: el motivo se borra.
  const later = new Date(now.getTime() + DAY / 2)
  const fixed = fakeMeta(later)
  await runSignupTokenTick(ownerDb, appDb, { app: APP, secretsKey: KEY, fetch: fixed.fetch, now: later })
  expect(fixed.calls.sort()).toEqual(["renovar E-VIGENTE", "renovar J-VIGENTE"])
  expect(await stateOf(refused)).toMatchObject({ token: "E-NUEVA", signup: { tokenProblem: null } })
  expect((await stateOf(silent)).token).toBe("J-NUEVA")
  // Renovada, el aviso se retira solo: ya no está en la campana de la dueña.
  expect((await noticesOf(refused))[0]!.resolvedAt).not.toBeNull()
  const bell = await withOrgContext(appDb, "org_a", (tx) => listWorkspaceNotifications(tx, "org_a", "w-duena", ["settings.write"]))
  expect(bell.items.map((item) => item.title)).not.toContain("WhatsApp no pudo renovar su conexión con Meta")
})

it("una clave vencida que Meta ya no acepta queda anotada y no se insiste; si la clínica vuelve a conectar mientras tanto, manda la suya", async () => {
  const now = new Date("2026-10-20T12:00:00Z")
  const dead = await connection("k", "K-VIEJA", signupOf({}))
  const raced = await connection("l", "L-VIGENTE", signupOf({ tokenExpiresAt: new Date(now.getTime() + 2 * DAY).toISOString() }))
  const meta = fakeMeta(now, {
    // Mientras Meta responde, la clínica vuelve a conectar con Facebook.
    "L-VIGENTE": async () => {
      await ownerDb
        .update(channelConnection)
        .set({ configEncrypted: encryptJson(KEY, { phoneNumberId: "pn-l", wabaId: "waba-l", accessToken: "L-DE-LA-CLINICA", registrationPin: "123456" }) })
        .where(eq(channelConnection.id, raced))
      return undefined
    },
  })

  await runSignupTokenTick(ownerDb, appDb, { app: APP, secretsKey: KEY, fetch: meta.fetch, now })
  expect(await stateOf(dead)).toMatchObject({
    token: "K-VIEJA",
    signup: { tokenProblem: "La clave que dio Meta ya no sirve: venció o la retiraron. Vuelve a conectar con Facebook para que los mensajes sigan saliendo." },
  })
  expect((await stateOf(raced)).token).toBe("L-DE-LA-CLINICA")
  expect(await noticesOf(dead)).toMatchObject([
    {
      userId: "w-duena",
      title: "La conexión de WhatsApp con Meta dejó de servir",
      body: "Los mensajes de WhatsApp no pueden salir. Vuelve a conectar con Facebook en Configuración › Integraciones › WhatsApp. Ya avisamos a odentIA.",
    },
  ])
  expect((await supportCases()).find((row) => row.dedupeKey === "clave-meta-sin-renovar:no-valida")).toMatchObject({
    question: "Clave de Meta sin renovar · Clínica",
  })
  // La reconexión que ganó no deja aviso.
  expect(await noticesOf(raced)).toEqual([])

  const again = fakeMeta(now)
  await runSignupTokenTick(ownerDb, appDb, { app: APP, secretsKey: KEY, fetch: again.fetch, now })
  expect(again.calls).not.toContain("revisar K-VIEJA")
})
