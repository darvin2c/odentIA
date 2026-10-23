import type { PlatformLlm } from "@odentia/agent"
import { Hono } from "hono"
import type { AgentRouteDeps } from "./agent.js"
import { createClioPracticeRoute } from "./dental/clio-practice.js"
import { createEncounterDictationRoute } from "./dental/encounter-dictation.js"
import { createPatientOdontogramRoute } from "./dental/patient-odontogram.js"
import { createPatientPeriodontalRoute } from "./dental/patient-periodontal.js"
import type { CrmDeps } from "./helpers.js"

/**
 * El único lugar de la API que conoce los productos (ADR 0079), como
 * `products.ts` en los servicios: las rutas que cada producto agrega a las
 * comunes. Hoy solo las de odentIA; qué puede hacer cada clínica lo sigue
 * decidiendo el servicio según su producto.
 */

/** Bajo `/patients`: odontograma, periodontograma y el dictado de Clío. */
export function patientProductRoutes(deps: CrmDeps & { llm?: PlatformLlm }) {
  const app = new Hono()
  app.route("/", createPatientOdontogramRoute(deps))
  app.route("/", createPatientPeriodontalRoute(deps))
  // El dictado del asistente clínico necesita el proveedor del modelo; sin él no se monta.
  if (deps.llm) app.route("/", createEncounterDictationRoute({ ...deps, llm: deps.llm }))
  return app
}

/** Bajo `/agent`: la práctica del dictado de Clío. */
export function agentProductRoutes(deps: AgentRouteDeps) {
  const app = new Hono()
  app.route("/", createClioPracticeRoute(deps))
  return app
}
