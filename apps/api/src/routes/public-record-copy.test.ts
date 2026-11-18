import type { Db } from "@odentia/db"
import { ServiceError } from "@odentia/services"
import { describe, expect, it, vi } from "vitest"

// Solo la ruta: el servicio se sustituye para ver qué le llega y qué entrega (las reglas de la
// copia por su enlace las prueban `record-copy-link.test.ts` de services, con la base).
const DOC = "45678903"
const calls = {
  view: 0,
  failures: 0,
  downloads: [] as Array<{ docNumber: string; ip: string | null | undefined }>,
}
vi.mock("@odentia/services", async (original) => ({
  ...(await original<typeof import("@odentia/services")>()),
  getRecordCopyView: async (_tx: Db, _orgId: string, token: string) => {
    calls.view++
    if (token !== TOKEN) throw new ServiceError("NOT_FOUND", 404, "Enlace no encontrado")
    return {
      clinicName: "Dental Smile",
      until: "2026-11-25T15:00:00.000Z",
      canDownload: true,
      downloadsLeft: 5,
    }
  },
  checkRecordCopyDocument: async (_tx: Db, _orgId: string, _token: string, docNumber: string) => {
    if (docNumber !== DOC)
      throw new ServiceError("RECORD_COPY_DOCUMENT", 400, "Ese documento no coincide", {
        docNumber: "Ese documento no coincide",
      })
    return { ok: true }
  },
  recordRecordCopyFailure: async () => {
    calls.failures++
  },
  startRecordCopyDownload: async (
    _tx: Db,
    _orgId: string,
    _token: string,
    input: { docNumber: string },
    evidence: { ip?: string | null },
  ) => {
    if (input.docNumber !== DOC)
      throw new ServiceError("RECORD_COPY_DOCUMENT", 400, "Ese documento no coincide", {
        docNumber: "Ese documento no coincide",
      })
    calls.downloads.push({ docNumber: input.docNumber, ip: evidence.ip })
    return {
      fileName: "Historia de Rosa Quispe.zip",
      generatedAt: new Date("2026-11-18T15:00:00Z"),
      entries: [
        { name: "Historia de Rosa Quispe.pdf", bytes: new TextEncoder().encode("%PDF-1.7") },
        { name: "imagenes/Panorámica.jpg", storageKey: "org/panoramica.jpg" },
        { name: "LÉEME.txt", bytes: new TextEncoder().encode("Qué trae") },
      ],
      summary: {},
      readme: () => new TextEncoder().encode("Qué trae, y lo que no se pudo incluir"),
    }
  },
}))

const { createPublicBookingRoute } = await import("./public-booking.js")

/** Una base de mentira: encuentra la clínica por su dirección y abre la transacción. */
const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "org_copia" }] }) }) }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: async () => [] }),
} as unknown as Db

const TOKEN = "c".repeat(64)
const storage = {
  streamAttachment: async () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("jpg"))
        controller.close()
      },
    }),
} as never

function app(ip: string) {
  return createPublicBookingRoute({
    db,
    secretsKey: Buffer.alloc(32),
    storage,
    remoteAddress: () => ip,
  })
}

describe("«Copia de tu historia» por su enlace", () => {
  it("abrirla solo muestra: no descarga ni anota nada, y vencida o inválida responde lo mismo sin datos", async () => {
    const route = app("203.0.113.40")
    const open = await route.request(`/clinica/copy?token=${TOKEN}`)
    expect(open.status).toBe(200)
    expect(open.headers.get("cache-control")).toBe("no-store")
    expect(open.headers.get("referrer-policy")).toBe("no-referrer")
    expect(calls.downloads).toEqual([])
    const invalid = await route.request(`/clinica/copy?token=${"f".repeat(64)}`)
    const malformed = await route.request("/clinica/copy?token=corto")
    expect(invalid.status).toBe(404)
    expect(malformed.status).toBe(404)
    const [a, b] = [await invalid.json(), await malformed.json()] as Array<{
      error: { code: string; message: string }
    }>
    expect(a!.error).toMatchObject({ code: "NOT_FOUND", message: "Enlace no disponible" })
    expect(b!.error).toMatchObject({ code: "NOT_FOUND", message: "Enlace no disponible" })
  })

  it("un documento que no es el suyo se dice en su campo y se cuenta, como el PIN del portal", async () => {
    const route = app("203.0.113.41")
    calls.failures = 0
    const wrong = await route.request("/clinica/copy/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, docNumber: "11111111" }),
    })
    expect(wrong.status).toBe(400)
    expect(
      ((await wrong.json()) as { error: { fields: Record<string, string> } }).error.fields,
    ).toHaveProperty("docNumber")
    expect(calls.failures).toBe(1)
    const right = await route.request("/clinica/copy/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, docNumber: DOC }),
    })
    expect(right.status).toBe(200)
    expect(calls.failures).toBe(1)
  })

  it("«Descargar» llega como formulario del navegador y baja el ZIP en streaming, con el token en el cuerpo", async () => {
    const route = app("203.0.113.42")
    calls.downloads.length = 0
    const zip = await route.request("/clinica/copy/download", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: TOKEN, docNumber: DOC }).toString(),
    })
    expect(zip.status).toBe(200)
    expect(zip.headers.get("content-type")).toBe("application/zip")
    expect(zip.headers.get("content-disposition")).toContain("Historia%20de%20Rosa%20Quispe.zip")
    const bytes = new Uint8Array(await zip.arrayBuffer())
    expect(new TextDecoder().decode(bytes.slice(0, 2))).toBe("PK")
    expect(calls.downloads).toEqual([{ docNumber: DOC, ip: "203.0.113.42" }])
    // Con otro documento no baja nada y se cuenta el intento.
    calls.failures = 0
    const wrong = await route.request("/clinica/copy/download", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: TOKEN, docNumber: "999" }).toString(),
    })
    expect(wrong.status).toBe(400)
    expect(calls.failures).toBe(1)
    expect(calls.downloads).toHaveLength(1)
  })
})
