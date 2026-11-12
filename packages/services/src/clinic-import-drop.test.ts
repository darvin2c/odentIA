/** `import:dejar` sin red: qué archivo es, el cuerpo que sube, la llave y cómo se dice cada error. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  ADMIN_KEY_FILE,
  checkDraftClinic,
  checkDraftPayload,
  DEFAULT_API_URL,
  detectDraftKind,
  draftNumber,
  draftRequestBody,
  draftsUrl,
  explainDropFailure,
  isPdf,
  postDraft,
  readAdminKey,
} from "./clinic-import-drop.js"

const KEY = `sk_${"a".repeat(43)}`

const report = {
  product: "dental",
  clinic: "Clínica Sonrisa (ficticia)",
  to: "Dra. Ana Pérez",
  email: "ana@example.com",
  number: 2,
  stage: "Alta de su cuenta",
  companion: { name: "Carlos Ruiz", email: "carlos@odentia32.com" },
  done: ["Cargamos sus sedes"],
  where: ["Configuración › Sedes"],
}

const patients = {
  version: 1,
  countryCode: "PE",
  sources: [{ name: "pacientes.xlsx", sha256: "0".repeat(64) }],
  people: [
    {
      key: "1043",
      demographics: { displayName: "Rosa Quispe (ficticia)" },
      documentNumber: "4455667",
    },
  ],
  omitted: [],
}

describe("qué archivo es", () => {
  it("reconoce cada tipo por su forma", () => {
    expect(detectDraftKind({ kind: "clinica", slug: "sonrisa" })).toBe("plan_configuracion")
    expect(detectDraftKind(patients)).toBe("plan_pacientes")
    expect(detectDraftKind(report)).toBe("informe")
  })

  it("no adivina lo que no conoce", () => {
    for (const other of [null, [], "texto", { files: [] }, { kind: "carta" }])
      expect(() => detectDraftKind(other)).toThrow(/No reconozco el archivo/)
  })

  it("el informe va con su número y no con otro", () => {
    expect(draftNumber("informe", report)).toBe(2)
    expect(draftNumber("informe", report, "2")).toBe(2)
    expect(() => draftNumber("informe", report, "3")).toThrow(/N\.º 2/)
    expect(draftNumber("plan_configuracion", {})).toBe(1)
    expect(draftNumber("plan_pacientes", {}, "4")).toBe(4)
    expect(() => draftNumber("plan_pacientes", {}, "0")).toThrow(/1 a 99/)
  })

  it("el plan de configuración es de la clínica que se nombra", () => {
    expect(checkDraftClinic("plan_configuracion", { slug: "Sonrisa" }, "sonrisa")).toBeNull()
    expect(checkDraftClinic("plan_configuracion", { slug: "otra" }, "sonrisa")).toMatch(/«otra»/)
    expect(checkDraftClinic("informe", report, "sonrisa")).toBeNull()
  })

  it("un plan de pacientes con errores dice dónde, nunca el dato", () => {
    const problems = checkDraftPayload("plan_pacientes", patients)
    expect(problems.length).toBeGreaterThan(0)
    const said = problems.join("\n")
    expect(said).not.toContain("Rosa")
    expect(said).not.toContain("4455667")
    expect(said).toMatch(/este dato no es válido/)
  })

  it("un informe válido pasa", () => {
    expect(checkDraftPayload("informe", report)).toEqual([])
  })
})

describe("el cuerpo de la petición", () => {
  it("lleva la clínica en minúsculas, el tipo, el número, el JSON y el PDF en base64", () => {
    const pdf = new TextEncoder().encode("%PDF-1.7 prueba")
    const body = draftRequestBody({
      organizationSlug: " Sonrisa ",
      kind: "informe",
      number: 2,
      payload: report,
      pdf,
    })
    expect(body).toEqual({
      organizationSlug: "sonrisa",
      kind: "informe",
      number: 2,
      payload: report,
      pdfBase64: Buffer.from(pdf).toString("base64"),
    })
    expect(isPdf(pdf)).toBe(true)
    expect(isPdf(new TextEncoder().encode("no es"))).toBe(false)
  })

  it("sin PDF no lleva pdfBase64", () => {
    const body = draftRequestBody({
      organizationSlug: "sonrisa",
      kind: "plan_pacientes",
      number: 1,
      payload: patients,
      pdf: null,
    })
    expect("pdfBase64" in body).toBe(false)
  })

  it("va a la API de producción o a la de ODENTIA_API_URL", () => {
    expect(draftsUrl({})).toBe(`${DEFAULT_API_URL}/api/admin-skill/drafts`)
    expect(draftsUrl({ ODENTIA_API_URL: "http://localhost:3001/" })).toBe(
      "http://localhost:3001/api/admin-skill/drafts",
    )
  })

  it("manda la llave solo en la cabecera y explica el 401 sin repetirla", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response(
        JSON.stringify({ error: { code: "SKILL_KEY_REQUIRED", message: "Llave no válida" } }),
        { status: 401 },
      )
    }) as unknown as typeof fetch
    const body = draftRequestBody({
      organizationSlug: "sonrisa",
      kind: "informe",
      number: 2,
      payload: report,
    })
    const result = await postDraft(
      "https://api.example.com/api/admin-skill/drafts",
      KEY,
      body,
      fake,
    )
    const [call] = seen
    expect(call?.init.method).toBe("POST")
    expect((call?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      `Bearer ${KEY}`,
    )
    expect(String(call?.init.body)).not.toContain(KEY)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
      expect(result.message).toMatch(/no reconoce la llave/)
      expect(result.message).not.toContain(KEY)
    }
  })

  it("un corte de red no se reintenta y dice que mire la ficha", async () => {
    let calls = 0
    const down = (async () => {
      calls++
      throw new TypeError("fetch failed")
    }) as unknown as typeof fetch
    const result = await postDraft(
      "https://api.example.com/api/admin-skill/drafts",
      KEY,
      draftRequestBody({ organizationSlug: "s", kind: "informe", number: 2, payload: report }),
      down,
    )
    expect(calls).toBe(1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/Alta antes de volver/)
  })

  it("lo dejado vuelve en `data`, como responde la ruta", async () => {
    const ok = (async () =>
      new Response(
        JSON.stringify({ data: { id: "d1", clientId: "c1", status: "lista", replaced: false } }),
        { status: 201 },
      )) as unknown as typeof fetch
    const result = await postDraft(
      "https://api.example.com/api/admin-skill/drafts",
      KEY,
      draftRequestBody({ organizationSlug: "s", kind: "informe", number: 2, payload: report }),
      ok,
    )
    expect(result).toEqual({
      ok: true,
      status: 201,
      data: { id: "d1", clientId: "c1", status: "lista", replaced: false },
    })
  })
})

describe("los errores en palabras", () => {
  it("403, 413 y 400 con sus campos", () => {
    expect(
      explainDropFailure(403, {
        error: { code: "SKILL_KEY_FORBIDDEN", message: "La llave es de una persona de Soporte" },
      }),
    ).toMatch(/Soporte.*Administración/)
    expect(explainDropFailure(413, null)).toMatch(/12 MB/)
    const bad = explainDropFailure(400, {
      error: {
        code: "VALIDATION",
        message: "El archivo no es del tipo que dice",
        fields: { "payload.slug": "El plan es de otra clínica" },
      },
    })
    expect(bad).toMatch(/payload\.slug: El plan es de otra clínica/)
  })
})

describe("la llave", () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })
  const homeWithKey = (content: string, mode?: number) => {
    const home = mkdtempSync(join(tmpdir(), "odentia-llave-"))
    homes.push(home)
    mkdirSync(join(home, "odentia-cargas"))
    writeFileSync(join(home, ADMIN_KEY_FILE), content)
    if (mode !== undefined) chmodSync(join(home, ADMIN_KEY_FILE), mode)
    return home
  }

  it("la variable manda sobre el archivo", () => {
    const home = homeWithKey(`sk_${"b".repeat(43)}`)
    expect(readAdminKey({ ODENTIA_ADMIN_KEY: KEY }, { home }).key).toBe(KEY)
  })

  it("lee el archivo y no dice la llave en ningún mensaje", () => {
    const home = homeWithKey(`${KEY}\n`)
    const read = readAdminKey({}, { home, platform: "win32" })
    expect(read.key).toBe(KEY)
    expect(read.warning).toBeUndefined()
    expect(() => readAdminKey({}, { home: join(home, "otra") })).toThrow(/Llaves de la skill/)
    const wrong = homeWithKey("no-es-una-llave-secreta")
    try {
      readAdminKey({}, { home: wrong, platform: "win32" })
      expect.unreachable()
    } catch (error) {
      expect(String(error)).not.toContain("no-es-una-llave-secreta")
    }
  })

  it.skipIf(process.platform === "win32")("avisa si el archivo lo pueden leer otros", () => {
    expect(readAdminKey({}, { home: homeWithKey(KEY, 0o644) }).warning).toMatch(/chmod 600/)
    expect(readAdminKey({}, { home: homeWithKey(KEY, 0o600) }).warning).toBeUndefined()
  })
})
