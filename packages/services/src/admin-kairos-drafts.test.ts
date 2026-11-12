import {
  kairosItem,
  kairosWeekly,
  saasClient,
  saasClientContact,
  saasOpportunity,
} from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import { eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import {
  draftPendingKairosItems,
  type KairosDraftWriter,
  type KairosWeeklyWriter,
  kairosAllowedFact,
  kairosWeekStart,
  latestKairosWeekly,
  pendingKairosDraftJobs,
  writeKairosWeekly,
} from "./admin-kairos-drafts.js"
import { ServiceError } from "./errors.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Lo que redacta el modelo de Kairós, con Postgres real: al modelo viaja solo
 * lo permitido, el borrador queda en el ítem (nada se envía) y el resumen de
 * la semana se escribe una vez, con las cifras del cálculo.
 */
setupTestDb()
const admin: AdminActor = { userId: "kd-admin", role: "admin" }
const support: AdminActor = { userId: "kd-support", role: "support" }
const NOW = new Date()
const HOUR = 3_600_000
const ids: Record<string, string> = {}
/** El id guardado en la preparación: falla claro si no está. */
function idOf(key: string): string {
  const id = ids[key]
  if (!id) throw new Error(`falta ${key}`)
  return id
}

/** Un escritor que anota lo que le llega y responde con plantillas; puede fallar a pedido. */
function recordingWriter(failFor: Set<string> = new Set()) {
  const seen: Array<{ op: string; input: Record<string, unknown> }> = []
  const writer: KairosDraftWriter & KairosWeeklyWriter = {
    async draftMessage(input) {
      seen.push({ op: "draftMessage", input })
      if (failFor.has(input.goal)) throw new Error("el modelo no respondió")
      return {
        subject: `Asunto para ${input.client.name}`,
        body: `Hola ${input.contact?.name ?? ""}, ${input.goal}. ${input.senderName}`,
      }
    },
    async presentationScript(input) {
      seen.push({ op: "presentationScript", input })
      return { script: `Guion para ${input.client.name} con ${input.demo?.name ?? "sin demo"}` }
    },
    async weeklySummary(input) {
      seen.push({ op: "weeklySummary", input })
      return {
        text: `Esta semana: ${input.figures.map((f) => `${f.label} ${f.words}`).join("; ")}`,
      }
    },
  }
  return { writer, seen }
}

async function item(
  key: string,
  clientId: string,
  values: {
    kind: "mensaje" | "guion" | "dato"
    reason: string
    payload: Record<string, unknown>
    adminOnly?: boolean
    expiresAt?: Date
  },
) {
  const [row] = await ownerDb
    .insert(kairosItem)
    .values({
      clientId,
      kind: values.kind,
      title: `Ítem ${key}`,
      reason: values.reason,
      payload: values.payload,
      expectedState: {},
      idempotencyKey: `prueba:${key}`,
      expiresAt: values.expiresAt ?? new Date(NOW.getTime() + 48 * HOUR),
      adminOnly: values.adminOnly ?? false,
    })
    .returning({ id: kairosItem.id })
  if (!row) throw new Error("sin ítem")
  ids[key] = row.id
  return row.id
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Administración", email: "ada@drafts.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@drafts.test" },
  ])
  const [client] = await ownerDb
    .insert(saasClient)
    .values({
      name: "Clínica Borrador (ficticia)",
      product: "optical",
      origin: "web",
      city: "Arequipa",
      professionals: "2-3",
      currentTool: "cuaderno_excel",
      ownerUserId: admin.userId,
    })
    .returning({ id: saasClient.id })
  if (!client) throw new Error("sin cliente")
  ids.client = client.id
  await ownerDb.insert(saasOpportunity).values({ clientId: client.id })
  const [contact] = await ownerDb
    .insert(saasClientContact)
    .values({
      clientId: client.id,
      name: "Rosa Quispe",
      title: "Gerente",
      phone: "+51987654321",
      email: "rosa@drafts.test",
      isPrimary: true,
    })
    .returning({ id: saasClientContact.id })
  if (!contact) throw new Error("sin contacto")
  ids.contact = contact.id
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR)
  await ownerDb.insert(saasFollowUp).values([
    {
      clientId: client.id,
      kind: "llamada",
      direction: "salio",
      body: "Le interesa el plan; pagaría S/ 120 al mes",
      outcome: "Quedó en pensarlo",
      authorUserId: admin.userId,
      happenedAt: at(30),
    },
    {
      clientId: client.id,
      kind: "nota",
      body: "Nota interna: le ofrecimos 20 % de descuento",
      adminOnly: true,
      authorUserId: admin.userId,
      happenedAt: at(20),
    },
    {
      clientId: client.id,
      kind: "correo",
      direction: "entro",
      body: "Adjunto la historia clínica de la paciente Ana, DNI 45678912",
      happenedAt: at(10),
    },
  ])

  await item("whatsapp", client.id, {
    kind: "mensaje",
    reason: "Su solicitud espera respuesta desde hace 2 días",
    payload: {
      goal: "primera_respuesta",
      channel: "whatsapp",
      contactId: contact.id,
      to: "+51987654321",
      subject: null,
      body: null,
      draft: null,
      facts: ["Pidió conocer el precio: USD 29 al mes", "Su paciente tiene DNI 12345678"],
    },
  })
  await item("correo", client.id, {
    kind: "mensaje",
    reason: "La propuesta vale hasta el viernes",
    adminOnly: true,
    payload: {
      goal: "recordar_propuesta",
      channel: "correo",
      contactId: contact.id,
      to: "rosa@drafts.test",
      draft: null,
      facts: ["La propuesta cuesta USD 29 al mes"],
    },
  })
  await item("guion", client.id, {
    kind: "guion",
    reason: "La presentación es mañana",
    payload: { goal: "guion", draft: null, body: null },
  })
  await item("falla", client.id, {
    kind: "mensaje",
    reason: "Llegó el día de volver",
    payload: { goal: "retomar", channel: "whatsapp", contactId: contact.id, draft: null },
  })
  // Lo que no se redacta: un dato, un mensaje ya redactado y uno vencido.
  await item("dato", client.id, { kind: "dato", reason: "Dijo su ciudad", payload: {} })
  await item("listo", client.id, {
    kind: "mensaje",
    reason: "Ya redactado",
    payload: { goal: "retomar", channel: "whatsapp", draft: { subject: null, body: "Hola" } },
  })
  await item("vencido", client.id, {
    kind: "mensaje",
    reason: "Venció",
    payload: { goal: "retomar", channel: "whatsapp", draft: null },
    expiresAt: new Date(NOW.getTime() - HOUR),
  })
})

