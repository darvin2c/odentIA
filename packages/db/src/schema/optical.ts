import { sql } from "drizzle-orm"
import { check, date, foreignKey, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { encounter, patient, patientDocument } from "./clinical.js"
import { orgFk, timestamps } from "./crm.js"
import { opticalSchema } from "./schemas.js"

/**
 * La receta de lentes de vistIA (entrega 3 del plan, ADR 0170): de anteojos o de
 * lentes de contacto, de la óptica (sale del examen y la firma el optómetra) o
 * externa (transcrita de la que trae el cliente, «sin verificar» hasta que un
 * optómetra la revise). Es solo de vistIA: vive en su esquema, con la RLS de la
 * clínica.
 *
 * Los lentes van en `lenses` tal como los valida `parsePrescriptionLenses` de
 * `@odentia/optical` (esfera, cilindro, eje, adición, prisma y base por ojo; en
 * los de contacto, además curva base, diámetro y marca, sin prisma). Emitida, no
 * cambia: solo se verifica (la externa, una vez) o se anula, con su motivo, y
 * anulada ya nada cambia (lo guarda `lens_prescription_immutable`).
 */
export const lensPrescription = opticalSchema.table(
  "lens_prescription",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id").notNull(),
    /** La atención donde se examinó, de la misma persona; nula en una externa. */
    encounterId: uuid("encounter_id"),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    lenses: jsonb("lenses").notNull(),
    /** Distancia pupilar en mm (`{ od, oi, binocular, cerca }`, `PupillaryDistance`); nula si no se midió. */
    pupillaryDistance: jsonb("pupillary_distance"),
    notes: text("notes"),
    issuedOn: date("issued_on").notNull(),
    validUntil: date("valid_until").notNull(),
    /** Quien la firma: el optómetra de la óptica o, en una externa, quien la firmó afuera. */
    prescriberUserId: text("prescriber_user_id").references(() => user.id),
    prescriberName: text("prescriber_name").notNull(),
    prescriberRegistration: text("prescriber_registration"),
    /** La foto de la receta externa, entre los documentos de la persona (de la misma clínica). */
    photoDocumentId: uuid("photo_document_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by").references(() => user.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.patientId],
      foreignColumns: [patient.organizationId, patient.id],
      name: "lens_prescription_patient_fk",
    }),
    // La atención es de la misma clínica y de la misma persona: nunca la de otra.
    foreignKey({
      columns: [table.organizationId, table.patientId, table.encounterId],
      foreignColumns: [encounter.organizationId, encounter.patientId, encounter.id],
      name: "lens_prescription_encounter_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.photoDocumentId],
      foreignColumns: [patientDocument.organizationId, patientDocument.id],
      name: "lens_prescription_photo_fk",
    }),
    index("lens_prescription_patient_idx").on(table.organizationId, table.patientId, table.issuedOn),
    uniqueIndex("lens_prescription_encounter_kind_uidx")
      .on(table.organizationId, table.encounterId, table.kind)
      .where(sql`${table.encounterId} IS NOT NULL AND ${table.voidedAt} IS NULL`),
    check("lens_prescription_kind_check", sql`${table.kind} IN ('anteojos','contacto')`),
    check("lens_prescription_source_check", sql`${table.source} IN ('examen','externa')`),
    check(
      "lens_prescription_source_encounter_check",
      sql`(${table.source} = 'examen') = (${table.encounterId} IS NOT NULL)`,
    ),
    check("lens_prescription_valid_check", sql`${table.validUntil} >= ${table.issuedOn}`),
    check(
      "lens_prescription_void_check",
      sql`(${table.voidedAt} IS NULL) = (${table.voidReason} IS NULL)`,
    ),
  ],
)
