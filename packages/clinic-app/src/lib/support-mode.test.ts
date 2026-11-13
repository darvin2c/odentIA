// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadSupportSession } from "./support-mode"

/**
 * Lo que la app entiende de `GET /api/support-session/me`. La pregunta sale de todo navegador
 * que abre la clínica, también el del equipo, que nunca tuvo sesión de soporte: «El acceso
 * terminó» es solo para quien la tenía.
 */

// Fuera de una visita real no hay cabeceras que leer: `apiFetch` corre entero sobre la red simulada.
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }))

afterEach(() => vi.unstubAllGlobals())

/** La API responde esto a la pregunta por la sesión de soporte. */
function apiAnswers(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const SLUG = "clinica"
const ended = { error: { code: "SUPPORT_ACCESS_ENDED", message: "El acceso de soporte terminó" } }
const watching = {
  data: {
    staffUserId: "u-soporte",
    staffName: "Sofía Soporte",
    viewRole: "reception",
    viewRoleLabel: "Recepción",
    expiresAt: "2026-11-13T15:00:00.000Z",
    caseId: "caso-1",
    organization: { id: "org-1", name: "Clínica", slug: SLUG, logo: null },
    members: [],
  },
}

describe("la sesión de soporte de este navegador", () => {
  it("sin cookie de soporte no hay sesión ni nada que haya terminado: sigue la sesión de la clínica", async () => {
    const fetchMock = apiAnswers(200, { data: null })
    expect(await loadSupportSession(SLUG)).toBeNull()
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/support-session/me")
  })

  it("con la cookie de una sesión que terminó, es «terminado»", async () => {
    apiAnswers(401, ended)
    expect(await loadSupportSession(SLUG)).toBe("terminado")
  })

  it("con la sesión vigente, entrega con qué rol se mira y hasta cuándo", async () => {
    apiAnswers(200, watching)
    const found = await loadSupportSession(SLUG)
    expect(found).toMatchObject({
      session: { userId: "u-soporte", name: "Sofía Soporte" },
      support: { viewRole: "reception", viewRoleLabel: "Recepción", caseId: "caso-1" },
    })
  })

  it("la sesión de soporte de otra clínica no es la de esta", async () => {
    apiAnswers(200, watching)
    expect(await loadSupportSession("otra")).toBeNull()
  })

  it("otro rechazo o un fallo del servidor no dicen que terminó", async () => {
    apiAnswers(401, { error: { code: "UNAUTHORIZED", message: "Sin sesión" } })
    expect(await loadSupportSession(SLUG)).toBeNull()
    apiAnswers(500, {})
    expect(await loadSupportSession(SLUG)).toBeNull()
  })
})

describe("la pantalla que ya miraba como soporte", () => {
  // La cookie dura lo que el permiso: al vencer deja de viajar y la API ya no ve ninguna.
  it("si ya no hay sesión de soporte, el acceso terminó: nunca la sesión normal de ese navegador", async () => {
    apiAnswers(200, { data: null })
    expect(await loadSupportSession(SLUG, undefined, true)).toBe("terminado")
  })

  it("con la cookie de una sesión que terminó, también", async () => {
    apiAnswers(401, ended)
    expect(await loadSupportSession(SLUG, undefined, true)).toBe("terminado")
  })

  it("un fallo del servidor no la saca: no se sabe si terminó", async () => {
    apiAnswers(500, {})
    expect(await loadSupportSession(SLUG, undefined, true)).toBeNull()
  })
})
