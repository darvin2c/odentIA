import { adminAudit } from "@odentia/db/schema/admin-core"
import { consumerComplaint, consumerComplaintCounter } from "@odentia/db/schema/consumer-complaints"
import { and, eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import {
  type ConsumerComplaintInput,
  consumerComplaintEmails,
  consumerComplaintResponseEmails,
  consumerComplaintTimeline,
  getConsumerComplaint,
  listConsumerComplaints,
  markComplaintEmailSent,
  markComplaintResponseEmailSent,
  prepareComplaintResponseResend,
  respondConsumerComplaint,
  submitConsumerComplaint,
} from "./consumer-complaints.js"
import { ServiceError } from "./errors.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

function sheet(overrides: Partial<ConsumerComplaintInput> = {}): ConsumerComplaintInput {
  return {
    submissionId: crypto.randomUUID(),
    kind: "reclamo",
    consumerName: "Rosa Díaz Quispe",
    consumerAddress: "Av. Larco 123, Miraflores, Lima",
    documentType: "DNI",
    documentNumber: "45678912",
    phone: "+51 987 654 321",
    email: "Rosa@Ejemplo.pe",
    isMinor: false,
    itemType: "servicio",
    itemDescription: "Suscripción mensual de odentIA",
    amount: "150.5",
    currency: "PEN",
    detail: "Me cobraron dos veces la suscripción del mes de octubre.",
    request: "Que me devuelvan el cobro duplicado.",
    privacyAccepted: true,
    ...overrides,
  }
}

const submit = (input: unknown) => ownerDb.transaction((tx) => submitConsumerComplaint(tx, input))

async function rejection(input: unknown): Promise<ServiceError> {
  const error = await submit(input).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ServiceError)
  return error as ServiceError
}

