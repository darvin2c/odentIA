/** «Mi calendario» (issue 46, ADR 0082): el enlace, lo que entrega y quién lo usa. */
import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { appointment, calendarFeed, calendarFeedUse, scheduleRoom } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import {
  acknowledgeCalendarClient,
  calendarClientOf,
  createMyCalendarFeed,
  findCalendarFeedOrg,
  getMyCalendarFeed,
  initialsOf,
  listTeamCalendarFeeds,
  revokeMyCalendarFeed,
  revokeTeamCalendarFeed,
  rotateMyCalendarFeed,
  serveCalendarFeed,
} from "./calendar-feeds.js"
import { nextPatientNumber } from "./patients.js"
import { configurePublicLinks } from "./public-links.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()
const KEY = secretsKeyFromEnv("ce".repeat(32))
const DEPS = { secretsKey: KEY, feedBaseUrl: "https://api.odentia.test" }
const DAY = 86_400_000
const GOOGLE = "Google-Calendar-Importer"
const IPHONE = "iOS/17.4 (21E219) dataaccessd/1.0"
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"

interface Clinic {
  orgId: string
  ownerId: string
  anaId: string
  luisId: string
  branchId: string
  roomId: string
}

async function clinic(): Promise<Clinic> {
  const orgId = randomUUID()
  const ownerId = `owner-${orgId}`
  const anaId = `ana-${orgId}`
  const luisId = `luis-${orgId}`
  await insertOrg(ownerDb, orgId, `cal-${orgId}`)
  await ownerDb.insert(user).values([
    { id: ownerId, name: "Dueña", email: `${ownerId}@cal.test`, emailVerified: true },
    { id: anaId, name: "Dra. Ana Torres", email: `${anaId}@cal.test`, emailVerified: true },
    { id: luisId, name: "Dr. Luis Ramos", email: `${luisId}@cal.test`, emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() },
    { id: `m-${anaId}`, userId: anaId, organizationId: orgId, role: "clinician", createdAt: new Date() },
    { id: `m-${luisId}`, userId: luisId, organizationId: orgId, role: "clinician", createdAt: new Date() },
  ])
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: orgId, name: "Centro", timezone: "America/Lima", addressLine1: "Av. José Larco 345", city: "Miraflores", country: "PE" })
    .returning({ id: branch.id })
  const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" }).returning({ id: scheduleRoom.id })
  return { orgId, ownerId, anaId, luisId, branchId: site!.id, roomId: room!.id }
}

const run = <T>(c: Clinic, fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, c.orgId, fn)

async function patientNamed(c: Clinic, givenNames: string, familyName: string) {
  const [row] = await insertTestPatients(ownerDb, {
    organizationId: c.orgId,
    displayName: `${givenNames} ${familyName}`,
    givenNames,
    familyName,
    patientNumber: await nextPatientNumber(ownerDb, c.orgId),
  })
  return row!.id
}

async function appointmentFor(c: Clinic, patientId: string, startsAt: Date, options: { status?: string; professionalUserId?: string } = {}) {
  const [row] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: c.orgId, branchId: c.branchId, patientId, professionalUserId: options.professionalUserId ?? c.anaId,
      roomId: c.roomId, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30,
      status: options.status ?? "programada", serviceName: "Endodoncia molar",
    })
    .returning({ id: appointment.id })
  return row!.id
}

/** El token del enlace, tal como va en la dirección. */
function tokenOf(url: string | null | undefined): string {
  const token = /\/calendar\/([0-9a-f]{64})\.ics$/.exec(url ?? "")?.[1]
  if (!token) throw new Error(`Sin token en ${url}`)
  return token
}

