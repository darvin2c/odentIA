import { Hono } from "hono"
import { createPatientOdontogramRoute } from "./dental/patient-odontogram.js"
import { createPatientPeriodontalRoute } from "./dental/patient-periodontal.js"
import type { CrmDeps } from "./helpers.js"

/**
 * El único lugar de la API que conoce los productos (ADR 0079), como
 * `products.ts` en los servicios: las rutas que cada producto agrega a las
 * comunes. Hoy solo las de odentIA; qué puede hacer cada clínica lo sigue
 * decidiendo el servicio según su producto.
 */

/** Bajo `/patients`: el odontograma y el periodontograma. */
export function patientProductRoutes(deps: CrmDeps) {
  const app = new Hono()
  app.route("/", createPatientOdontogramRoute(deps))
  app.route("/", createPatientPeriodontalRoute(deps))
  return app
}
