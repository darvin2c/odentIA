import {
  kairosItem,
  kairosWeekly,
  saasClient,
  saasClientContact,
  saasInboundEmail,
  saasOpportunity,
  saasOutreach,
} from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import { eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import { decideKairosItem, kairosRulesPass } from "./admin-kairos.js"
import {
  draftPendingKairosItems,
  type KairosDraftWriter,
  type KairosWeeklyWriter,
  kairosAllowedEmailText,
  kairosAllowedFact,
  kairosWeekStart,
  latestKairosWeekly,
  pendingKairosDraftJobs,
  pendingKairosReplyJobs,
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
    async draftReply(input) {
      seen.push({ op: "draftReply", input: { ...input } })
      return { body: "Gracias por tu correo." }
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
      // El motivo repetido en sus hechos viaja una sola vez.
      facts: ["La propuesta vale hasta el viernes", "La propuesta cuesta USD 29 al mes"],
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
    // Lo que pasaba en la medición del 12 nov: el número con espacios y el monto sin moneda.
    expect(kairosAllowedFact("Su número es 4567 8912", { adminOnly: true })).toBeNull()
    expect(kairosAllowedFact("Le cobramos 350 y debe 1.180", { adminOnly: false })).toBe(
      "Le cobramos [importe] y debe [importe]",
    )
    expect(kairosAllowedFact("Le cobramos 350", { adminOnly: true })).toBe("Le cobramos 350")
    expect(kairosAllowedFact("Tienen 4 sedes y 12 profesionales", { adminOnly: false })).toBe(
      "Tienen 4 sedes y 12 profesionales",
    )
    // Un paciente con su nombre no viaja; «sus pacientes» en la venta, sí.
    expect(
      kairosAllowedFact("La paciente Juana Pérez tiene caries en la 16", { adminOnly: true }),
    ).toBeNull()
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
    // La fecha va en palabras: la plantilla la copia tal cual a la pantalla.
    expect(told).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(told).toMatch(/Llamada del \d{1,2} de [a-z]+ de \d{4}/)
    expect(told).not.toMatch(/descuento|historia|DNI|12345678|S\/ 120|USD 29/)
    const correo = jobs.find((job) => job.itemId === ids.correo)
    const toldAdmin = correo?.facts.join("\n") ?? ""
    expect(toldAdmin).toContain("USD 29")
    expect(toldAdmin).toContain("20 % de descuento")
    expect(
      correo?.facts.filter((fact) => fact === "La propuesta vale hasta el viernes"),
    ).toHaveLength(1)
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
    expect(outcome).toEqual({ drafted: [ids.falla], skipped: [], failed: [], drafter: "modelo" })
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

describe("la respuesta a un correo que llegó", () => {
  it("del correo viaja solo lo que pasa el filtro, sin lo citado", () => {
    const text = [
      "Hola, somos una óptica con 3 sedes.",
      "El plan de USD 29 nos sirve.",
      "Mi paciente con DNI 44556677 no aparece.",
      "",
      "> Lo que les escribimos antes",
      "El lun, 9 nov 2026, Ada <ada@odentia32.com> escribió:",
      "Esto ya es el correo citado",
    ].join("\n")
    expect(kairosAllowedEmailText(text, { adminOnly: true })).toEqual({
      lines: ["Hola, somos una óptica con 3 sedes.", "El plan de USD 29 nos sirve."],
      omitted: 1,
    })
    expect(kairosAllowedEmailText(text, { adminOnly: false }).lines).toContain(
      "El plan de [importe] nos sirve.",
    )
    // Un párrafo largo se mira frase por frase: solo se quita la del paciente.
    const long = `${"Queremos ordenar la agenda de la óptica. ".repeat(6)}La paciente Juana Pérez tiene su receta vencida. ¿Cómo empezamos?`
    const read = kairosAllowedEmailText(long, { adminOnly: true })
    expect(read.omitted).toBe(1)
    expect(read.lines.at(-1)).toBe("¿Cómo empezamos?")
    expect(read.lines.join(" ")).not.toContain("Juana")
    expect(kairosAllowedEmailText(null, { adminOnly: true })).toEqual({ lines: [], omitted: 0 })
  })

  it("Kairós la prepara una vez por correo, sin firma ni hechos internos, y no vale si alguien ya respondió", async () => {
    const at = new Date(NOW.getTime() - 2 * HOUR)
    const emails = await ownerDb
      .insert(saasInboundEmail)
      .values([
        {
          mailbox: "persona",
          staffUserId: admin.userId,
          product: "optical",
          clientId: ids.client,
          messageId: "<kd-persona@example.test>",
          fromAddress: "rosa@drafts.test",
          fromName: "Rosa Quispe",
          toAddress: "ada@vistia20.com",
          subject: "La demo del jueves",
          textBody: "Ada, ¿podemos ver la demo con mi socio?",
          senderVerified: true,
          receivedAt: at,
        },
        {
          mailbox: "contacto",
          product: "optical",
          messageId: "<kd-respondido@example.test>",
          fromAddress: "otra@example.test",
          toAddress: "contacto@vistia20.com",
          subject: "Ya le respondimos",
          receivedAt: at,
        },
        {
          mailbox: "hola",
          product: "optical",
          messageId: "<kd-viejo@example.test>",
          fromAddress: "vieja@example.test",
          toAddress: "hola@vistia20.com",
          subject: "Llegó hace días",
          receivedAt: new Date(NOW.getTime() - 72 * HOUR),
        },
      ])
      .returning({ id: saasInboundEmail.id, messageId: saasInboundEmail.messageId })
    const idOfMail = (messageId: string) =>
      emails.find((email) => email.messageId === messageId)?.id ?? ""
    await ownerDb.insert(saasOutreach).values({
      channel: "correo",
      toAddress: "otra@example.test",
      body: "Gracias, te escribimos pronto",
      inReplyToEmailId: idOfMail("<kd-respondido@example.test>"),
    })
    await ownerDb.transaction((tx) => kairosRulesPass(tx, NOW))
    await ownerDb.transaction((tx) => kairosRulesPass(tx, new Date(NOW.getTime() + 60_000)))
    const prepared = await ownerDb
      .select()
      .from(kairosItem)
      .where(eq(kairosItem.kind, "responder_correo"))
    // Ni lo ya respondido ni lo que llegó hace más de 48 h; y una sola vez.
    expect(prepared).toHaveLength(1)
    const [reply] = prepared
    expect(reply).toMatchObject({ clientId: ids.client, adminOnly: true, status: "espera" })
    expect(reply?.reason).toContain("Le escribió a ada@ de vistIA")

    const jobs = await ownerDb.transaction((tx) => pendingKairosReplyJobs(tx, {}, NOW))
    const job = jobs.find((entry) => entry.itemId === reply?.id)
    expect(job?.ask).toMatchObject({
      product: "optical",
      mailbox: "ada@",
      subject: "La demo del jueves",
      lines: ["Ada, ¿podemos ver la demo con mi socio?"],
      omitted: 0,
      // Solo lo que se le podría decir a quien escribe: el correo puede pedir que lo repita.
      facts: [],
      client: {
        name: "Clínica Borrador (ficticia)",
        product: "optical",
        stage: "Contacto",
        city: null,
        professionals: null,
        currentTool: null,
      },
    })
    expect(JSON.stringify(job?.ask)).not.toMatch(/descuento|120|Arequipa|senderName/)
    const { writer, seen } = recordingWriter()
    const outcome = await draftPendingKairosItems(ownerDb, writer, { limit: 50 }, NOW)
    expect(outcome.drafted).toContain(reply?.id)
    expect(seen.filter((call) => call.op === "draftReply")).toHaveLength(1)
    const [drafted] = await ownerDb
      .select()
      .from(kairosItem)
      .where(eq(kairosItem.id, reply?.id ?? ""))
    expect(drafted?.payload.body).toBe("Gracias por tu correo.")

    // Si alguien la respondió a mano mientras tanto, el sí ya no vale.
    await ownerDb.insert(saasOutreach).values({
      clientId: ids.client,
      channel: "correo",
      toAddress: "rosa@drafts.test",
      body: "Sí, el jueves a las 10",
      inReplyToEmailId: idOfMail("<kd-persona@example.test>"),
    })
    const unused = () => {
      throw new Error("no se ejecuta")
    }
    const decision = await ownerDb.transaction((tx) =>
      decideKairosItem(
        tx,
        admin,
        reply?.id ?? "",
        { action: "aprobar" },
        {
          prepareOutreach: unused,
          updateClient: unused,
          linkContactToUser: unused,
          assignInboundEmail: unused,
          prepareEmailReply: unused,
          recordPresentation: unused,
          createProposal: unused,
        },
        NOW,
      ),
    )
    expect(decision.status).toBe("vencida")
    // Y no se vuelve a preparar.
    await ownerDb.transaction((tx) => kairosRulesPass(tx, new Date(NOW.getTime() + 120_000)))
    const after = await ownerDb
      .select({ id: kairosItem.id })
      .from(kairosItem)
      .where(eq(kairosItem.kind, "responder_correo"))
    expect(after).toHaveLength(1)
  })

  it("no la prepara para un remitente sin verificar, y como mucho una en espera por remitente", async () => {
    const at = new Date(NOW.getTime() - HOUR)
    const emails = await ownerDb
      .insert(saasInboundEmail)
      .values([
        {
          mailbox: "hola",
          product: "optical",
          messageId: "<kd-sin-verificar@example.test>",
          fromAddress: "quien.sea@example.test",
          toAddress: "hola@vistia20.com",
          subject: "Ganaste un premio",
          senderVerified: false,
          receivedAt: at,
        },
        ...[1, 2, 3].map((n) => ({
          mailbox: "contacto",
          product: "optical",
          messageId: `<kd-insiste-${n}@example.test>`,
          fromAddress: "insiste@example.test",
          toAddress: "contacto@vistia20.com",
          subject: `Insisto ${n}`,
          senderVerified: true,
          receivedAt: new Date(at.getTime() + n * 60_000),
        })),
      ])
      .returning({ id: saasInboundEmail.id, from: saasInboundEmail.fromAddress })
    const later = new Date(NOW.getTime() + 180_000)
    await ownerDb.transaction((tx) => kairosRulesPass(tx, later))
    await ownerDb.transaction((tx) => kairosRulesPass(tx, new Date(later.getTime() + 60_000)))
    const mine = new Set(emails.map((email) => email.id))
    const prepared = (
      await ownerDb.select().from(kairosItem).where(eq(kairosItem.kind, "responder_correo"))
    ).filter((row) => mine.has(String(row.payload.emailId)))
    // Ni el sin verificar ni una por cada correo del que insiste: la del primero.
    expect(prepared).toHaveLength(1)
    expect(prepared[0]?.payload).toMatchObject({
      from: "insiste@example.test",
      subject: "Insisto 1",
    })
  })
})
