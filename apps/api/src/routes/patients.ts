import { withOrgContext } from "@odentia/db";
import {
  PATIENT_AVATAR_MAX_BYTES,
  PATIENT_AVATAR_MIME_EXT,
  TIMELINE_TYPES,
  addEncounterAddendum,
  addEncounterProcedure,
  addPlanItem,
  createEncounter,
  finalizeEncounter,
  getEncounterDetail,
  getPatientSummary,
  getTimeline,
  listEncounters,
  listPlanItems,
  requirePatient,
  setPatientAvatar,
  setPlanItemStatus,
  updateEncounterDraft,
  updatePlanItem,
  PATIENT_DOC_MAX_BYTES,
  PATIENT_DOC_MIME_EXT,
  ServiceError,
  addAllergy,
  addClinicalNote,
  addCondition,
  addMedication,
  addAnamnesis,
  addOdontogramEntries,
  createPatient,
  discontinueMedication,
  getAnamnesisVersion,
  getLatestAnamnesis,
  getOdontogram,
  getPatient,
  getPatientDocument,
  listAllergies,
  listAnamnesisVersions,
  listClinicalNotes,
  listConditions,
  listMedications,
  listPatientDocuments,
  listPatients,
  registerPatientDocument,
  setAllergyActive,
  setConditionStatus,
  updatePatient,
  voidOdontogramEntry,
} from "@odentia/services";
import { Hono } from "hono";
import { z } from "zod";
import { orgContextOf } from "../lib/context.js";
import { errorBody } from "../lib/error.js";
import { runService, serviceErrorResponse, validationError, type CrmDeps } from "./helpers.js";