describe("lo que puede ver el modelo", () => {
  it("tacha importes en lo de Soporte, los deja en lo de Administración y omite lo que parece de un paciente", () => {
    expect(kairosAllowedFact("Pagaría S/ 120 al mes", { adminOnly: false })).toBe(
      "Pagaría [importe] al mes",
    )
    expect(kairosAllowedFact("Cuesta USD 29 o 35 dólares", { adminOnly: false })).toBe(
      "Cuesta [importe] o [importe]",
    )
    expect(kairosAllowedFact("Cuesta USD 29", { adminOnly: true })).toBe("Cuesta USD 29")
    expect(kairosAllowedFact("Su historia clínica dice…", { adminOnly: true })).toBeNull()
    expect(kairosAllowedFact("DNI 45678912", { adminOnly: true })).toBeNull()
    expect(kairosAllowedFact("Tiene 300 pacientes en Excel", { adminOnly: false })).toBe(
      "Tiene 300 pacientes en Excel",
    )
    expect(kairosAllowedFact("x".repeat(400), { adminOnly: false })?.length).toBe(300)
  })

  it("arma cada borrador con lo justo: sin notas de administración, sin el cuerpo de un correo que llegó", async () => {
    const jobs = await ownerDb.transaction((tx) => pendingKairosDraftJobs(tx, {}, NOW))
    expect(jobs.map((job) => job.itemId).sort()).toEqual(
      [ids.whatsapp, ids.correo, ids.guion, ids.falla].sort(),
    )
    const whatsapp = jobs.find((job) => job.itemId === ids.whatsapp)
    expect(whatsapp).toMatchObject({
      kind: "mensaje",
      goal: "primera_respuesta",
      channel: "whatsapp",
      contact: { name: "Rosa Quispe", title: "Gerente" },
      senderName: "Ada Administración",
      client: {
        name: "Clínica Borrador (ficticia)",
        product: "optical",
        city: "Arequipa",
        professionals: "2 a 3 profesionales",
        currentTool: "Cuaderno o Excel",
        stage: "Contacto",
      },
    })
    const told = whatsapp?.facts.join("\n") ?? ""
    expect(told).toContain("Pidió conocer el precio: [importe] al mes")
    expect(told).toContain("pagaría [importe] al mes")
    expect(told).toContain("Correo de la clínica el")
    expect(told).not.toMatch(/descuento|historia|DNI|12345678|S\/ 120|USD 29/)
    const correo = jobs.find((job) => job.itemId === ids.correo)
    const toldAdmin = correo?.facts.join("\n") ?? ""
    expect(toldAdmin).toContain("USD 29")
    expect(toldAdmin).toContain("20 % de descuento")
    expect(toldAdmin).not.toMatch(/historia|DNI/)
  })
})

