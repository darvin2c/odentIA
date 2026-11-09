import { withOrgContext } from "@odentia/db"
import {
  JOB_ORDER_LINE_KINDS,
  JOB_ORDER_STEPS,
  advanceJobOrder,
  createJobOrderSale,
  getJobOrder,
  jobOrderPatientId,
  listJobOrders,
  remakeJobOrder,
  saleReferencesOf,
  sendOrderReadyNotice,
  voidJobOrder,
} from "@odentia/services"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { traceClinicalRead } from "../lib/clinical-trace.js"
import { patientLockRefusal } from "../lib/record-lock.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

/**
 * El pedido al taller o al laboratorio (ADR 0171), común a los productos; vistIA
 * lo usa con los lentes. Verlo es de `orders.read`; venderlo crea cargos y cobra
 * el adelanto, así que pide además la caja (`finance.write`), como anular (anula sus
 * cargos) y rehacer (decide no cobrar otra vez): el taller marca cómo va y nada
 * más. Copiar la receta en el pedido pide verla: la vigente (`clinical.prescription`,
 * Ventas) o la historia; leer la copia, además, quien hace el pedido
 * (`orders.prescription`, Taller), y queda en «Consultas a la historia». Lo que
 * falta pagar solo lo ve quien ve la caja.
 */
const text = (max: number) => z.string().trim().max(max)
const saleInput = z
  .object({
    patientId: z.uuid(),
    branchId: z.uuid(),
    requestId: z.uuid(),
    title: text(200),
    maker: text(200),
    promisedOn: z.iso.date("Elige la fecha en el calendario."),
    lines: z
      .array(
        z
          .object({
            kind: z.enum(JOB_ORDER_LINE_KINDS),
            productId: z.uuid().nullish(),
            quantity: z.number().int().min(1).max(99).nullish(),
            description: text(200).nullish(),
            amountCents: z.number().int().min(0).nullish(),
          })
          .strict(),
      )
      .min(1, "Agrega lo que lleva el pedido.")
      .max(20),
    referenceId: z.uuid().nullish(),
    fitting: z.record(z.string(), z.union([z.number(), z.string().max(60)])).nullish(),
    notes: text(2000).nullish(),
    payments: z
      .array(
        z
          .object({ paymentMethodId: z.uuid(), amountCents: z.number().int().positive(), reference: text(120).nullish() })
          .strict(),
      )
      .max(10)
      .optional(),
    cashReceivedCents: z.number().int().min(0).optional(),
    payerContactId: z.uuid().nullish(),
  })
  .strict()
const advanceInput = z.object({ status: z.enum(JOB_ORDER_STEPS), note: text(2000).nullish() }).strict()
const reasonInput = z.object({ reason: z.string().trim().min(1, "Escribe el motivo.").max(2000) }).strict()
const remakeInput = z
  .object({
    reason: z.string().trim().min(1, "Escribe por qué se rehace.").max(2000),
    promisedOn: z.iso.date("Elige la fecha en el calendario."),
    maker: text(200).optional(),
    requestId: z.uuid(),
  })
  .strict()
const noticeInput = z.object({ confirmDoubtful: z.boolean().optional() }).strict()
const LIST_STATUS = ["abiertos", "atrasados", ...JOB_ORDER_STEPS, "anulado"] as const

const FORBIDDEN = {
  read: "No tienes permiso para ver los pedidos",
  write: "No tienes permiso para cambiar los pedidos",
  sell: "No tienes permiso para vender: hace falta la caja",
  prescription: "No tienes permiso para ver la receta de esta persona",
  money: "No tienes permiso: anular o rehacer un pedido es de quien lleva la caja",
}