const listQuery = z.object({
  q: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const filiation = {
  docType: z.enum(["DNI", "CE", "PASAPORTE", "OTRO"]).nullish(),
  docNumber: z.string().max(20).nullish(),
  birthDate: z.string().max(10).nullish(),
  sex: z.enum(["M", "F"]).nullish(),
  phone: z.string().max(50).nullish(),
  email: z.email().max(200).nullish(),
  maritalStatus: z.string().max(100).nullish(),
  educationLevel: z.string().max(100).nullish(),
  occupation: z.string().max(200).nullish(),
  address: z.string().max(500).nullish(),
  origin: z.string().max(200).nullish(),
  emergencyContactName: z.string().max(200).nullish(),
  emergencyContactPhone: z.string().max(50).nullish(),
  insuranceType: z.enum(["PARTICULAR", "SIS", "ESSALUD", "EPS", "OTRO"]).nullish(),
  insuranceDetail: z.string().max(500).nullish(),
  referralSource: z.string().max(500).nullish(),
  guardianContactId: z.string().uuid().nullish(),
  registeredBranchId: z.string().uuid().nullish(),
};

const createInput = z
  .object({
    contactId: z.string().uuid().optional(),
    displayName: z.string().min(1).max(200).optional(),
    ...filiation,
  })
  .refine((d) => Boolean(d.contactId) !== Boolean(d.displayName?.trim()), {
    message: "Indica contactId o displayName (solo uno)",
  });

const patchInput = z.object({ ...filiation, isActive: z.boolean().optional(), dataConsent: z.boolean().optional() });

const allergyInput = z.object({
  substance: z.string().min(1).max(200),
  reaction: z.string().max(2000).nullish(),
  severity: z.enum(["leve", "moderada", "severa"]).optional(),
});
const allergyPatch = z.object({ isActive: z.boolean() });

const conditionInput = z.object({
  name: z.string().min(1).max(200),
  status: z.enum(["activa", "resuelta", "inactiva"]).optional(),
  startDate: z.string().max(10).nullish(),
  endDate: z.string().max(10).nullish(),
  notes: z.string().max(2000).nullish(),
});
const conditionPatch = z.object({
  status: z.enum(["activa", "resuelta", "inactiva"]),
  endDate: z.string().max(10).nullish().optional(),
});

const medicationInput = z.object({
  name: z.string().min(1).max(200),
  dose: z.string().max(200).nullish(),
  frequency: z.string().max(200).nullish(),
  startDate: z.string().max(10).nullish(),
  endDate: z.string().max(10).nullish(),
  notes: z.string().max(2000).nullish(),
});
const medicationPatch = z.object({ endDate: z.string().max(10).nullish().optional() });

const anamnesisAnswers = z
  .object({
    motivoConsulta: z.string().max(2000).optional(),
    tiempoEnfermedad: z.string().max(500).optional(),
    antecedentesPersonales: z
      .object({
        enfermedades: z.string().max(2000).optional(),
        hospitalizaciones: z.string().max(2000).optional(),
        cirugias: z.string().max(2000).optional(),
        transfusiones: z.string().max(2000).optional(),
        embarazo: z.boolean().optional(),
        semanasEmbarazo: z.number().int().min(0).max(42).optional(),
        medicacionHabitual: z.string().max(2000).optional(),
      })
      .strict()
      .optional(),
    antecedentesFamiliares: z.string().max(2000).optional(),
    antecedentesOdontologicos: z
      .object({
        ultimaVisita: z.string().max(500).optional(),
        experienciaPrevia: z.enum(["positiva", "regular", "traumatica"]).optional(),
        ansiedadDental: z.enum(["ninguna", "leve", "moderada", "alta"]).optional(),
        cepilladosAlDia: z.number().int().min(0).max(10).optional(),
        hiloDental: z.boolean().optional(),
        bruxismo: z.boolean().optional(),
        habitos: z.array(z.string().max(200)).max(10).optional(),
      })
      .strict()
      .optional(),
    examenClinico: z
      .object({
        extraoral: z
          .object({
            atm: z.string().max(500).optional(),
            ganglios: z.string().max(500).optional(),
            labios: z.string().max(500).optional(),
          })
          .strict()
          .optional(),
        intraoral: z
          .object({
            encias: z.string().max(500).optional(),
            lengua: z.string().max(500).optional(),
            paladar: z.string().max(500).optional(),
            pisoBoca: z.string().max(500).optional(),
            carrillos: z.string().max(500).optional(),
            orofaringe: z.string().max(500).optional(),
          })
          .strict()
          .optional(),
        higieneOral: z.enum(["buena", "regular", "mala"]).optional(),
      })
      .strict()
      .optional(),
    diagnosticoPresuntivo: z.string().max(2000).optional(),
    diagnosticoCie10: z.array(z.string().max(10)).max(10).optional(),
    observaciones: z.string().max(2000).optional(),
  })
  .strict();

const noteInput = z.object({
  note: z.string().min(1).max(4000),
  diagnosisCode: z.string().max(10).nullish(),
  encounterId: z.uuid().optional(),
});

const odontogramInput = z.object({
  toothNumber: z.number().int(),
  condition: z.enum([
    "sano",
    "caries",
    "obturacion",
    "corona",
    "ausente",
    "extraccion_indicada",
    "endodoncia",
    "implante",
    "fractura",
    "sellante",
    "protesis",
    "desgaste",
    "otro",
  ]),
  surfaces: z
    .array(z.enum(["mesial", "distal", "vestibular", "lingual", "palatina", "oclusal", "incisal"]))
    .default([]),
  status: z.enum(["registrado", "realizado", "planificado"]).optional(),
  note: z.string().max(2000).nullish(),
  diagnosisCode: z.string().max(10).nullish(),
  encounterId: z.uuid().optional(),
});

const timelineQuery = listQuery.extend({
  types: z.string().transform((value) => value.split(",")).pipe(z.array(z.enum(TIMELINE_TYPES))).optional(),
  toothNumber: z.coerce.number().int().optional(),
  documentCategory: z.enum(["radiografia", "foto_clinica"]).optional(),
});
const encounterCreateInput = z.object({
  reason: z.string().max(2000).nullish(), branchId: z.uuid().nullish(), teeth: z.array(z.number().int()).max(52).optional(),
});
const encounterPatchInput = z.object({
  reason: z.string().max(2000).nullish(), evolution: z.string().max(10000).nullish(),
  indications: z.string().max(4000).nullish(), nextStep: z.string().max(2000).nullish(),
  nextAppointmentAt: z.iso.datetime({ offset: true }).nullish(),
  teeth: z.array(z.number().int()).max(52).optional(),
});
const procedureInput = z.object({
  description: z.string().trim().min(1).max(4000), toothNumber: z.number().int().nullish(),
  diagnosisCode: z.string().max(10).nullish(), planItemId: z.uuid().nullish(),
});
const planFields = {
  title: z.string().trim().min(1).max(300), detail: z.string().max(4000).nullish(),
  toothNumber: z.number().int().nullish(), diagnosisCode: z.string().max(10).nullish(),
  priceCents: z.number().int().min(0).max(2147483647).nullish(),
};
const planCreateInput = z.object({ ...planFields, currency: z.string().regex(/^[A-Z]{3}$/).optional() });
const planPatchInput = z.object(planFields).partial().extend({
  status: z.enum(["pendiente", "programado", "realizado", "cancelado"]).optional(), encounterId: z.uuid().nullish(),
});
const documentLinkInput = z.object({ encounterId: z.uuid().optional(), toothNumber: z.coerce.number().int().optional() });

export function createPatientsRoute(deps: CrmDeps) {
  const app = new Hono();

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c);
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.issues);
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listPatients(tx, orgId, parsed.data),
      );
      return c.json({ data: items, nextCursor });
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e);
    }
  });

  app.post("/", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = createInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => createPatient(tx, orgId, userId, parsed.data)));
  });

  app.get("/:id", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getPatient(tx, orgId, c.req.param("id"))));
  });

  app.patch("/:id", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updatePatient(tx, orgId, userId, c.req.param("id"), parsed.data)),
    );
  });

  // --- Alergias ---
  app.get("/:id/allergies", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listAllergies(tx, orgId, c.req.param("id"))));
  });
  app.post("/:id/allergies", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = allergyInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => addAllergy(tx, orgId, userId, c.req.param("id"), parsed.data)),
    );
  });
  app.patch("/:id/allergies/:allergyId", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = allergyPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setAllergyActive(tx, orgId, userId, c.req.param("allergyId"), parsed.data.isActive),
      ),
    );
  });

  // --- Condiciones ---
  app.get("/:id/conditions", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listConditions(tx, orgId, c.req.param("id"))));
  });
  app.post("/:id/conditions", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = conditionInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => addCondition(tx, orgId, userId, c.req.param("id"), parsed.data)),
    );
  });
  app.patch("/:id/conditions/:conditionId", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = conditionPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setConditionStatus(tx, orgId, userId, c.req.param("conditionId"), parsed.data.status, parsed.data.endDate),
      ),
    );
  });

  // --- Medicamentos ---
  app.get("/:id/medications", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listMedications(tx, orgId, c.req.param("id"))));
  });
  app.post("/:id/medications", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = medicationInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => addMedication(tx, orgId, userId, c.req.param("id"), parsed.data)),
    );
  });
  app.patch("/:id/medications/:medicationId", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = medicationPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        discontinueMedication(tx, orgId, userId, c.req.param("medicationId"), parsed.data.endDate),
      ),
    );
  });

  // --- Anamnesis ---
  app.get("/:id/anamnesis/history", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listAnamnesisVersions(tx, orgId, c.req.param("id"))),
    );
  });
  app.get("/:id/anamnesis/:versionId", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getAnamnesisVersion(tx, orgId, c.req.param("id"), c.req.param("versionId"))),
    );
  });
  app.get("/:id/anamnesis", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, async () => {
      const row = await withOrgContext(deps.db, orgId, (tx) => getLatestAnamnesis(tx, orgId, c.req.param("id")));
      if (!row) throw new ServiceError("NOT_FOUND", 404, "Anamnesis no encontrada");
      return row;
    });
  });
  app.post("/:id/anamnesis", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const body = (await c.req.json().catch(() => null)) as { answers?: unknown } | null;
    const parsed = anamnesisAnswers.safeParse(body?.answers);
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addAnamnesis(tx, orgId, userId, c.req.param("id"), parsed.data as Record<string, unknown>),
      ),
    );
  });

  // --- Evoluciones ---
  app.get("/:id/notes", async (c) => {
    const { orgId } = orgContextOf(c);
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.issues);
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listClinicalNotes(tx, orgId, c.req.param("id"), parsed.data),
      );
      return c.json({ data: items, nextCursor });
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e);
    }
  });
  app.post("/:id/notes", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = noteInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => addClinicalNote(tx, orgId, userId, c.req.param("id"), parsed.data)),
    );
  });

  // --- Odontograma ---
  app.get("/:id/odontogram", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getOdontogram(tx, orgId, c.req.param("id"))));
  });
  app.post("/:id/odontogram/entries", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = odontogramInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => addOdontogramEntries(tx, orgId, userId, c.req.param("id"), parsed.data)),
    );
  });
  app.post("/:id/odontogram/entries/:entryId/void", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => voidOdontogramEntry(tx, orgId, userId, c.req.param("entryId"))),
    );
  });

  // --- Documentos ---
  app.get("/:id/documents", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listPatientDocuments(tx, orgId, c.req.param("id"))),
    );
  });
  app.post("/:id/documents", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const patientId = c.req.param("id");
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    const category = form?.get("category");
    const label = form?.get("label");
    const link = documentLinkInput.safeParse({
      encounterId: form?.get("encounterId") || undefined, toothNumber: form?.get("toothNumber") || undefined,
    });
    if (!link.success) return validationError(c, link.error.issues);
    if (!(file instanceof File)) return c.json(errorBody(c, "VALIDATION", "Adjunta un archivo"), 400);
    if (typeof category !== "string" || typeof label !== "string" || !label.trim()) {
      return c.json(errorBody(c, "VALIDATION", "category y label son obligatorios"), 400);
    }
    const ext = PATIENT_DOC_MIME_EXT[file.type];
    if (!ext) return c.json(errorBody(c, "VALIDATION", "Solo se admiten JPG, PNG, WebP o PDF"), 400);
    if (file.size > PATIENT_DOC_MAX_BYTES) {
      return c.json(errorBody(c, "VALIDATION", "El archivo no puede superar 10 MB"), 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return runService(c, 201, async () => {
      await withOrgContext(deps.db, orgId, (tx) => requirePatient(tx, orgId, patientId));
      const ref = await deps.storage.putPatientDocument({ orgId, patientId, bytes, contentType: file.type, ext });
      try {
        return await withOrgContext(deps.db, orgId, (tx) => registerPatientDocument(tx, orgId, userId, patientId, {
          category, label: label.trim(), storageKey: ref.objectKey, contentType: file.type, sizeBytes: file.size, ...link.data,
        }));
      } catch (e) {
        await deps.storage.deleteAttachment(ref.objectKey).catch(() => {});
        throw e;
      }
    });
  });
  app.get("/:id/documents/:documentId/url", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, async () => {
      const doc = await withOrgContext(deps.db, orgId, (tx) =>
        getPatientDocument(tx, orgId, c.req.param("id"), c.req.param("documentId")),
      );
      const url = await deps.storage.attachmentUrl(doc.storageKey);
      return { url };
    });
  });

  app.post("/:id/avatar", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const patientId = c.req.param("id");
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json(errorBody(c, "VALIDATION", "Adjunta una imagen"), 400);
    const ext = PATIENT_AVATAR_MIME_EXT[file.type];
    if (!ext) return c.json(errorBody(c, "VALIDATION", "Solo se admiten JPG, PNG o WebP"), 400);
    if (!file.size || file.size > PATIENT_AVATAR_MAX_BYTES) return c.json(errorBody(c, "VALIDATION", "La imagen debe pesar entre 1 byte y 2 MB"), 400);
    return runService(c, 201, async () => {
      await withOrgContext(deps.db, orgId, (tx) => requirePatient(tx, orgId, patientId));
      const ref = await deps.storage.putPatientAvatar({ orgId, patientId, bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type, ext });
      try {
        const avatarUrl = await deps.storage.attachmentUrl(ref.objectKey);
        const changed = await withOrgContext(deps.db, orgId, (tx) => setPatientAvatar(tx, orgId, userId, patientId, ref.objectKey));
        if (changed.previousStorageKey) await deps.storage.deleteAttachment(changed.previousStorageKey).catch(() => {});
        return { avatarUrl };
      } catch (e) {
        await deps.storage.deleteAttachment(ref.objectKey).catch(() => {});
        throw e;
      }
    });
  });
  app.get("/:id/avatar-url", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, async () => {
      const row = await withOrgContext(deps.db, orgId, (tx) => requirePatient(tx, orgId, c.req.param("id")));
      if (!row.avatarStorageKey) throw new ServiceError("NO_AVATAR", 404, "El paciente no tiene avatar");
      return { url: await deps.storage.attachmentUrl(row.avatarStorageKey) };
    });
  });
  app.get("/:id/summary", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getPatientSummary(tx, orgId, c.req.param("id"))));
  });
  app.get("/:id/timeline", async (c) => {
    const { orgId } = orgContextOf(c);
    const parsed = timelineQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.issues);
    try {
      return c.json(await withOrgContext(deps.db, orgId, (tx) => getTimeline(tx, orgId, c.req.param("id"), parsed.data)));
    } catch (e) { return serviceErrorResponse(c, e) ?? Promise.reject(e); }
  });
  app.post("/:id/encounters", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = encounterCreateInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => createEncounter(tx, orgId, userId, c.req.param("id"), parsed.data)));
  });
  app.get("/:id/encounters", async (c) => {
    const { orgId } = orgContextOf(c);
    const parsed = listQuery.extend({ status: z.enum(["borrador", "finalizada"]).optional() }).safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.issues);
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) => listEncounters(tx, orgId, c.req.param("id"), parsed.data));
      return c.json({ data: items, nextCursor });
    } catch (e) { return serviceErrorResponse(c, e) ?? Promise.reject(e); }
  });
  app.get("/:id/encounters/:encounterId", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getEncounterDetail(tx, orgId, c.req.param("id"), c.req.param("encounterId"))));
  });
  app.patch("/:id/encounters/:encounterId", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = encounterPatchInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => updateEncounterDraft(tx, orgId, userId, c.req.param("id"), c.req.param("encounterId"), parsed.data)));
  });
  app.post("/:id/encounters/:encounterId/procedures", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = procedureInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => addEncounterProcedure(tx, orgId, userId, c.req.param("id"), c.req.param("encounterId"), parsed.data)));
  });
  app.post("/:id/encounters/:encounterId/finalize", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => finalizeEncounter(tx, orgId, userId, c.req.param("id"), c.req.param("encounterId"))));
  });
  app.post("/:id/encounters/:encounterId/addenda", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = z.object({ text: z.string().trim().min(1).max(4000) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => addEncounterAddendum(tx, orgId, userId, c.req.param("id"), c.req.param("encounterId"), parsed.data)));
  });
  app.get("/:id/plan", async (c) => {
    const { orgId } = orgContextOf(c);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listPlanItems(tx, orgId, c.req.param("id"))));
  });
  app.post("/:id/plan/items", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = planCreateInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => addPlanItem(tx, orgId, userId, c.req.param("id"), parsed.data)));
  });
  app.patch("/:id/plan/items/:itemId", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const parsed = planPatchInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 200, () => withOrgContext(deps.db, orgId, async (tx) => {
      const { status, encounterId, ...patch } = parsed.data;
      const args = [tx, orgId, userId, c.req.param("id"), c.req.param("itemId")] as const;
      if (status && !Object.keys(patch).length) return setPlanItemStatus(...args, { status, encounterId });
      const item = await updatePlanItem(...args, patch);
      return status ? setPlanItemStatus(...args, { status, encounterId }) : item;
    }));
  });

  return app;
}
