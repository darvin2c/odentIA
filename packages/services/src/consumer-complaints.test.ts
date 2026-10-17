import { consumerComplaint, consumerComplaintCounter } from "@odentia/db/schema/consumer-complaints"
import { eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import {
  type ConsumerComplaintInput,
  consumerComplaintEmails,
  markComplaintEmailSent,
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