describe("Libro de Reclamaciones", () => {
  it("guarda la hoja con su correlativo del año y normaliza lo escrito", async () => {
    const { sheet: saved, created } = await submit(sheet())
    expect(created).toBe(true)
    expect(saved.number).toMatch(/^\d{4}-\d{6}$/)
    expect(saved.number.startsWith(`${saved.year}-`)).toBe(true)
    expect(saved.status).toBe("recibido")
    expect(saved.emailSent).toBe(false)
    expect(saved.email).toBe("rosa@ejemplo.pe")
    expect(saved.amountMinor).toBe(15050)
    expect(saved.amountCurrency).toBe("PEN")
    expect(saved.guardianName).toBeNull()
    expect(saved.privacyAcceptedAt).toBeInstanceOf(Date)
  })

  it("numera sin huecos ni repetidos con envíos simultáneos", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => submit(sheet())))
    const sequences = results.map((r) => Number(r.sheet.number.split("-")[1])).sort((a, b) => a - b)
    expect(new Set(sequences).size).toBe(8)
    for (let i = 1; i < sequences.length; i++) expect(sequences[i]).toBe(sequences[i - 1]! + 1)
    const year = results[0]!.sheet.year
    const [counter] = await ownerDb
      .select({ value: consumerComplaintCounter.value })
      .from(consumerComplaintCounter)
      .where(eq(consumerComplaintCounter.year, year))
    expect(counter?.value).toBe(sequences.at(-1))
  })

  it("una hoja rechazada no consume número", async () => {
    const before = await submit(sheet())
    await rejection(sheet({ kind: "sugerencia" as never }))
    const after = await submit(sheet())
    expect(Number(after.sheet.number.split("-")[1])).toBe(
      Number(before.sheet.number.split("-")[1]) + 1,
    )
  })

  it("es idempotente por submissionId, también en envíos simultáneos", async () => {
    const input = sheet()
    const first = await submit(input)
    const again = await submit({
      ...input,
      detail: "Otro texto que no debe reemplazar la hoja original.",
    })
    expect(again.created).toBe(false)
    expect(again.sheet.id).toBe(first.sheet.id)
    expect(again.sheet.detail).toBe(first.sheet.detail)

    const twin = sheet()
    const [a, b] = await Promise.all([submit(twin), submit(twin)])
    expect(a.sheet.id).toBe(b.sheet.id)
    expect([a.created, b.created].sort()).toEqual([false, true])
    const rows = await ownerDb
      .select({ id: consumerComplaint.id })
      .from(consumerComplaint)
      .where(eq(consumerComplaint.submissionId, twin.submissionId!))
    expect(rows).toHaveLength(1)
  })

  it("un menor de edad reclama con el nombre de su padre, madre o apoderado", async () => {
    const error = await rejection(sheet({ isMinor: true, guardianName: "  " }))
    expect(error.status).toBe(400)
    expect(error.message).toMatch(/padre, madre o apoderado/)
    const { sheet: saved } = await submit(sheet({ isMinor: true, guardianName: "Carmen Quispe" }))
    expect(saved.isMinor).toBe(true)
    expect(saved.guardianName).toBe("Carmen Quispe")
    // La base también lo exige, aunque alguien escriba sin pasar por el servicio.
    await expect(
      ownerDb.execute(
        sql`update consumer_complaint set guardian_name = null where id = ${saved.id}`,
      ),
    ).rejects.toThrow()
  })

  it("rechaza tipo, documento, aceptación y monto inválidos con mensajes en español", async () => {
    expect((await rejection(sheet({ kind: "sugerencia" as never }))).message).toMatch(
      /reclamo o una queja/,
    )
    expect((await rejection(sheet({ documentNumber: "1234" }))).message).toBe(
      "El DNI tiene 8 dígitos",
    )
    expect((await rejection(sheet({ privacyAccepted: false as never }))).message).toMatch(
      /tratamiento de tus datos/,
    )
    expect((await rejection(sheet({ amount: "12.345" }))).message).toMatch(/monto/)
    expect((await rejection(sheet({ currency: null }))).message).toMatch(/moneda/)
    expect((await rejection({ ...sheet(), extra: "no" })).status).toBe(400)
    const { sheet: noAmount } = await submit(sheet({ amount: "", currency: null }))
    expect(noAmount.amountMinor).toBeNull()
    expect(noAmount.amountCurrency).toBeNull()
  })

  it("marca la copia enviada y arma correos con lo escrito escapado", async () => {
    const { sheet: saved } = await submit(
      sheet({
        consumerName: "Ana <script>alert(1)</script>",
        detail: "Detalle con <b>etiquetas</b> & símbolos.",
      }),
    )
    await ownerDb.transaction((tx) => markComplaintEmailSent(tx, saved.id))
    const [row] = await ownerDb
      .select()
      .from(consumerComplaint)
      .where(eq(consumerComplaint.id, saved.id))
    expect(row?.emailSent).toBe(true)
    const { copy, notice } = consumerComplaintEmails(row!)
    expect(copy.subject).toContain(saved.number)
    expect(copy.html).not.toContain("<script>")
    expect(copy.html).toContain("&lt;script&gt;")
    expect(copy.html).toContain("quince (15) días hábiles improrrogables")
    expect(copy.text).toContain("INDECOPI")
    expect(copy.text).toContain("[Por completar: RUC]")
    expect(notice.subject).toContain("Reclamo")
  })

  it("el rol de la aplicación no puede leer ni escribir el libro", async () => {
    const read = await appDb
      .select()
      .from(consumerComplaint)
      .limit(1)
      .catch((e: unknown) => e)
    const err = read as { cause?: { code?: string }; message?: string }
    expect(err?.cause?.code ?? err?.message).toMatch(/42501|permission denied/i)
    const counter = await appDb
      .select()
      .from(consumerComplaintCounter)
      .limit(1)
      .catch((e: unknown) => e)
    const counterErr = counter as { cause?: { code?: string }; message?: string }
    expect(counterErr?.cause?.code ?? counterErr?.message).toMatch(/42501|permission denied/i)
  })
})

