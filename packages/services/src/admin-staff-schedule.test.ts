import { kairosItem, saasChat, saasClient, saasTask } from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { and, eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import {
  decideKairosItem,
  type KairosExecutors,
  kairosRulesPass,
  todayForStaff,
} from "./admin-kairos.js"
import { recordPresentation, schedulePresentation } from "./admin-sales.js"
import {
  absenceConflicts,
  addStaffAbsence,
  bookPresentation,
  cancelPresentation,
  confirmProposal,
  getStaffSchedule,
  movePresentation,
  proposeSlot,
  reassignPresentation,
  setStaffHours,
  setStaffMeetingUrl,
  staffSlots,
} from "./admin-staff-schedule.js"
import { limaDate } from "./peru-business-days.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/** Horarios, ausencias y presentaciones del equipo (Kairós vende, K3–K8). */
setupTestDb()
const HOUR = 3_600_000
const DAY = 86_400_000
const maria: AdminActor = { userId: "ss-maria", role: "admin" }
const ana: AdminActor = { userId: "ss-ana", role: "support" }
const luis: AdminActor = { userId: "ss-luis", role: "support" }
/** Sin horario: nunca presenta. */
const sin: AdminActor = { userId: "ss-sin", role: "support" }

/**
 * Cada prueba vive en su propia «semana»: un lunes a las 08:00 de Lima (13:00 UTC), cada tres
 * semanas, para que las presentaciones y ausencias de una no caigan en los 14 días de otra.
 */
function monday(week: number): Date {
  return new Date(Date.UTC(2026, 10, 16 + 21 * week, 13, 0))
}
/** Una hora de Lima («10:30»), `days` días después del lunes de esa semana. */
function lima(week: number, days: number, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number) as [number, number]
  const base = monday(week)
  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days, h + 5, m),
  )
}
const iso = (dates: Array<{ startsAt: Date }>) => dates.map((slot) => slot.startsAt.toISOString())

async function client(name: string, ownerUserId: string | null): Promise<string> {
  const [row] = await ownerDb
    .insert(saasClient)
    .values({ name, product: "dental", ownerUserId })
    .returning({ id: saasClient.id })
  if (!row) throw new Error("sin cliente")
  return row.id
}

let chatSeq = 0
async function chat(clientId: string | null = null): Promise<string> {
  chatSeq += 1
  const [row] = await ownerDb
    .insert(saasChat)
    .values({ address: `+5198100${String(chatSeq).padStart(4, "0")}`, clientId })
    .returning({ id: saasChat.id })
  if (!row) throw new Error("sin conversación")
  return row.id
}

const tx = <T>(fn: (db: typeof ownerDb) => Promise<T>) => ownerDb.transaction((inner) => fn(inner))

const unused = () => {
  throw new Error("no se ejecuta")
}

function executorsAt(now: Date): KairosExecutors {
  return {
    prepareOutreach: unused,
    updateClient: unused,
    linkContactToUser: unused,
    assignInboundEmail: unused,
    assignChat: unused,
    prepareEmailReply: unused,
    recordPresentation: unused,
    createProposal: unused,
    markClientFileCarga: unused,
    reassignPresentation: (inner, actor, taskId, toUserId) =>
      reassignPresentation(inner, actor, taskId, toUserId, now),
  }
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: maria.userId, name: "María Admin", email: "maria@ss.test" },
    { id: ana.userId, name: "Ana Pérez", email: "ana@ss.test" },
    { id: luis.userId, name: "Luis Rojas", email: "luis@ss.test" },
    { id: sin.userId, name: "Sara Sinhorario", email: "sara@ss.test" },
  ])
  await ownerDb.insert(adminStaff).values([
    { userId: maria.userId, role: "admin" },
    { userId: ana.userId, role: "support" },
    { userId: luis.userId, role: "support" },
    { userId: sin.userId, role: "support" },
  ])
  // Ana, de lunes a viernes de 9 a 12; Luis, de 9 a 13. María no presenta (sin horario).
  const weekdays = [1, 2, 3, 4, 5]
  await tx((db) =>
    setStaffHours(
      db,
      ana,
      ana.userId,
      weekdays.map((weekday) => ({ weekday, startMin: 540, endMin: 720 })),
      monday(0),
    ),
  )
  await tx((db) =>
    setStaffHours(
      db,
      maria,
      luis.userId,
      weekdays.map((weekday) => ({ weekday, startMin: 540, endMin: 780 })),
      monday(0),
    ),
  )
}, 180_000)

