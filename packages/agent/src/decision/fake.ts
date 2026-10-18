import type { DecisionModel, DecisionResult } from "./port.js"

/**
 * Modelo de decisión determinista para dev/e2e/tests: decide por palabras
 * clave del estado. No acredita calidad de ningún proveedor.
 */
export function createFakeDecisionModel(): DecisionModel {
  return {
    provider: "fake",
    reportsProbabilities: true,
    async decide(state, questions) {
      const text = state.toLowerCase()
      const has = (...words: string[]) => words.some((w) => text.includes(w))
      const answers = questions.map((q): DecisionResult["answers"][number] => {
        if (q.kind === "yesno") {
          const yes =
            q.id === "handoff"
              ? has("humano", "persona", "queja", "dolor fuerte", "urgente", "sangra")
              : q.id === "unsubscribe"
                ? has("no me escriban", "dejen de", "baja")
                : q.id === "requires_reply"
                  ? !has("gracias", "ok", "listo")
                  : q.id === "interest"
                    ? has("cuánto", "cuanto", "precio", "cuesta", "quiero", "me interesa") && !has("lista de precios", "todos sus precios")
                    : false
          return { id: q.id, kind: "yesno", probability: yes ? 0.92 : 0.08 }
        }
        if (q.kind === "choice" && q.id === "topic") {
          // Elección de conocimiento: gana la opción que comparte más palabras
          // con el estado; sin ninguna en común, «none».
          const words = new Set(text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 4))
          let best = { value: "none", hits: 0 }
          for (const option of q.options) {
            if (option.value === "none") continue
            const described = (option.description ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/)
            const hits = described.filter((w) => w.length >= 4 && words.has(w)).length
            if (hits > best.hits) best = { value: option.value, hits }
          }
          const probabilities = Object.fromEntries(
            q.options.map((o) => [o.value, o.value === best.value ? 0.85 : 0.15 / Math.max(1, q.options.length - 1)]),
          )
          return { id: q.id, kind: "choice", choice: best.value, probabilities, confidence: 0.8 }
        }
        if (q.kind === "choice" && q.id === "spam") {
          // Demostración: lo que suena a publicidad, estafa o cadena; todo lo demás es una persona.
          const pick = has("bit.ly", "gana s/", "gana dinero", "préstamo", "prestamo", "paquete está retenido", "paquete esta retenido")
            ? has("paquete") ? "scam" : "advertising"
            : has("reenvía esto", "reenvia esto")
              ? "chain"
              : has("hacemos páginas web", "hacemos paginas web", "somos una agencia")
                ? "selling_to_clinic"
                : "not_spam"
          const probabilities = Object.fromEntries(q.options.map((o) => [o.value, o.value === pick ? 0.95 : 0.05 / Math.max(1, q.options.length - 1)]))
          return { id: q.id, kind: "choice", choice: pick, probabilities, confidence: 0.9 }
        }
        if (q.kind === "choice") {
          const pick =
            has("reprogramar", "cambiar mi cita", "mover mi cita", "cancelar mi cita") && q.options.some((o) => o.value === "reschedule_or_cancel")
              ? "reschedule_or_cancel"
              : has("cita", "turno", "agendar") && q.options.some((o) => o.value === "appointment_request")
              ? "appointment_request"
              : has("precio", "cuesta", "costo") && q.options.some((o) => o.value === "price_or_service_info")
                ? "price_or_service_info"
                : has("gracias", "buenos dias", "buenas tardes") && q.options.some((o) => o.value === "greeting_or_thanks")
                  ? "greeting_or_thanks"
                  : (q.options.find((o) => o.value === "other")?.value ?? q.options[0]!.value)
          const probabilities = Object.fromEntries(q.options.map((o) => [o.value, o.value === pick ? 0.85 : 0.15 / Math.max(1, q.options.length - 1)]))
          return { id: q.id, kind: "choice", choice: pick, probabilities, confidence: 0.8 }
        }
        const level = has("dolor fuerte", "urgente", "sangra") ? q.levels.length - 1 : 0
        const probabilities = q.levels.map((_, i) => (i === level ? 0.9 : 0.1 / Math.max(1, q.levels.length - 1)))
        return { id: q.id, kind: "score", score: level, probabilities, confidence: 0.85 }
      })
      return { answers, model: "fake-decision", usage: { inputTokens: state.length, outputTokens: 0 }, latencyMs: 1 }
    },
  }
}