export function createOrdersRoute(deps: CrmDeps) {
  const app = new Hono()
  const deny = (c: Context, message: string) => c.json(errorBody(c, "FORBIDDEN", message), 403)
  const seesPrescription = (role: string) => canAccessAny(role, ["clinical.prescription", "clinical.read"])
  const seesMoney = (role: string) => canAccess(role, "finance.read")
  const readsCopy = (role: string) => canAccessAny(role, ["orders.prescription", "clinical.prescription", "clinical.read"])
  /** El pedido como lo ve quien pide; si le llega la copia de la receta, queda en «Consultas a la historia». */
  const detail = async (c: Context, id: string) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const order = await withOrgContext(deps.db, orgId, (tx) =>
      getJobOrder(tx, orgId, id, { withMoney: seesMoney(memberRole), withPrescription: readsCopy(memberRole) }),
    )
    if (order.prescription) await traceClinicalRead(deps.db, { orgId, userId, patientId: order.patientId, resource: "recetas" })
    return order
  }
  /** Un pedido de una historia bloqueada no existe para los demás (ADR 0080). */
  const lockedOrder = async (c: Context, id: string) => {
    const { orgId } = orgContextOf(c)
    const patientId = await withOrgContext(deps.db, orgId, (tx) => jobOrderPatientId(tx, orgId, id))
    return patientLockRefusal(c, deps.db, patientId ?? undefined, "Pedido no encontrado")
  }

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "orders.read")) return deny(c, FORBIDDEN.read)
    const status = c.req.query("status")
    const patientId = c.req.query("patientId")
    if (status && !(LIST_STATUS as readonly string[]).includes(status))
      return c.json(errorBody(c, "VALIDATION", "El filtro de pedidos no es válido"), 400)
    if (patientId && !z.uuid().safeParse(patientId).success)
      return c.json(errorBody(c, "VALIDATION", "La persona del filtro no es válida"), 400)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listJobOrders(tx, orgId, {
          status: status as (typeof LIST_STATUS)[number] | undefined,
          patientId: patientId ?? null,
          withMoney: seesMoney(memberRole),
        }),
      ),
    )
  })

  /** Lo que se ofrece copiar en el pedido de una persona (vistIA: sus recetas vigentes). */
  app.get("/references", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "orders.write") || !seesPrescription(memberRole)) return deny(c, FORBIDDEN.prescription)
    const patientId = z.uuid().safeParse(c.req.query("patientId"))
    if (!patientId.success) return c.json(errorBody(c, "VALIDATION", "Elige a la persona"), 400)
    const { userId } = orgContextOf(c)
    return runService(c, 200, async () => {
      const references = await withOrgContext(deps.db, orgId, (tx) => saleReferencesOf(tx, orgId, patientId.data))
      if (references.length) await traceClinicalRead(deps.db, { orgId, userId, patientId: patientId.data, resource: "recetas" })
      return references
    })
  })

  app.post("/sale", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "orders.write")) return deny(c, FORBIDDEN.write)
    if (!canAccess(memberRole, "finance.write")) return deny(c, FORBIDDEN.sell)
    const parsed = saleInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { patientId, ...input } = parsed.data
    if (input.referenceId && !seesPrescription(memberRole)) return deny(c, FORBIDDEN.prescription)
    return runService(c, 201, async () => {
      const sale = await withOrgContext(deps.db, orgId, (tx) => createJobOrderSale(tx, orgId, userId, patientId, input))
      return { ...sale, order: await detail(c, sale.order.id) }
    })
  })

  app.get("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "orders.read")) return deny(c, FORBIDDEN.read)
    const id = c.req.param("id")
    if (!z.uuid().safeParse(id).success) return c.json(errorBody(c, "NOT_FOUND", "Pedido no encontrado"), 404)
    const refusal = await lockedOrder(c, id)
    if (refusal) return refusal
    return runService(c, 200, () => detail(c, id))
  })

  const change =
    <T extends z.ZodType>(
      schema: T,
      run: (tx: Parameters<Parameters<typeof withOrgContext>[2]>[0], orgId: string, userId: string, id: string, body: z.infer<T>) => Promise<unknown>,
      options: { money?: boolean } = {},
    ) =>
    async (c: Context) => {
      const { orgId, userId, memberRole } = orgContextOf(c)
      if (!canAccess(memberRole, "orders.write")) return deny(c, FORBIDDEN.write)
      if (options.money && !canAccess(memberRole, "finance.write")) return deny(c, FORBIDDEN.money)
      const id = c.req.param("id") ?? ""
      if (!z.uuid().safeParse(id).success) return c.json(errorBody(c, "NOT_FOUND", "Pedido no encontrado"), 404)
      const parsed = schema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return validationError(c, parsed.error.issues)
      const refusal = await lockedOrder(c, id)
      if (refusal) return refusal
      return runService(c, 200, async () => {
        await withOrgContext(deps.db, orgId, (tx) => run(tx, orgId, userId, id, parsed.data))
        return detail(c, id)
      })
    }

  app.post("/:id/advance", change(advanceInput, (tx, orgId, userId, id, body) => advanceJobOrder(tx, orgId, userId, id, body)))
  // «Pedido listo» otra vez (ADR 0172): solo el que no salió o falló; el dudoso, confirmándolo.
  app.post(
    "/:id/notice",
    change(noticeInput, (tx, orgId, userId, id, body) =>
      sendOrderReadyNotice(tx, orgId, userId, id, { resend: true, confirmDoubtful: body.confirmDoubtful === true }),
    ),
  )
  app.post("/:id/void", change(reasonInput, (tx, orgId, userId, id, body) => voidJobOrder(tx, orgId, userId, id, body), { money: true }))
  // Rehacer crea otro pedido: la respuesta es el nuevo.
  app.post("/:id/remake", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "orders.write")) return deny(c, FORBIDDEN.write)
    if (!canAccess(memberRole, "finance.write")) return deny(c, FORBIDDEN.money)
    const id = c.req.param("id")
    if (!z.uuid().safeParse(id).success) return c.json(errorBody(c, "NOT_FOUND", "Pedido no encontrado"), 404)
    const parsed = remakeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const refusal = await lockedOrder(c, id)
    if (refusal) return refusal
    return runService(c, 201, async () => {
      const remade = await withOrgContext(deps.db, orgId, (tx) => remakeJobOrder(tx, orgId, userId, id, parsed.data))
      return detail(c, remade.id)
    })
  })

  return app
}