describe("horario, sala y quién lo cambia", () => {
  it("rechaza franjas que se cruzan, fuera del día o al revés", async () => {
    await expect(
      tx((db) =>
        setStaffHours(db, ana, ana.userId, [
          { weekday: 1, startMin: 540, endMin: 720 },
          { weekday: 1, startMin: 700, endMin: 800 },
        ]),
      ),
    ).rejects.toMatchObject({
      status: 400,
      fields: { "hours.1": expect.stringContaining("cruza") },
    })
    await expect(
      tx((db) => setStaffHours(db, ana, ana.userId, [{ weekday: 7, startMin: 0, endMin: 60 }])),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      tx((db) => setStaffHours(db, ana, ana.userId, [{ weekday: 1, startMin: 600, endMin: 600 }])),
    ).rejects.toMatchObject({ status: 400 })
  })

  it("cada uno cambia lo suyo; lo de otra persona, solo Administración", async () => {
    await expect(
      tx((db) => setStaffHours(db, ana, luis.userId, [{ weekday: 1, startMin: 540, endMin: 600 }])),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      tx((db) =>
        addStaffAbsence(
          db,
          luis,
          ana.userId,
          { startsAt: lima(9, 0, "09:00"), endsAt: lima(9, 0, "10:00") },
          monday(9),
        ),
      ),
    ).rejects.toMatchObject({ status: 403 })
    const schedule = await getStaffSchedule(ownerDb, luis, ana.userId, monday(0))
    expect(schedule.hours).toHaveLength(5)
  })

  it("la sala es un enlace https", async () => {
    await expect(
      tx((db) => setStaffMeetingUrl(db, ana, ana.userId, "http://meet.example/ana")),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      tx((db) => setStaffMeetingUrl(db, ana, ana.userId, "meet.example/ana")),
    ).rejects.toMatchObject({ status: 400 })
    expect(
      await tx((db) => setStaffMeetingUrl(db, ana, ana.userId, " https://meet.example/ana ")),
    ).toBe("https://meet.example/ana")
    // La base lo cuida también.
    await expect(
      ownerDb.execute(
        sql`update admin_staff set meeting_url = 'ftp://x' where user_id = ${ana.userId}`,
      ),
    ).rejects.toMatchObject({ cause: { constraint_name: "admin_staff_meeting_url_check" } })
  })
})

