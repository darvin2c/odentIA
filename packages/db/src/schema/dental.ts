import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import {
  diagnosisCodeRef,
  encounter,
  patient,
  serviceCatalog,
  treatmentPlanItem,
  treatmentTemplate,
} from "./clinical.js"
import { orgFk, timestamps } from "./crm.js"
import { catalogSchema, dentalSchema } from "./schemas.js"

// Lo que solo usa odentIA (ADR 0079): el odontograma, el periodontograma y sus
// enlaces con lo común. Viven en el esquema `dental`; lo común no los conoce.

/** Odontograma FDI (ISO 3950) por pieza/superficie (append-only); la NTS 188 rige solo en Perú (ADR 0036).
 * Los hallazgos nuevos usan status='recorded'; la anulación es una corrección
 * auditable (voidedAt/voidedBy/voidReason + proyección status='voided') que
 * NUNCA muta condition/surface/note. needsReview=true marca filas migradas
 * del catálogo anterior (legacyData conserva el objeto original) excluidas
 * del dibujo normativo hasta su revisión clínica. */
export const odontogramEntry = dentalSchema.table(
  "odontogram_entry",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    toothNumber: smallint("tooth_number").notNull(),
    surface: text("surface"),
    condition: text("condition").notNull(),
    status: text("status").notNull().default("recorded"),
    diagnosisSystem: text("diagnosis_system"),
    diagnosisCode: text("diagnosis_code"),
    note: text("note"),
    details: jsonb("details").notNull().default({}),
    needsReview: boolean("needs_review").notNull().default(false),
    legacyData: jsonb("legacy_data"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
    /**
     * Hallazgo tratado: el tratamiento indicado para él se realizó. Resolver no
     * es anular: el hallazgo estuvo vigente hasta esa fecha.
     */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by").references(() => user.id),
    resolvedByPlanItemId: uuid("resolved_by_plan_item_id").references(
      (): AnyPgColumn => treatmentPlanItem.id,
    ),
    /**
     * Lo tratado queda dibujado: el tratamiento completado que dejó este
     * hallazgo en la pieza (la resina deja una restauración), según lo que su
     * servicio dice que deja (`service_finding`). Del mismo
     * paciente y organización: `0001_base_reglas.sql` añade la FK
     * compuesta `odontogram_entry_left_by_plan_item_fk` (sin FK en TS para
     * evitar el ciclo con `treatment_plan_item`).
     */
    leftByPlanItemId: uuid("left_by_plan_item_id"),
    createdBy: text("created_by").references(() => user.id),
    encounterId: uuid("encounter_id").references(() => encounter.id),
    ...timestamps,
  },
  (table) => [
    ...diagnosisCodeRef("odontogram_entry", table),
    index("odontogram_entry_org_patient_tooth_idx").on(
      table.organizationId,
      table.patientId,
      table.toothNumber,
    ),
    // Para que un enlace no cruce de paciente ni de clínica (`plan_item_finding`).
    uniqueIndex("odontogram_entry_org_patient_id_uidx").on(
      table.organizationId,
      table.patientId,
      table.id,
    ),
  ],
)

/**
 * Odontograma firmado (solo en clínicas de un país con odontograma oficial:
 * NTS 188 en Perú; ADR 0036): instantánea inmutable de los hallazgos activos
 * al firmar, con la firma del perfil profesional de quien firma (nombre,
 * título y colegiatura; sin trazo) y su momento. El que sale al cerrar una
 * atención la nombra (`encounterId`, uno por atención); el del botón
 * «Firmar odontograma» (judicial, personal, reingreso) no. Guarda su norma:
 * cambiar el país de la clínica no la reescribe. Append-only sin updatedAt;
 * REVOKE a nivel DB. El snapshot `entries` siempre lo calcula el servidor.
 */
