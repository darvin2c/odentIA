import { withOrgContext } from "@odentia/db"
import { keepSignedOdontogramPaper } from "@odentia/services/dental"
import { Hono } from "hono"
import { createPatientOdontogramRoute } from "./dental/patient-odontogram.js"
import { createPatientPeriodontalRoute } from "./dental/patient-periodontal.js"
import { createPatientLensPrescriptionsRoute } from "./optical/lens-prescriptions.js"
import type { CrmDeps } from "./helpers.js"

/**
 * El único lugar de la API que conoce los productos (ADR 0079), como
 * `products.ts` en los servicios: las rutas que cada producto agrega a las
 * comunes: las de odentIA y las de vistIA; qué puede hacer cada clínica lo sigue
 * decidiendo el servicio según su producto.
 */

/** Bajo `/patients`: el odontograma y el periodontograma; la receta de lentes. */
export function patientProductRoutes(deps: CrmDeps) {
  const app = new Hono()
  app.route("/", createPatientOdontogramRoute(deps))
  app.route("/", createPatientPeriodontalRoute(deps))
  app.route("/", createPatientLensPrescriptionsRoute(deps))
  return app
}

/**
 * Lo que el producto deja guardado al firmar una atención, ya confirmada la firma (odentIA:
 * el PDF del odontograma que firmó el cierre, como la hoja de atención). Si falla, se guarda
 * la primera vez que se abra.
 */
export async function keepFinalizedProductPapers(
  deps: CrmDeps,
  input: { orgId: string; patientId: string; finalized: Record<string, unknown> },
): Promise<void> {
  const odontogram = input.finalized.odontogram as { id?: unknown } | null | undefined
  if (typeof odontogram?.id !== "string") return
  await keepSignedOdontogramPaper({
    run: (fn) => withOrgContext(deps.db, input.orgId, fn),
    storage: deps.storage,
    orgId: input.orgId,
    patientId: input.patientId,
    assessmentId: odontogram.id,
  })
}