describe("staffSlots", () => {
  it("con responsable: sus horas, a las :00 y :30, desde 2 h después y bloques de 45 min", async () => {
    const slots = await staffSlots(ownerDb, { preferUserId: ana.userId, now: monday(1), limit: 5 })
    // Lunes 08:00 → desde las 10:00; la de las 11:30 terminaría a las 12:15, fuera de su horario.
    expect(iso(slots)).toEqual(
      [
        lima(1, 0, "10:00"),
        lima(1, 0, "10:30"),
        lima(1, 0, "11:00"),
        lima(1, 1, "09:00"),
        lima(1, 1, "09:30"),
      ].map((date) => date.toISOString()),
    )
    expect(slots.every((slot) => slot.userId === ana.userId && slot.preferred)).toBe(true)
    expect(slots[0]?.endsAt.getTime()).toBe(lima(1, 0, "10:45").getTime())
    // A las 08:10 la primera es la de las 10:30 (las 10:10 no está en la cuadrícula).
    const later = await staffSlots(ownerDb, {
      preferUserId: ana.userId,
      now: new Date(monday(1).getTime() + 10 * 60_000),
      limit: 1,
    })
    expect(iso(later)).toEqual([lima(1, 0, "10:30").toISOString()])
  })

  it("solo días con horario, en Lima (UTC−5 todo el año), hasta 14 días", async () => {
    const now = monday(2)
    const slots = await staffSlots(ownerDb, { preferUserId: ana.userId, now, limit: 200 })
    expect(slots.length).toBeGreaterThan(0)
    for (const slot of slots) {
      const local = new Date(slot.startsAt.getTime() - 5 * HOUR)
      expect([1, 2, 3, 4, 5]).toContain(local.getUTCDay())
      expect(local.getUTCHours() * 60 + local.getUTCMinutes()).toBeGreaterThanOrEqual(540)
      expect(local.getUTCHours() * 60 + local.getUTCMinutes() + 45).toBeLessThanOrEqual(720)
      expect(slot.startsAt.getTime() % (30 * 60_000)).toBe(0)
      expect(slot.startsAt.getTime()).toBeLessThanOrEqual(now.getTime() + 14 * DAY)
    }
    // Dos semanas de lunes a viernes, 5 bloques por día (9:00 a 11:00), menos los dos de antes de
    // las 10 del primer lunes.
    expect(slots).toHaveLength(10 * 5 - 2)
  })

  it("quita ausencias y presentaciones abiertas", async () => {
    const now = monday(3)
    const clientId = await client("Clínica Aurora (ficticia)", ana.userId)
    await tx((db) =>
      addStaffAbsence(
        db,
        ana,
        ana.userId,
        { startsAt: lima(3, 1, "00:00"), endsAt: lima(3, 2, "00:00"), reason: "Médico" },
        now,
      ),
    )
    await tx((db) =>
      bookPresentation(
        db,
        null,
        { clientId, startsAt: lima(3, 0, "10:30"), assigneeUserId: ana.userId },
        now,
      ),
    )
    const slots = await staffSlots(ownerDb, {
      preferUserId: ana.userId,
      now,
      to: lima(3, 3, "00:00"),
      limit: 50,
    })
    // El lunes 10:30 está tomado (y 10:00 y 11:00 se le cruzan); el martes no está.
    expect(iso(slots)).toEqual(
      ["09:00", "09:30", "10:00", "10:30", "11:00"].map((hhmm) => lima(3, 2, hhmm).toISOString()),
    )
  })

  it("responsable ausente: la primera persona libre de las demás, sin cambiar al responsable", async () => {
    const now = monday(4)
    await tx((db) =>
      addStaffAbsence(
        db,
        maria,
        ana.userId,
        {
          startsAt: new Date(now.getTime() - HOUR),
          endsAt: lima(4, 4, "23:00"),
          reason: "Vacaciones",
        },
        now,
      ),
    )
    const slots = await staffSlots(ownerDb, { preferUserId: ana.userId, now, limit: 3 })
    expect(slots.map((slot) => [slot.userId, slot.preferred])).toEqual([
      [luis.userId, false],
      [luis.userId, false],
      [luis.userId, false],
    ])
    const clientId = await client("Clínica Bahía (ficticia)", ana.userId)
    const first = slots[0]
    if (!first) throw new Error("sin hora")
    const task = await tx((db) =>
      bookPresentation(
        db,
        null,
        { clientId, startsAt: first.startsAt, assigneeUserId: first.userId },
        now,
      ),
    )
    expect(task).toMatchObject({
      assignee: { userId: luis.userId },
      byKairos: true,
      kind: "presentacion",
    })
    const [row] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, clientId))
    expect(row?.ownerUserId).toBe(ana.userId)
    // Una persona ausente no se agenda.
    await expect(
      tx((db) =>
        bookPresentation(
          db,
          null,
          { clientId, startsAt: lima(4, 1, "10:00"), assigneeUserId: ana.userId },
          now,
        ),
      ),
    ).rejects.toMatchObject({ code: "SLOT_TAKEN" })
  })

  it("sin responsable: la persona libre más temprana, y queda como responsable", async () => {
    const now = monday(5)
    const slots = await staffSlots(ownerDb, { now, limit: 4 })
    // A la misma hora están Ana y Luis: el primero por nombre. Las 12:00 y 12:30 solo Luis.
    expect(slots.map((slot) => slot.userId)).toEqual([
      ana.userId,
      ana.userId,
      ana.userId,
      luis.userId,
    ])
    expect(slots[3]?.startsAt.toISOString()).toBe(lima(5, 0, "11:30").toISOString())
    const clientId = await client("Clínica Cumbre (ficticia)", null)
    await tx((db) =>
      bookPresentation(
        db,
        null,
        { clientId, startsAt: lima(5, 0, "12:00"), assigneeUserId: luis.userId },
        now,
      ),
    )
    const [row] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, clientId))
    expect(row?.ownerUserId).toBe(luis.userId)
    // A quien presenta le queda el aviso en Hoy (lo agendó Kairós).
    const notes = await ownerDb
      .select()
      .from(saasTask)
      .where(and(eq(saasTask.clientId, clientId), eq(saasTask.kind, "otro")))
    expect(notes[0]?.title).toMatch(/^Presentas a Clínica Cumbre \(ficticia\) el lunes/)
    expect(notes[0]?.assigneeUserId).toBe(luis.userId)
  })
})

