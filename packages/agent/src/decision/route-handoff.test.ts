import { describe, expect, it } from "vitest"
import { type AgentRoute, routeHandoff } from "./route.js"

const route = (intent: string | null, urgency: number | null): AgentRoute => ({
  path: "derivar",
  intent,
  handoff: 0.9,
  confidence: 0.9,
  urgency,
})

/**
 * La prioridad del caso que pasa al equipo (26 nov: nada lo decide el sistema). La urgencia que
 * leyó el modelo puede subirla a «alta», nunca bajarla: lo que no es urgente entra en «media» y
 * quien toma el caso la cambia.
 */
describe("la prioridad del caso derivado", () => {
  it("lo urgente sube a alta", () => {
    expect(routeHandoff(route("handoff_request", 1.9))).toEqual({ reason: "Urgencia", priority: "alta" })
    expect(routeHandoff(route("clinical_question", 2))).toEqual({ reason: "Urgencia clínica", priority: "alta" })
  })

  it("lo que no es urgente queda en media, aunque la urgencia sea casi cero", () => {
    expect(routeHandoff(route("handoff_request", 0.1)).priority).toBe("media")
    expect(routeHandoff(route("clinical_question", 0)).priority).toBe("media")
    expect(routeHandoff(route("complaint", 0)).priority).toBe("media")
    expect(routeHandoff(route(null, null)).priority).toBe("media")
  })
})