export const odontogramAssessment = dentalSchema.table(
  "odontogram_assessment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patient.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => user.id),
    purpose: text("purpose").notNull(),
    specifications: text("specifications").notNull(),
    observations: text("observations").notNull(),
    examinerName: text("examiner_name").notNull(),
    examinerTitle: text("examiner_title").notNull(),
    /** Colegio y número, como se imprime: «COP 12345». */
    registrationNumber: text("registration_number").notNull(),
    patientName: text("patient_name").notNull(),
    patientNumber: integer("patient_number").notNull(),
    entries: jsonb("entries").notNull(),
    /** Norma con la que se firmó; sin valor por defecto: la pone el servicio. */
    standard: text("standard").notNull(),
    /** Atención cuyo cierre lo firmó; null en el botón «Firmar odontograma». */
    encounterId: uuid("encounter_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("odontogram_assessment_org_patient_idx").on(table.organizationId, table.patientId),
    foreignKey({
      columns: [table.organizationId, table.patientId, table.encounterId],
      foreignColumns: [encounter.organizationId, encounter.patientId, encounter.id],
      name: "odontogram_assessment_encounter_fk",
    }),
    uniqueIndex("odontogram_assessment_encounter_uidx")
      .on(table.encounterId)
      .where(sql`"encounter_id" IS NOT NULL`),
  ],
)

/**
 * Arreglo de smallint con elementos nulos: en el periodontograma, un sitio sin
 * medir. Leído por drizzle, un NULL dentro de un arreglo de smallint llega como
 * NaN; este tipo lo escribe y lo lee como null. En la base sigue siendo
 * `smallint[]`.
 */
const nullableSmallintArray = customType<{
  data: (number | null)[]
  driverData: string | Array<number | string | null>
}>({
  dataType: () => "smallint[]",
  toDriver: (value) =>
    `{${value.map((item) => (item === null ? "NULL" : String(item))).join(",")}}`,
  fromDriver: (value) => {
    const items = Array.isArray(value)
      ? value
      : value
          .replace(/^\{|\}$/g, "")
          .split(",")
          .filter((item) => item !== "")
    // El controlador ya entrega el arreglo, pero su NULL llega como NaN.
    return items.map((item) => {
      const number = item === null || item === "NULL" ? Number.NaN : Number(item)
      return Number.isNaN(number) ? null : number
    })
  },
})

/**
 * Periodontograma (issue 49, ADR 0054): uno por atención. Guarda las piezas que
 * se debían sondear y cuáles eran implantes según el odontograma de ese día
 * (decisión 4): cada periodontograma conserva la boca que tenía. Se escribe
 * solo mientras su atención está en borrador; al firmarla queda fijo, como el
 * odontograma (disparador `guard_periodontal_draft` y sin DELETE para la
 * aplicación). La clasificación de 2017 que confirma el odontólogo vive aquí,
 * con lo que agregó para decidirla; el código CIE-10 o CIE-11 va como
 * diagnóstico de la atención (decisión 5).
 */