describe("Mi calendario", () => {
  it("las iniciales y el programa que pide el calendario", () => {
    expect(initialsOf({ givenNames: "Rosa María", familyName: "Pérez Quispe", displayName: "x" })).toBe("R. P.")
    expect(initialsOf({ givenNames: null, familyName: null, displayName: "jorge salas vega" })).toBe("J. V.")
    expect(calendarClientOf(GOOGLE)).toBe("google")
    expect(calendarClientOf(IPHONE)).toBe("iphone")
    expect(calendarClientOf("Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)")).toBe("outlook")
    expect(calendarClientOf(BROWSER)).toBe("navegador")
    expect(calendarClientOf(undefined)).toBe("otro")
  })

  it("entrega solo sus citas de hoy a 90 días, con iniciales y sin el servicio ni el nombre", async () => {
    configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
    try {
      const c = await clinic()
      const rosa = await patientNamed(c, "Rosa", "Pérez")
      const jorge = await patientNamed(c, "Jorge", "Salas")
      const soon = await appointmentFor(c, rosa, new Date(Date.now() + 2 * DAY))
      await appointmentFor(c, jorge, new Date(Date.now() + 3 * DAY), { status: "cancelada" })
      await appointmentFor(c, jorge, new Date(Date.now() - 3 * DAY))
      await appointmentFor(c, jorge, new Date(Date.now() + 120 * DAY))
      await appointmentFor(c, jorge, new Date(Date.now() + 4 * DAY), { professionalUserId: c.luisId })

      const before = await run(c, (tx) => getMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))
      expect(before).toMatchObject({ allowed: true, feed: null, preview: { summary: "Paciente · R. P." } })
      const created = await run(c, (tx) => createMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))
      const token = tokenOf(created.feed?.url)
      expect(created.feed?.webcalUrl).toMatch(/^webcal:\/\/api\.odentia\.test\/api\/public\/calendar\/[0-9a-f]{64}\.ics$/)
      expect(created.feed?.googleUrl).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal%3A%2F%2F/)
      // Crear otra vez da el mismo.
      expect((await run(c, (tx) => createMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))).feed?.url).toBe(created.feed?.url)

      expect(await findCalendarFeedOrg(ownerDb, token)).toBe(c.orgId)
      const file = (await run(c, (tx) => serveCalendarFeed(tx, c.orgId, token, GOOGLE)))!
      const lines = file.replace(/\r\n /g, "").split("\r\n")
      expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(1)
      expect(lines).toContain(`UID:${soon}@odentia`)
      expect(lines).toContain("SUMMARY:Paciente · R. P.")
      expect(lines).toContain("METHOD:PUBLISH")
      expect(lines.some((line) => line.startsWith("X-WR-CALNAME:"))).toBe(true)
      expect(lines.some((line) => line.startsWith("LOCATION:Sede Centro · Unidad dental 1\\, Av. José Larco 345"))).toBe(true)
      const unfolded = lines.join("\n")
      expect(unfolded).toContain(`agenda?appointmentId=${soon}`)
      expect(unfolded).not.toMatch(/Rosa|Pérez|Endodoncia/)
    } finally {
      configurePublicLinks(null)
    }
  })

  it("cambiar el enlace deja inservible el anterior; dejar de compartir lo apaga", async () => {
    const c = await clinic()
    const first = tokenOf((await run(c, (tx) => createMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))).feed?.url)
    const second = tokenOf((await run(c, (tx) => rotateMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))).feed?.url)
    expect(second).not.toBe(first)
    expect(await findCalendarFeedOrg(ownerDb, first)).toBeNull()
    expect(await run(c, (tx) => serveCalendarFeed(tx, c.orgId, first, GOOGLE))).toBeNull()
    expect(await run(c, (tx) => serveCalendarFeed(tx, c.orgId, second, GOOGLE))).toContain("BEGIN:VCALENDAR")
    await run(c, (tx) => revokeMyCalendarFeed(tx, c.orgId, c.anaId))
    expect(await run(c, (tx) => serveCalendarFeed(tx, c.orgId, second, GOOGLE))).toBeNull()
    expect((await run(c, (tx) => getMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))).feed).toBeNull()
    const actions = await ownerDb.select({ action: auditEvent.action }).from(auditEvent).where(eq(auditEvent.organizationId, c.orgId))
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(["calendar_feed.created", "calendar_feed.rotated", "calendar_feed.revoked"]),
    )
  })

  it("otra clínica no lo encuentra con su contexto", async () => {
    const a = await clinic()
    const b = await clinic()
    const token = tokenOf((await run(a, (tx) => createMyCalendarFeed(tx, a.orgId, a.anaId, DEPS))).feed?.url)
    expect(await run(b, (tx) => serveCalendarFeed(tx, b.orgId, token, GOOGLE))).toBeNull()
    expect(await run(b, (tx) => listTeamCalendarFeeds(tx, b.orgId))).toEqual([])
  })

  it("un programa nuevo avisa una vez; «Fui yo» lo deja como conocido", async () => {
    const c = await clinic()
    const token = tokenOf((await run(c, (tx) => createMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))).feed?.url)
    // El primer programa, y los del primer día, son de quien lo creó.
    await run(c, (tx) => serveCalendarFeed(tx, c.orgId, token, GOOGLE))
    await run(c, (tx) => serveCalendarFeed(tx, c.orgId, token, IPHONE))
    let mine = await run(c, (tx) => getMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))
    expect(mine.feed?.alert).toBeNull()
    expect(mine.feed?.clients.map((use) => [use.client, use.isNew])).toEqual(expect.arrayContaining([["google", false], ["iphone", false]]))

    // Pasado el primer día, un navegador es nuevo.
    await ownerDb.update(calendarFeed).set({ createdAt: new Date(Date.now() - 3 * DAY) }).where(eq(calendarFeed.organizationId, c.orgId))
    await run(c, (tx) => serveCalendarFeed(tx, c.orgId, token, BROWSER))
    await run(c, (tx) => serveCalendarFeed(tx, c.orgId, token, BROWSER))
    mine = await run(c, (tx) => getMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))
    expect(mine.feed?.alert).toMatchObject({ client: "navegador", label: "Navegador web" })
    const notices = await ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.organizationId, c.orgId))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ userId: c.anaId, href: "/agenda?calendario=1" })
    expect((await run(c, (tx) => listTeamCalendarFeeds(tx, c.orgId)))[0]).toMatchObject({ userId: c.anaId, newUse: true })

    await run(c, (tx) => acknowledgeCalendarClient(tx, c.orgId, c.anaId, "navegador"))
    mine = await run(c, (tx) => getMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))
    expect(mine.feed?.alert).toBeNull()
    // «Fui yo» también retira el aviso de la campana.
    const [notice] = await ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.organizationId, c.orgId))
    expect(notice?.resolvedAt).not.toBeNull()
    // Una fila por día y programa, con cuántas veces.
    const uses = await ownerDb.select().from(calendarFeedUse).where(and(eq(calendarFeedUse.organizationId, c.orgId), eq(calendarFeedUse.client, "navegador")))
    expect(uses).toHaveLength(1)
    expect(uses[0]?.hits).toBe(2)
  })

  it("dos calendarios a la vez el primer día y un doble clic en crear no se pisan", async () => {
    const c = await clinic()
    const [first, second] = await Promise.all([
      run(c, (tx) => createMyCalendarFeed(tx, c.orgId, c.anaId, DEPS)),
      run(c, (tx) => createMyCalendarFeed(tx, c.orgId, c.anaId, DEPS)),
    ])
    expect(first.feed?.url ?? second.feed?.url).toBeTruthy()
    const feeds = await ownerDb.select().from(calendarFeed).where(eq(calendarFeed.organizationId, c.orgId))
    expect(feeds).toHaveLength(1)
    const token = tokenOf((await run(c, (tx) => getMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))).feed?.url)
    // El primer pedido de cada uno queda anotado como conocido, aunque lleguen juntos.
    await run(c, (tx) => serveCalendarFeed(tx, c.orgId, token, GOOGLE))
    await Promise.all([
      run(c, (tx) => serveCalendarFeed(tx, c.orgId, token, IPHONE)),
      run(c, (tx) => serveCalendarFeed(tx, c.orgId, token, BROWSER)),
    ])
    const [feed] = await ownerDb.select().from(calendarFeed).where(eq(calendarFeed.organizationId, c.orgId))
    expect([...(feed?.knownClients ?? [])].sort()).toEqual(["google", "iphone", "navegador"])
  })

  it("al dejar de compartir también se borra lo de más de 90 días", async () => {
    const c = await clinic()
    await run(c, (tx) => createMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))
    const [feed] = await ownerDb.select().from(calendarFeed).where(eq(calendarFeed.organizationId, c.orgId))
    await ownerDb.insert(calendarFeedUse).values({ organizationId: c.orgId, feedId: feed!.id, day: "2020-01-01", client: "google" })
    await run(c, (tx) => revokeMyCalendarFeed(tx, c.orgId, c.anaId))
    expect(await ownerDb.select().from(calendarFeedUse).where(eq(calendarFeedUse.organizationId, c.orgId))).toEqual([])
  })

  it("lo de más de 90 días se borra al anotar, también lo de un enlace ya cambiado", async () => {
    const c = await clinic()
    await run(c, (tx) => createMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))
    const [old] = await ownerDb.select().from(calendarFeed).where(eq(calendarFeed.organizationId, c.orgId))
    await ownerDb.insert(calendarFeedUse).values({ organizationId: c.orgId, feedId: old!.id, day: "2020-01-01", client: "google" })
    const token = tokenOf((await run(c, (tx) => rotateMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))).feed?.url)
    await run(c, (tx) => serveCalendarFeed(tx, c.orgId, token, GOOGLE))
    const days = await ownerDb.select({ day: calendarFeedUse.day }).from(calendarFeedUse).where(eq(calendarFeedUse.organizationId, c.orgId))
    expect(days.map((row) => String(row.day))).not.toContain("2020-01-01")
    expect(days).toHaveLength(1)
  })

  it("se apaga solo si ya no atiende; la Administración lo apaga desde Equipo", async () => {
    const c = await clinic()
    const token = tokenOf((await run(c, (tx) => createMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))).feed?.url)
    await ownerDb.update(member).set({ role: "reception" }).where(eq(member.userId, c.anaId))
    expect(await run(c, (tx) => serveCalendarFeed(tx, c.orgId, token, GOOGLE))).toBeNull()
    const [feed] = await ownerDb.select().from(calendarFeed).where(eq(calendarFeed.organizationId, c.orgId))
    expect(feed).toMatchObject({ status: "revocado", revokeReason: "sin_acceso" })
    // Recepción no puede crear uno.
    await expect(run(c, (tx) => createMyCalendarFeed(tx, c.orgId, c.anaId, DEPS))).rejects.toMatchObject({ status: 403 })

    await run(c, (tx) => createMyCalendarFeed(tx, c.orgId, c.luisId, DEPS))
    expect((await run(c, (tx) => listTeamCalendarFeeds(tx, c.orgId))).map((row) => row.userId)).toEqual([c.luisId])
    await run(c, (tx) => revokeTeamCalendarFeed(tx, c.orgId, c.ownerId, c.luisId))
    expect(await run(c, (tx) => listTeamCalendarFeeds(tx, c.orgId))).toEqual([])
  })
})