describe("Libro de Reclamaciones en la administración", () => {
  const darvin: AdminActor = { userId: "u-libro-darvin", role: "admin" }
  const soporte: AdminActor = { userId: "u-libro-soporte", role: "support" }

  beforeAll(async () => {
    for (const [id, name] of [
      [darvin.userId, "Darvin"],
      [soporte.userId, "Sofía de Soporte"],
    ]) {
      await ownerDb.execute(
        sql`insert into "user" (id, name, email, email_verified) values (${id}, ${name}, ${`${id}@example.test`}, true) on conflict (id) do nothing`,
      )
    }
  })

  /** Guarda una hoja y la fecha como llegada en `createdAt`. */
  async function received(createdAt: Date, overrides: Partial<ConsumerComplaintInput> = {}) {
    const { sheet: saved } = await submit(sheet(overrides))
    await ownerDb.execute(
      sql`update consumer_complaint set created_at = ${createdAt.toISOString()} where id = ${saved.id}`,
    )
    return saved
  }

  const auditOf = (action: string, entityId: string) =>
    ownerDb
      .select()
      .from(adminAudit)
      .where(and(eq(adminAudit.action, action), eq(adminAudit.entityId, entityId)))

  it("calcula el plazo con los días hábiles de Perú", () => {
    // Llegó el jueves 1 de octubre de 2026 a las 10:00 de Lima.
    const createdAt = new Date("2026-10-01T15:00:00Z")
    const pending = consumerComplaintTimeline({ createdAt, respondedAt: null }, new Date("2026-10-17T15:00:00Z"))
    expect(pending).toEqual({ dueDate: "2026-10-23", daysLeft: 5, overdue: false, respondedOnTime: null })
    const late = consumerComplaintTimeline({ createdAt, respondedAt: null }, new Date("2026-10-24T15:00:00Z"))
    expect(late.overdue).toBe(true)
    expect(late.daysLeft).toBe(0)
    const answered = consumerComplaintTimeline(
      { createdAt, respondedAt: new Date("2026-10-26T15:00:00Z") },
      new Date("2026-10-27T15:00:00Z"),
    )
    expect(answered.overdue).toBe(false)
    expect(answered.respondedOnTime).toBe(false)
  })

  it("lista primero la que vence antes, busca y audita sin el texto buscado", async () => {
    const now = new Date()
    const day = 86_400_000
    const older = await received(new Date(now.getTime() - 40 * day), { consumerName: "Rosa Huamán Paredes" })
    const newer = await received(new Date(now.getTime() - 2 * day), { consumerName: "Lucía Ramos Torres" })
    const { items, summary } = await ownerDb.transaction((tx) =>
      listConsumerComplaints(tx, soporte, { status: "recibido", limit: 100 }),
    )
    const ids = items.map((item) => item.id)
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id))
    expect(items.find((item) => item.id === older.id)?.timeline.overdue).toBe(true)
    expect(summary.overdue).toBeGreaterThanOrEqual(1)
    expect(summary.pending).toBeGreaterThanOrEqual(2)

    const found = await ownerDb.transaction((tx) =>
      listConsumerComplaints(tx, soporte, { status: "todas", search: "lucía ramos" }),
    )
    expect(found.items.map((item) => item.id)).toEqual([newer.id])
    const byNumber = await ownerDb.transaction((tx) =>
      listConsumerComplaints(tx, soporte, { status: "todas", search: newer.number }),
    )
    expect(byNumber.items.map((item) => item.id)).toEqual([newer.id])
    // El comodín escrito no abre la búsqueda a todo el libro.
    const wildcard = await ownerDb.transaction((tx) =>
      listConsumerComplaints(tx, soporte, { status: "todas", search: "%" }),
    )
    expect(wildcard.items).toHaveLength(0)

    const audits = await ownerDb
      .select()
      .from(adminAudit)
      .where(and(eq(adminAudit.action, "consumer_complaint.list"), eq(adminAudit.actorUserId, soporte.userId)))
    expect(audits.length).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(audits.map((a) => a.metadata))).not.toContain("lucía")
  })

  it("ver una hoja queda auditado y una que no existe es 404", async () => {
    const saved = await received(new Date())
    const detail = await ownerDb.transaction((tx) => getConsumerComplaint(tx, darvin, saved.id))
    expect(detail.documentNumber).toBe("45678912")
    expect(detail.respondedByName).toBeNull()
    expect(await auditOf("consumer_complaint.view", saved.id)).toHaveLength(1)
    const missing = await ownerDb
      .transaction((tx) => getConsumerComplaint(tx, darvin, "no-es-un-id"))
      .catch((e: unknown) => e)
    expect((missing as ServiceError).status).toBe(404)
  })

  it("responder llena el bloque 4, deja quién respondió y no se puede responder dos veces", async () => {
    const saved = await received(new Date())
    const answer = "Revisamos tu cuenta: hubo un cobro duplicado y ya pedimos la devolución."
    const detail = await ownerDb.transaction((tx) =>
      respondConsumerComplaint(tx, darvin, saved.id, { response: `  ${answer}  ` }),
    )
    expect(detail.status).toBe("respondido")
    expect(detail.providerResponse).toBe(answer)
    expect(detail.respondedAt).toBeInstanceOf(Date)
    expect(detail.respondedByName).toBe("Darvin")
    expect(detail.responseEmailSent).toBe(false)
    expect(detail.timeline.respondedOnTime).toBe(true)
    const [audit] = await auditOf("consumer_complaint.respond", saved.id)
    expect(audit?.actorUserId).toBe(darvin.userId)
    expect(JSON.stringify(audit?.metadata)).not.toContain("devolución")

    const again = await ownerDb
      .transaction((tx) => respondConsumerComplaint(tx, soporte, saved.id, { response: answer }))
      .catch((e: unknown) => e)
    expect((again as ServiceError).status).toBe(409)
    expect((again as ServiceError).message).toBe("Darvin ya respondió esta hoja")
  })

  it("dos respuestas a la vez: solo una queda", async () => {
    const saved = await received(new Date())
    const results = await Promise.allSettled([
      ownerDb.transaction((tx) => respondConsumerComplaint(tx, darvin, saved.id, { response: "Primera respuesta del equipo." })),
      ownerDb.transaction((tx) => respondConsumerComplaint(tx, soporte, saved.id, { response: "Segunda respuesta del equipo." })),
    ])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(await auditOf("consumer_complaint.respond", saved.id)).toHaveLength(1)
  })

  it("la base no deja cambiar una respuesta enviada", async () => {
    const saved = await received(new Date())
    await ownerDb.transaction((tx) =>
      respondConsumerComplaint(tx, darvin, saved.id, { response: "Respuesta que queda en el libro." }),
    )
    await expect(
      ownerDb.execute(sql`update consumer_complaint set provider_response = 'otra' where id = ${saved.id}`),
    ).rejects.toThrow()
    await expect(
      ownerDb.execute(sql`update consumer_complaint set status = 'recibido' where id = ${saved.id}`),
    ).rejects.toThrow()
    // Marcar el correo sí se puede.
    await ownerDb.transaction((tx) => markComplaintResponseEmailSent(tx, saved.id))
  })

  it("valida la respuesta y solo reenvía lo que no salió", async () => {
    const saved = await received(new Date())
    const short = await ownerDb
      .transaction((tx) => respondConsumerComplaint(tx, darvin, saved.id, { response: "ok" }))
      .catch((e: unknown) => e)
    expect((short as ServiceError).status).toBe(400)
    const early = await ownerDb
      .transaction((tx) => prepareComplaintResponseResend(tx, darvin, saved.id))
      .catch((e: unknown) => e)
    expect((early as ServiceError).status).toBe(409)

    await ownerDb.transaction((tx) =>
      respondConsumerComplaint(tx, darvin, saved.id, { response: "Respuesta cuyo correo falló." }),
    )
    await ownerDb.transaction((tx) => prepareComplaintResponseResend(tx, soporte, saved.id))
    expect(await auditOf("consumer_complaint.response_email.resend", saved.id)).toHaveLength(1)
    await ownerDb.transaction((tx) => markComplaintResponseEmailSent(tx, saved.id))
    const done = await ownerDb
      .transaction((tx) => prepareComplaintResponseResend(tx, soporte, saved.id))
      .catch((e: unknown) => e)
    expect((done as ServiceError).status).toBe(409)
  })

  it("el correo de respuesta lleva la respuesta escapada y la hoja con el bloque 4", async () => {
    const saved = await received(new Date())
    const detail = await ownerDb.transaction((tx) =>
      respondConsumerComplaint(tx, darvin, saved.id, {
        response: "Hola, Rosa. <script>x</script> Ya pedimos la devolución.",
      }),
    )
    const { response, copy } = consumerComplaintResponseEmails(detail)
    expect(response.subject).toBe(`Respuesta a tu Hoja de Reclamación N.º ${saved.number} — odentIA`)
    expect(response.html).not.toContain("<script>")
    expect(response.html).toContain("&lt;script&gt;x&lt;/script&gt;")
    expect(response.text).toContain("NUESTRA RESPUESTA")
    expect(response.text).toContain("Respuesta: Hola, Rosa.")
    expect(response.text).toContain("INDECOPI")
    expect(copy.subject).toContain(saved.number)
    expect(copy.text).toContain("rosa@ejemplo.pe")
  })

  it("una persona sin rol del personal no entra", async () => {
    const stranger = { userId: "u-libro-otro", role: "owner" } as unknown as AdminActor
    const error = await ownerDb
      .transaction((tx) => listConsumerComplaints(tx, stranger))
      .catch((e: unknown) => e)
    expect((error as ServiceError).status).toBe(403)
  })
})