describe("bookPresentation", () => {
  it("dos a la vez por la misma hora: una entra y la otra recibe SLOT_TAKEN", async () => {
    const now = monday(6)
    const a = await client("Clínica Delta (ficticia)", ana.userId)
    const b = await client("Clínica Eco (ficticia)", ana.userId)
    const startsAt = lima(6, 1, "10:00")
    const results = await Promise.allSettled([
      tx((db) =>
        bookPresentation(db, null, { clientId: a, startsAt, assigneeUserId: ana.userId }, now),
      ),
      tx((db) =>
        bookPresentation(db, null, { clientId: b, startsAt, assigneeUserId: ana.userId }, now),
      ),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected && "reason" in rejected ? rejected.reason : null).toMatchObject({
      code: "SLOT_TAKEN",
      status: 409,
    })
    // Tampoco una que se cruza a medias (10:30 cae dentro de 10:00–10:45).
    await expect(
      tx((db) =>
        bookPresentation(
          db,
          null,
          { clientId: b, startsAt: lima(6, 1, "10:30"), assigneeUserId: ana.userId },
          now,
        ),
      ),
    ).rejects.toMatchObject({ code: "SLOT_TAKEN" })
    const [task] = await ownerDb
      .select()
      .from(saasTask)
      .where(and(eq(saasTask.kind, "presentacion"), eq(saasTask.dueAt, startsAt)))
    expect(task?.endsAt?.getTime()).toBe(startsAt.getTime() + 45 * 60_000)
  })

  it("fuera de la cuadrícula, sin 2 h de aviso, más allá de 14 días o fuera del horario, no", async () => {
    const now = monday(7)
    const clientId = await client("Clínica Faro (ficticia)", ana.userId)
    const book = (startsAt: Date) =>
      tx((db) =>
        bookPresentation(db, null, { clientId, startsAt, assigneeUserId: ana.userId }, now),
      )
    await expect(book(lima(7, 1, "10:15"))).rejects.toMatchObject({ status: 400 })
    await expect(book(lima(7, 0, "09:30"))).rejects.toMatchObject({ status: 400 })
    await expect(book(lima(7, 15, "10:00"))).rejects.toMatchObject({ status: 400 })
    await expect(book(lima(7, 1, "15:00"))).rejects.toMatchObject({ code: "SLOT_TAKEN" })
    await expect(
      tx((db) =>
        bookPresentation(
          db,
          null,
          { clientId, startsAt: lima(7, 1, "10:00"), assigneeUserId: sin.userId },
          now,
        ),
      ),
    ).rejects.toMatchObject({ code: "SLOT_TAKEN" })
  })

  it("mover y cancelar: con el mismo choque, y quien presenta lo ve en Hoy", async () => {
    const now = monday(8)
    const clientId = await client("Clínica Gala (ficticia)", ana.userId)
    const other = await client("Clínica Hélice (ficticia)", ana.userId)
    const chatId = await chat(clientId)
    const task = await tx((db) =>
      bookPresentation(
        db,
        null,
        { clientId, startsAt: lima(8, 1, "10:00"), assigneeUserId: ana.userId, chatId },
        now,
      ),
    )
    const [row] = await ownerDb.select().from(saasTask).where(eq(saasTask.id, task.id))
    expect(row?.channelChatId).toBe(chatId)
    await tx((db) =>
      bookPresentation(
        db,
        null,
        { clientId: other, startsAt: lima(8, 1, "11:00"), assigneeUserId: ana.userId },
        now,
      ),
    )
    await expect(
      tx((db) => movePresentation(db, null, task.id, lima(8, 1, "10:30"), now)),
    ).rejects.toMatchObject({
      code: "SLOT_TAKEN",
    })
    // Moverla dentro de su propio tramo sí: no choca consigo misma.
    await tx((db) => movePresentation(db, null, task.id, lima(8, 1, "09:30"), now))
    const moved = await tx((db) => movePresentation(db, null, task.id, lima(8, 2, "10:00"), now))
    expect(moved.dueAt?.toISOString()).toBe(lima(8, 2, "10:00").toISOString())
    await tx((db) => cancelPresentation(db, null, task.id, {}, now))
    const notes = await ownerDb
      .select({ title: saasTask.title })
      .from(saasTask)
      .where(
        and(
          eq(saasTask.clientId, clientId),
          eq(saasTask.kind, "otro"),
          eq(saasTask.assigneeUserId, ana.userId),
        ),
      )
    expect(notes.map((note) => note.title)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^La presentación de Clínica Gala \(ficticia\) pasó al miércoles/),
        expect.stringMatching(
          /^Se canceló la presentación de Clínica Gala \(ficticia\) del miércoles/,
        ),
      ]),
    )
    // Lo que ella misma hace no le deja aviso.
    const own = await tx((db) =>
      schedulePresentation(
        db,
        ana,
        other,
        { dueOn: limaDate(lima(8, 1, "12:00")), dueAt: lima(8, 1, "12:00") },
        now,
      ),
    )
    await tx((db) => cancelPresentation(db, ana, own.id, {}, now))
    const ownNotes = await ownerDb
      .select({ title: saasTask.title })
      .from(saasTask)
      .where(
        and(
          eq(saasTask.clientId, other),
          eq(saasTask.kind, "otro"),
          sql`${saasTask.title} like 'Se canceló%'`,
        ),
      )
    expect(ownNotes).toHaveLength(0)
  })
})

