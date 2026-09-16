import { withOrgContext } from "@odentia/db";
import { correctDocumentContext, getPatientDocumentWithHistory } from "@odentia/services";
import { Hono } from "hono";
import { z } from "zod";
import { orgContextOf } from "../lib/context.js";
import { runService, validationError, type CrmDeps } from "./helpers.js";

/**
 * Contexto versionado de documentos del paciente (propiedad DocsData).
 * Main la monta bajo /patients, por eso los paths son /:id/...
 * - GET /:id/documents/:documentId/context → documento fusionado + historial
 * - POST /:id/documents/:documentId/context → corrección versionada
 *   { expectedVersion, encounterId?, planItemId?, toothNumbers?, tags? }.
 *   `null` libera el vínculo, `undefined` conserva el valor vigente.
 *   Versión desactualizada → 409 STALE_VERSION sin pérdida.
 */
const correctionInput = z
  .object({
    expectedVersion: z.number().int().min(1),
    encounterId: z.uuid().nullish(),
    planItemId: z.uuid().nullish(),
    toothNumbers: z.array(z.number().int()).max(52).optional(),
    // Etiquetas crudas como contacts (máx 100; el servicio normaliza a 20 únicas canónicas).
    tags: z.array(z.string().min(1).max(200)).max(100).optional(),
  })
  .strict();

export function createPatientDocumentContextRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono();

  app.get("/:id/documents/:documentId/context", async (c) => {
    const { orgId } = orgContextOf(c);
    const patientId = c.req.param("id");
    const documentId = c.req.param("documentId");
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getPatientDocumentWithHistory(tx, orgId, patientId, documentId)),
    );
  });

  app.post("/:id/documents/:documentId/context", async (c) => {
    const { orgId, userId } = orgContextOf(c);
    const patientId = c.req.param("id");
    const documentId = c.req.param("documentId");
    const parsed = correctionInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return validationError(c, parsed.error.issues);
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        correctDocumentContext(tx, orgId, userId, patientId, documentId, parsed.data),
      ),
    );
  });

  return app;
}