describe("redactar lo que espera", () => {
  it("guarda cada borrador en su ítem, sin enviar nada; un fallo del modelo no frena a los demás", async () => {
    const { writer, seen } = recordingWriter(new Set(["retomar"]))
    const outcome = await draftPendingKairosItems(ownerDb, writer, {}, NOW)
    expect(outcome.drafted.sort()).toEqual([ids.whatsapp, ids.correo, ids.guion].sort())
    expect(outcome.failed).toEqual([{ itemId: ids.falla, error: "el modelo no respondió" }])
    expect(seen.filter((call) => call.op === "draftMessage")).toHaveLength(3)

    const [whatsapp] = await ownerDb
      .select()
      .from(kairosItem)
      .where(eq(kairosItem.id, idOf("whatsapp")))
    expect(whatsapp?.status).toBe("espera")
    expect(whatsapp?.payload).toMatchObject({
      draft: { subject: null, body: expect.stringContaining("Rosa Quispe") },
      subject: null,
    })
    const [correo] = await ownerDb
      .select()
      .from(kairosItem)
      .where(eq(kairosItem.id, idOf("correo")))
    expect(correo?.payload).toMatchObject({
      draft: { subject: "Asunto para Clínica Borrador (ficticia)" },
    })
    const [guion] = await ownerDb
      .select()
      .from(kairosItem)
      .where(eq(kairosItem.id, idOf("guion")))
    expect(guion?.payload).toMatchObject({
      draft: { body: "Guion para Clínica Borrador (ficticia) con sin demo" },
    })
    const audits = await ownerDb
      .select()
      .from(adminAudit)
      .where(eq(adminAudit.action, "kairos.draft_written"))
    expect(audits).toHaveLength(3)
    expect(audits.every((audit) => audit.actorUserId === null)).toBe(true)
  })

  it("otra pasada solo vuelve a pedir lo que falló", async () => {
    const { writer, seen } = recordingWriter()
    const outcome = await draftPendingKairosItems(ownerDb, writer, {}, NOW)
    expect(outcome).toEqual({ drafted: [ids.falla], skipped: [], failed: [] })
    expect(seen).toHaveLength(1)
  })

  it("respeta el tope de la pasada", async () => {
    await item("tope-1", idOf("client"), {
      kind: "mensaje",
      reason: "Uno",
      payload: { goal: "retomar", channel: "whatsapp", draft: null },
    })
    await item("tope-2", idOf("client"), {
      kind: "mensaje",
      reason: "Dos",
      payload: { goal: "retomar", channel: "whatsapp", draft: null },
    })
    const { writer } = recordingWriter()
    const outcome = await draftPendingKairosItems(ownerDb, writer, { limit: 1 }, NOW)
    expect(outcome.drafted).toEqual([ids["tope-1"]])
  })
})

describe("el resumen de la semana", () => {
  it("la semana empieza el lunes, en Lima", () => {
    // Lunes 9 de noviembre de 2026, 03:00 en UTC: todavía domingo 8 en Lima.
    expect(kairosWeekStart(new Date("2026-11-09T03:00:00Z"))).toBe("2026-11-02")
    expect(kairosWeekStart(new Date("2026-11-09T06:00:00Z"))).toBe("2026-11-09")
    expect(kairosWeekStart(new Date("2026-11-15T20:00:00Z"))).toBe("2026-11-09")
  })

  it("se escribe una vez con las cifras del cálculo; el modelo solo las cita", async () => {
    const { writer, seen } = recordingWriter()
    const first = await writeKairosWeekly(ownerDb, writer, NOW)
    expect(first.written).toBe(true)
    expect(first.row.weekStart).toBe(kairosWeekStart(NOW))
    const figures = (seen[0]?.input.figures ?? []) as Array<{ label: string; words: string }>
    expect(figures.length).toBeGreaterThan(5)
    expect(figures.map((figure) => figure.label)).toContain("Propuestas enviadas vigentes")
    expect(first.row.figures).toEqual(figures)
    expect(first.row.text).toContain("Esta semana:")

    const again = await writeKairosWeekly(ownerDb, writer, NOW)
    expect(again.written).toBe(false)
    expect(seen).toHaveLength(1)
    const [audit] = await ownerDb
      .select()
      .from(adminAudit)
      .where(eq(adminAudit.action, "kairos.weekly_written"))
    expect(audit).toMatchObject({ actorUserId: null, entityId: first.row.weekStart })
  })

  it("lo lee Administración; Soporte no", async () => {
    const latest = await ownerDb.transaction((tx) => latestKairosWeekly(tx, admin))
    expect(latest?.weekStart).toBe(kairosWeekStart(NOW))
    await expect(ownerDb.transaction((tx) => latestKairosWeekly(tx, support))).rejects.toThrow(
      ServiceError,
    )
  })

  it("la base exige un lunes y un texto, y la app no alcanza la tabla", async () => {
    await expect(
      ownerDb.insert(kairosWeekly).values({ weekStart: "2026-11-10", text: "Martes" }),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "kairos_weekly_monday_check" },
    })
    await expect(
      ownerDb.insert(kairosWeekly).values({ weekStart: "2026-10-26", text: "   " }),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint_name: "kairos_weekly_text_check" },
    })
    const [row] = [
      ...(await ownerDb.execute<{ reach: boolean }>(
        sql`select has_table_privilege('dentalagent_app', 'admin.kairos_weekly', 'select, insert, update, delete') as reach`,
      )),
    ]
    expect(row?.reach).toBe(false)
  })
})