describe("propuestas de Kairós en una conversación", () => {
  it("la última manda, se confirma agendando y vence a las 48 h", async () => {
    const now = monday(10)
    const clientId = await client("Clínica Íris (ficticia)", ana.userId)
    const chatId = await chat(clientId)
    const first = await tx((db) =>
      proposeSlot(db, { chatId, assigneeUserId: ana.userId, startsAt: lima(10, 1, "10:00") }, now),
    )
    const second = await tx((db) =>
      proposeSlot(db, { chatId, assigneeUserId: ana.userId, startsAt: lima(10, 1, "11:00") }, now),
    )
    const [old] = await ownerDb.execute<{ status: string }>(
      sql`select status from kairos_proposal where id = ${first.id}::uuid`,
    )
    expect(old?.status).toBe("reemplazada")
    await expect(tx((db) => confirmProposal(db, first.id, now))).rejects.toMatchObject({
      code: "PROPOSAL_CLOSED",
    })
    const done = await tx((db) => confirmProposal(db, second.id, new Date(now.getTime() + HOUR)))
    expect(done.status).toBe("confirmada")
    if (done.status !== "confirmada") throw new Error("no se confirmó")
    expect(done.task).toMatchObject({ clientId, assignee: { userId: ana.userId } })
    expect(done.task.dueAt?.toISOString()).toBe(lima(10, 1, "11:00").toISOString())
    expect(done.proposal.taskId).toBe(done.task.id)

    const late = await tx((db) =>
      proposeSlot(db, { chatId, assigneeUserId: ana.userId, startsAt: lima(10, 3, "10:00") }, now),
    )
    const expired = await tx((db) =>
      confirmProposal(db, late.id, new Date(now.getTime() + 49 * HOUR)),
    )
    expect(expired).toMatchObject({ status: "vencida", error: { code: "PROPOSAL_EXPIRED" } })
  })

  it("si otro se ganó la hora, la propuesta vence con SLOT_TAKEN", async () => {
    const now = monday(11)
    const clientId = await client("Clínica Jade (ficticia)", ana.userId)
    const other = await client("Clínica Kiwi (ficticia)", ana.userId)
    const chatId = await chat(clientId)
    const proposal = await tx((db) =>
      proposeSlot(db, { chatId, assigneeUserId: ana.userId, startsAt: lima(11, 1, "10:00") }, now),
    )
    await tx((db) =>
      bookPresentation(
        db,
        null,
        { clientId: other, startsAt: lima(11, 1, "10:00"), assigneeUserId: ana.userId },
        now,
      ),
    )
    const out = await tx((db) => confirmProposal(db, proposal.id, now))
    expect(out).toMatchObject({ status: "vencida", error: { code: "SLOT_TAKEN" } })
    // Proponer una hora ocupada tampoco.
    await expect(
      tx((db) =>
        proposeSlot(
          db,
          { chatId, assigneeUserId: ana.userId, startsAt: lima(11, 1, "10:00") },
          now,
        ),
      ),
    ).rejects.toMatchObject({ code: "SLOT_TAKEN" })
    // Sin cliente todavía: sigue pendiente hasta decir de qué clínica es.
    const loose = await chat(null)
    const pending = await tx((db) =>
      proposeSlot(
        db,
        { chatId: loose, assigneeUserId: ana.userId, startsAt: lima(11, 2, "10:00") },
        now,
      ),
    )
    await expect(tx((db) => confirmProposal(db, pending.id, now))).rejects.toMatchObject({
      code: "CLIENT_REQUIRED",
    })
  })
})

