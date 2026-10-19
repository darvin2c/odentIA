import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  index,
  integer,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { adminSchema } from "./schemas.js"

/**
 * Libro de Reclamaciones virtual de odentIA (Perú: Ley 29571 y D.S.
 * 011-2011-PCM con sus modificatorias).
 *
 * Tablas globales de la plataforma, sin organización ni RLS: quien reclama es
 * cliente o visitante de odentIA, no de una clínica. Solo el rol owner las
 * toca (la migración 0004 revoca el acceso del rol app); la API pública
 * escribe con `ownerDb`.
 *
 * - `consumerComplaint`: una Hoja de Reclamación con los campos del Anexo I.
 *   `number` es el correlativo del año («2026-000001»); `submissionId` hace
 *   idempotente el envío (reenviar devuelve la misma hoja). El bloque 4
 *   (observaciones y acciones del proveedor) lo llena odentIA al responder.
 * - `consumerComplaintCounter`: el último correlativo de cada año. Se
 *   incrementa con un upsert atómico en la misma transacción que la hoja.
 */
export const consumerComplaint = adminSchema.table(
  "consumer_complaint",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    number: text("number").notNull().unique("consumer_complaint_number_unique"),
    year: integer("year").notNull(),
    submissionId: uuid("submission_id").notNull().unique("consumer_complaint_submission_unique"),
    /** 'reclamo' (disconformidad con el producto o servicio) | 'queja' (malestar con la atención). */
    kind: text("kind").notNull(),
    /** 'recibido' | 'respondido'. */
    status: text("status").notNull().default("recibido"),
    consumerName: text("consumer_name").notNull(),
    consumerAddress: text("consumer_address").notNull(),
    /** 'DNI' | 'CE' | 'PASAPORTE': lo valida el servicio, no la base (ADR 0036). */
    documentType: text("document_type").notNull(),
    documentNumber: text("document_number").notNull(),
    phone: text("phone").notNull(),
    email: text("email").notNull(),
    isMinor: boolean("is_minor").notNull().default(false),
    guardianName: text("guardian_name"),
    /** 'producto' | 'servicio'. */
    itemType: text("item_type").notNull(),
    itemDescription: text("item_description").notNull(),
    /** Monto reclamado en céntimos de `amountCurrency`; opcional. */
    amountMinor: bigint("amount_minor", { mode: "number" }),
    /** 'PEN' | 'USD' (ISO 4217); va junto con el monto. */
    amountCurrency: text("amount_currency"),
    detail: text("detail").notNull(),
    request: text("request").notNull(),
    providerResponse: text("provider_response"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    /** Quién del personal respondió (migración 0005); nulo si su cuenta se borró. */
    respondedByUserId: text("responded_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** La respuesta llegó al servidor de correo de quien reclamó; si no, se reenvía a mano. */
    responseEmailSent: boolean("response_email_sent").notNull().default(false),
    privacyAcceptedAt: timestamp("privacy_accepted_at", { withTimezone: true }).notNull(),
    emailSent: boolean("email_sent").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("consumer_complaint_status_idx").on(table.status, table.createdAt)],
)

export const consumerComplaintCounter = adminSchema.table("consumer_complaint_counter", {
  year: integer("year").primaryKey(),
  value: bigint("value", { mode: "number" }).notNull().default(0),
})
