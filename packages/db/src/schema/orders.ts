import { check, date, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { user } from "./auth.js"
import { patient, patientCharge } from "./clinical.js"
import { orgFk, timestamps } from "./crm.js"
import { product } from "./inventory.js"
import { branch } from "./org.js"

/**
 * El pedido (ADR 0168): lo que la clínica encarga a su taller o a un laboratorio
 * para entregárselo a la persona. Es común a los productos: vistIA lo usa con los
 * lentes (entrega 4 del plan) y odentIA podrá usarlo con sus trabajos de
 * laboratorio. Pocos estados que dicen hechos de la clínica, con quién marcó cada
 * uno (`job_order_event`), la fecha prometida a la persona y, si se rehace, el
 * pedido original, sin cobrar otra vez.
 *
 * Lo que el taller necesita va copiado en el pedido (`prescription`, `fitting`):
 * así no abre la historia clínica.
 */
export const jobOrder = pgTable(
  "job_order",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id").references(() => branch.id),
    patientId: uuid("patient_id").notNull(),
    /** El número del pedido en la clínica, sin huecos (`org_counter` «job_order»). */
    orderNumber: integer("order_number").notNull(),
    /** La clave de la venta que lo creó: un reintento devuelve el mismo pedido. Nula en uno rehecho. */
    requestKey: text("request_key"),
    /** La huella de lo que se pidió con esa clave: la misma clave con otra venta es un conflicto. */
    requestFingerprint: text("request_fingerprint"),
    status: text("status").notNull().default("por_enviar"),
    /** Lo que se le prometió a la persona: el día que puede recogerlo. */
    promisedOn: date("promised_on").notNull(),
    /** Quién lo hace: el taller propio o el nombre del laboratorio. */
    maker: text("maker").notNull(),
    /** Qué es, en pocas palabras («Lentes progresivos con antirreflejo»). */
    title: text("title").notNull(),
    /** La copia de la receta con que se hace (la de lentes en vistIA); nula si no lleva. */
    prescription: jsonb("prescription"),
    /** Las medidas para montar (vistIA: distancia pupilar y alturas de montaje por ojo). */
    fitting: jsonb("fitting"),
    notes: text("notes"),
    /** El pedido que este rehace, con los mismos cargos (no se cobra otra vez); con su motivo. */
    remakeOf: uuid("remake_of"),
    remakeReason: text("remake_reason"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.patientId],
      foreignColumns: [patient.organizationId, patient.id],
      name: "job_order_patient_fk",
    }),
    // Lo rehecho es de la misma clínica: claves compuestas, como el resto (ADR 0063).
    foreignKey({
      columns: [table.organizationId, table.remakeOf],
      foreignColumns: [table.organizationId, table.id],
      name: "job_order_remake_fk",
    }),
    uniqueIndex("job_order_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("job_order_number_uidx").on(table.organizationId, table.orderNumber),
    uniqueIndex("job_order_request_uidx").on(table.organizationId, table.requestKey),
    index("job_order_status_idx").on(table.organizationId, table.status, table.promisedOn),
    index("job_order_patient_idx").on(table.organizationId, table.patientId),
    check(
      "job_order_status_check",
      sql`${table.status} IN ('por_enviar','en_laboratorio','por_revisar','listo','entregado','anulado')`,
    ),
    check("job_order_remake_check", sql`(${table.remakeOf} IS NULL) = (${table.remakeReason} IS NULL)`),
    check("job_order_void_check", sql`(${table.status} = 'anulado') = (${table.voidedAt} IS NOT NULL)`),
  ],
)

/**
 * Lo que lleva el pedido, cada cosa con su cargo. Un pedido rehecho comparte los
 * cargos del original: no se cobra otra vez y lo que falta pagar sigue a la vista.
 * El cargo es el de la venta; si la caja lo reemplaza (una devolución parcial),
 * el vigente es el que lo nombra en `original_charge_id`.
 */
export const jobOrderLine = pgTable(
  "job_order_line",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    jobOrderId: uuid("job_order_id").notNull(),
    /** Montura, lunas, lentes de contacto u otro. */
    kind: text("kind").notNull(),
    description: text("description").notNull(),
    productId: uuid("product_id"),
    quantity: integer("quantity").notNull().default(1),
    chargeId: uuid("charge_id"),
    position: integer("position").notNull(),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.jobOrderId],
      foreignColumns: [jobOrder.organizationId, jobOrder.id],
      name: "job_order_line_order_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.productId],
      foreignColumns: [product.organizationId, product.id],
      name: "job_order_line_product_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.chargeId],
      foreignColumns: [patientCharge.organizationId, patientCharge.id],
      name: "job_order_line_charge_fk",
    }),
    index("job_order_line_order_idx").on(table.organizationId, table.jobOrderId),
    index("job_order_line_charge_idx").on(table.organizationId, table.chargeId),
    check("job_order_line_kind_check", sql`${table.kind} IN ('montura','lunas','contacto','otro')`),
    check("job_order_line_quantity_check", sql`${table.quantity} BETWEEN 1 AND 99`),
  ],
)

/** Quién marcó cada paso del pedido y cuándo: la historia del pedido no se reescribe. */
export const jobOrderEvent = pgTable(
  "job_order_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    jobOrderId: uuid("job_order_id").notNull(),
    status: text("status").notNull(),
    note: text("note"),
    actorUserId: text("actor_user_id").references(() => user.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.jobOrderId],
      foreignColumns: [jobOrder.organizationId, jobOrder.id],
      name: "job_order_event_order_fk",
    }),
    index("job_order_event_order_idx").on(table.organizationId, table.jobOrderId, table.at),
    check(
      "job_order_event_status_check",
      sql`${table.status} IN ('por_enviar','en_laboratorio','por_revisar','listo','entregado','anulado')`,
    ),
  ],
)