describe("ausencias que chocan", () => {
  it("Hoy: «2 presentaciones de Ana caen en sus vacaciones», y «Pasar a Luis» solo si está libre", async () => {
    const now = monday(12)
    const a = await client("Clínica Lirio (ficticia)", ana.userId)
    const b = await client("Clínica Mango (ficticia)", ana.userId)
    const t1 = await tx((db) =>
      bookPresentation(
        db,
        null,
        { clientId: a, startsAt: lima(12, 2, "10:00"), assigneeUserId: ana.userId },
        now,
      ),
    )
    const t2 = await tx((db) =>
      bookPresentation(
        db,
        null,
        { clientId: b, startsAt: lima(12, 3, "11:00"), assigneeUserId: ana.userId },
        now,
      ),
    )
    const { conflicts } = await tx((db) =>
      addStaffAbsence(
        db,
        ana,
        ana.userId,
        { startsAt: lima(12, 2, "00:00"), endsAt: lima(12, 5, "00:00"), reason: "Vacaciones" },
        now,
      ),
    )
    expect(conflicts.map((row) => row.taskId)).toEqual([t1.id, t2.id])
    expect(
      await absenceConflicts(ownerDb, ana.userId, {
        startsAt: lima(12, 3, "00:00"),
        endsAt: lima(12, 4, "00:00"),
      }),
    ).toHaveLength(1)

    await tx((db) => kairosRulesPass(db, now))
    await tx((db) => kairosRulesPass(db, now))
    const items = await ownerDb
      .select()
      .from(kairosItem)
      .where(and(eq(kairosItem.kind, "ausencia_choca"), eq(kairosItem.status, "espera")))
    expect(items).toHaveLength(1)
    const [item] = items
    expect(item).toMatchObject({
      title: "2 presentaciones de Ana caen en sus vacaciones",
      adminOnly: true,
      clientId: null,
    })
    expect(item?.payload).toMatchObject({
      userId: ana.userId,
      taskIds: [t1.id, t2.id].sort(),
      candidates: [{ userId: luis.userId, name: "Luis Rojas" }],
      choice: "pasar",
      toUserId: luis.userId,
    })
    // Soporte no aprueba esto.
    await expect(
      tx((db) =>
        decideKairosItem(
          db,
          luis,
          item?.id as string,
          { action: "aprobar" },
          executorsAt(now),
          now,
        ),
      ),
    ).rejects.toMatchObject({ status: 404 })

    // Luis se ocupa a la hora de una: «Pasar a Luis» no pasa ninguna y el ítem sigue esperando.
    const busy = await client("Clínica Nube (ficticia)", luis.userId)
    const blocker = await tx((db) =>
      bookPresentation(
        db,
        null,
        { clientId: busy, startsAt: lima(12, 3, "11:00"), assigneeUserId: luis.userId },
        now,
      ),
    )
    await expect(
      tx((db) =>
        decideKairosItem(
          db,
          maria,
          item?.id as string,
          { action: "aprobar" },
          executorsAt(now),
          now,
        ),
      ),
    ).rejects.toMatchObject({ code: "STAFF_BUSY" })
    const [still] = await ownerDb
      .select()
      .from(kairosItem)
      .where(eq(kairosItem.id, item?.id as string))
    expect(still?.status).toBe("espera")
    const [kept] = await ownerDb.select().from(saasTask).where(eq(saasTask.id, t1.id))
    expect(kept?.assigneeUserId).toBe(ana.userId)
    await expect(
      tx((db) => reassignPresentation(db, maria, t2.id, luis.userId, now)),
    ).rejects.toMatchObject({ code: "STAFF_BUSY" })

    // Libre otra vez: pasan las dos a Luis, sin cambiar el responsable de las clínicas.
    await tx((db) => cancelPresentation(db, maria, blocker.id, {}, now))
    const decided = await tx((db) =>
      decideKairosItem(db, maria, item?.id as string, { action: "aprobar" }, executorsAt(now), now),
    )
    expect(decided.status).toBe("ejecutada")
    const moved = await ownerDb
      .select({ id: saasTask.id, assignee: saasTask.assigneeUserId })
      .from(saasTask)
      .where(sql`${saasTask.id} in (${t1.id}::uuid, ${t2.id}::uuid)`)
    expect(moved.every((row) => row.assignee === luis.userId)).toBe(true)
    const [owner] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, a))
    expect(owner?.ownerUserId).toBe(ana.userId)
    // Ya no chocan: la pasada no vuelve a ponerlo.
    await tx((db) => kairosRulesPass(db, now))
    const again = await ownerDb
      .select()
      .from(kairosItem)
      .where(and(eq(kairosItem.kind, "ausencia_choca"), eq(kairosItem.status, "espera")))
    expect(again).toHaveLength(0)
  })

  it("«Pedir otra hora» lo anota en la presentación y no vuelve a salir", async () => {
    const now = monday(13)
    const clientId = await client("Clínica Olmo (ficticia)", ana.userId)
    const task = await tx((db) =>
      bookPresentation(
        db,
        null,
        { clientId, startsAt: lima(13, 2, "10:00"), assigneeUserId: ana.userId },
        now,
      ),
    )
    await tx((db) =>
      addStaffAbsence(
        db,
        ana,
        ana.userId,
        { startsAt: lima(13, 2, "09:00"), endsAt: lima(13, 2, "12:00") },
        now,
      ),
    )
    await tx((db) => kairosRulesPass(db, now))
    const [item] = await ownerDb
      .select()
      .from(kairosItem)
      .where(and(eq(kairosItem.kind, "ausencia_choca"), eq(kairosItem.status, "espera")))
    expect(item?.title).toBe("1 presentación de Ana cae en su ausencia")
    const decided = await tx((db) =>
      decideKairosItem(
        db,
        maria,
        item?.id as string,
        { action: "aprobar", edited: { choice: "otra_hora" } },
        executorsAt(now),
        now,
      ),
    )
    expect(decided).toMatchObject({ status: "ejecutada", result: { choice: "otra_hora" } })
    const [row] = await ownerDb.select().from(saasTask).where(eq(saasTask.id, task.id))
    expect(row?.needsNewTimeAt?.getTime()).toBe(now.getTime())
    expect(row?.assigneeUserId).toBe(ana.userId)
    await tx((db) => kairosRulesPass(db, now))
    const open = await ownerDb
      .select()
      .from(kairosItem)
      .where(and(eq(kairosItem.kind, "ausencia_choca"), eq(kairosItem.status, "espera")))
    expect(open).toHaveLength(0)
  })

  it("las tareas de alguien ausente salen en «Mías» del resto: «De Ana, ausente»", async () => {
    const now = monday(14)
    const clientId = await client("Clínica Pino (ficticia)", ana.userId)
    const [task] = await ownerDb
      .insert(saasTask)
      .values({
        clientId,
        kind: "llamar",
        title: "Llamar a la Clínica Pino",
        dueOn: limaDate(now),
        assigneeUserId: ana.userId,
      })
      .returning({ id: saasTask.id })
    // Todavía no está ausente: Luis no la ve en las suyas.
    const before = await todayForStaff(ownerDb, luis, { who: "mias" }, now)
    expect(before.tasks.some((row) => row.id === task?.id)).toBe(false)
    await tx((db) =>
      addStaffAbsence(
        db,
        ana,
        ana.userId,
        { startsAt: new Date(now.getTime() - HOUR), endsAt: new Date(now.getTime() + DAY) },
        now,
      ),
    )
    const after = await todayForStaff(ownerDb, luis, { who: "mias" }, now)
    const row = after.tasks.find((found) => found.id === task?.id)
    expect(row).toMatchObject({ absentAssignee: true, assignee: { userId: ana.userId } })
    expect(row?.why).toMatch(/^De Ana, ausente · /)
    // A Ana misma no se le dice que está ausente.
    const own = await todayForStaff(ownerDb, ana, { who: "mias" }, now)
    const mine = own.tasks.find((found) => found.id === task?.id)
    expect(mine?.absentAssignee).toBeUndefined()
  })
})

describe("«No se conectó»", () => {
  it("deja una tarea «Llamar» al responsable, una sola vez", async () => {
    const now = monday(15)
    const clientId = await client("Clínica Quinua (ficticia)", luis.userId)
    const task = await tx((db) =>
      bookPresentation(
        db,
        null,
        { clientId, startsAt: lima(15, 1, "10:00"), assigneeUserId: ana.userId },
        now,
      ),
    )
    await tx((db) =>
      recordPresentation(
        db,
        ana,
        task.id,
        { outcome: "no_se_conecto", body: "No entró a la sala." },
        now,
      ),
    )
    await tx((db) => kairosRulesPass(db, now))
    await tx((db) => kairosRulesPass(db, new Date(now.getTime() + DAY)))
    const calls = await ownerDb
      .select()
      .from(saasTask)
      .where(and(eq(saasTask.clientId, clientId), eq(saasTask.kind, "llamar")))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      title: "Llamar a Clínica Quinua (ficticia): no se conectó a la presentación",
      assigneeUserId: luis.userId,
      byKairos: true,
    })
  })
})