export const periodontalChart = dentalSchema.table(
  "periodontal_chart",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id").notNull(),
    encounterId: uuid("encounter_id").notNull(),
    /** Piezas FDI permanentes que se sondean, según el odontograma al empezar. */
    expectedTeeth: smallint("expected_teeth").array().notNull(),
    implantTeeth: smallint("implant_teeth").array().notNull().default(sql`'{}'::smallint[]`),
    /** Lo que confirmó el odontólogo (AAP/EFP 2017); nulo hasta confirmar. */
    diagnosis: text("diagnosis"),
    stage: smallint("stage"),
    grade: text("grade"),
    extent: text("extent"),
    /** Lo que agregó para decidir: no sale del sondaje. */
    boneLossPercent: smallint("bone_loss_percent"),
    teethLostToPeriodontitis: smallint("teeth_lost_to_periodontitis"),
    cigarettesPerDay: smallint("cigarettes_per_day"),
    diabetes: boolean("diabetes"),
    hba1c: numeric("hba1c", { precision: 3, scale: 1, mode: "number" }),
    /** Solo periodontitis ya diagnosticada antes: estable, en remisión o inestable. */
    periodontitisStatus: text("periodontitis_status"),
    classifiedBy: text("classified_by").references(() => user.id),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("periodontal_chart_encounter_uidx").on(table.encounterId),
    uniqueIndex("periodontal_chart_org_id_uidx").on(table.organizationId, table.id),
    index("periodontal_chart_org_patient_idx").on(table.organizationId, table.patientId),
    foreignKey({
      columns: [table.organizationId, table.patientId, table.encounterId],
      foreignColumns: [encounter.organizationId, encounter.patientId, encounter.id],
      name: "periodontal_chart_encounter_fk",
    }),
    check(
      "periodontal_chart_diagnosis_check",
      sql`${table.diagnosis} IS NULL OR ${table.diagnosis} IN ('health','gingivitis','periodontitis')`,
    ),
    check(
      "periodontal_chart_stage_check",
      sql`(${table.diagnosis} = 'periodontitis') = (${table.stage} IS NOT NULL AND ${table.grade} IS NOT NULL) AND (${table.stage} IS NULL OR ${table.stage} BETWEEN 1 AND 4) AND (${table.grade} IS NULL OR ${table.grade} IN ('A','B','C'))`,
    ),
    check(
      "periodontal_chart_extent_check",
      sql`(${table.diagnosis} IS NULL OR ${table.diagnosis} = 'health') = (${table.extent} IS NULL) AND (${table.extent} IS NULL OR ${table.extent} IN ('localized','generalized') OR (${table.diagnosis} = 'periodontitis' AND ${table.extent} = 'molar_incisor'))`,
    ),
    check(
      "periodontal_chart_status_check",
      sql`${table.periodontitisStatus} IS NULL OR (${table.diagnosis} = 'periodontitis' AND ${table.periodontitisStatus} IN ('stable','remission','unstable'))`,
    ),
    check(
      "periodontal_chart_classified_check",
      sql`(${table.diagnosis} IS NULL) = (${table.classifiedAt} IS NULL) AND (${table.classifiedAt} IS NULL) = (${table.classifiedBy} IS NULL)`,
    ),
    check(
      "periodontal_chart_inputs_check",
      sql`(${table.boneLossPercent} IS NULL OR ${table.boneLossPercent} BETWEEN 0 AND 100) AND (${table.teethLostToPeriodontitis} IS NULL OR ${table.teethLostToPeriodontitis} BETWEEN 0 AND 32) AND (${table.cigarettesPerDay} IS NULL OR ${table.cigarettesPerDay} BETWEEN 0 AND 200) AND (${table.hba1c} IS NULL OR (${table.diabetes} AND ${table.hba1c} BETWEEN 3 AND 20))`,
    ),
  ],
)

/**
 * Una pieza del periodontograma: seis sitios en orden fijo (mesial, centro y
 * distal por fuera; mesial, centro y distal por dentro), con la recesión con
 * signo, y la placa de O'Leary en cuatro caras (por fuera, por dentro, mesial,
 * distal). Las formas y los rangos los valida `validatePeriodontalTooth`
 * (@odentia/clinical); la base asegura el tamaño y los límites.
 */
export const periodontalTooth = dentalSchema.table(
  "periodontal_tooth",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    chartId: uuid("chart_id").notNull(),
    toothNumber: smallint("tooth_number").notNull(),
    /** «Saltar pieza»: se dejó sin medir a propósito. */
    skipped: boolean("skipped").notNull().default(false),
    /** Profundidad de sondaje en mm por sitio; un elemento nulo es un sitio sin medir. */
    probingDepth: nullableSmallintArray("probing_depth").notNull(),
    /** Recesión con signo en mm: positiva si se ve raíz, negativa si la encía cubre corona. */
    recession: nullableSmallintArray("recession").notNull(),
    bleeding: boolean("bleeding").array().notNull(),
    suppuration: boolean("suppuration").array().notNull(),
    /** Miller, de 0 a 3. */
    mobility: smallint("mobility"),
    /** Furca de Hamp por entrada: `{ "buccal": 2 }`. */
    furcation: jsonb("furcation").notNull().default({}),
    plaque: boolean("plaque").array(),
    periImplant: text("peri_implant"),
    updatedBy: text("updated_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("periodontal_tooth_chart_tooth_uidx").on(table.chartId, table.toothNumber),
    foreignKey({
      columns: [table.organizationId, table.chartId],
      foreignColumns: [periodontalChart.organizationId, periodontalChart.id],
      name: "periodontal_tooth_chart_fk",
    }).onDelete("cascade"),
    check(
      "periodontal_tooth_fdi_check",
      sql`${table.toothNumber} IN (11,12,13,14,15,16,17,18,21,22,23,24,25,26,27,28,31,32,33,34,35,36,37,38,41,42,43,44,45,46,47,48)`,
    ),
    check(
      "periodontal_tooth_sites_check",
      sql`cardinality(${table.probingDepth}) = 6 AND cardinality(${table.recession}) = 6 AND cardinality(${table.bleeding}) = 6 AND cardinality(${table.suppuration}) = 6`,
    ),
    check(
      "periodontal_tooth_ranges_check",
      sql`0 <= ALL(${table.probingDepth}) AND 15 >= ALL(${table.probingDepth}) AND -10 <= ALL(${table.recession}) AND 15 >= ALL(${table.recession})`,
    ),
    check(
      "periodontal_tooth_mobility_check",
      sql`${table.mobility} IS NULL OR ${table.mobility} BETWEEN 0 AND 3`,
    ),
    check("periodontal_tooth_furcation_check", sql`jsonb_typeof(${table.furcation}) = 'object'`),
    check(
      "periodontal_tooth_plaque_check",
      sql`${table.plaque} IS NULL OR cardinality(${table.plaque}) = 4`,
    ),
    check(
      "periodontal_tooth_peri_implant_check",
      sql`${table.periImplant} IS NULL OR ${table.periImplant} IN ('health','mucositis','peri_implantitis')`,
    ),
  ],
)
/**
 * El hallazgo del odontograma que motivó un tratamiento del plan (trazabilidad
 * clínica). Uno por tratamiento, del mismo paciente; el plan común no conoce el
 * odontograma.
 */
export const planItemFinding = dentalSchema.table(
  "plan_item_finding",
  {
    planItemId: uuid("plan_item_id").primaryKey(),
    organizationId: orgFk("organization_id"),
    patientId: uuid("patient_id").notNull(),
    odontogramEntryId: uuid("odontogram_entry_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.patientId, table.planItemId],
      foreignColumns: [
        treatmentPlanItem.organizationId,
        treatmentPlanItem.patientId,
        treatmentPlanItem.id,
      ],
      name: "plan_item_finding_plan_item_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.patientId, table.odontogramEntryId],
      foreignColumns: [
        odontogramEntry.organizationId,
        odontogramEntry.patientId,
        odontogramEntry.id,
      ],
      name: "plan_item_finding_entry_fk",
    }),
    index("plan_item_finding_entry_idx").on(table.odontogramEntryId),
  ],
)

/**
 * Lo que deja un servicio de la clínica en la pieza al completarse: el
 * hallazgo del odontograma y, si corresponde, su variante (la resina, una
 * restauración; la exodoncia, una pieza ausente). Sin fila, no deja nada
 * dibujado. Los de la biblioteca lo traen de `dental_template_rule`.
 */
export const serviceFinding = dentalSchema.table(
  "service_finding",
  {
    serviceId: uuid("service_id").primaryKey(),
    organizationId: orgFk("organization_id"),
    condition: text("condition").notNull(),
    variant: text("variant"),
    ...timestamps,
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.serviceId],
      foreignColumns: [serviceCatalog.organizationId, serviceCatalog.id],
      name: "service_finding_service_fk",
    }).onDelete("cascade"),
  ],
)

/**
 * Lo dental de cada tratamiento de la biblioteca (ADR 0069 y 0079): cuántas
 * caras admite y lo que deja dibujado en la pieza. Global y de solo lectura,
 * como la biblioteca; solo la tienen los tratamientos del producto dental.
 */
export const dentalTemplateRule = catalogSchema.table(
  "dental_template_rule",
  {
    templateId: uuid("template_id")
      .primaryKey()
      .references(() => treatmentTemplate.id, { onDelete: "cascade" }),
    surfaceCountMin: integer("surface_count_min"),
    surfaceCountMax: integer("surface_count_max"),
    leavesCondition: text("leaves_condition"),
    leavesVariant: text("leaves_variant"),
  },
  (table) => [
    check(
      "dental_template_rule_leaves_check",
      sql`${table.leavesVariant} IS NULL OR ${table.leavesCondition} IS NOT NULL`,
    ),
  ],
)
