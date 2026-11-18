import { describe, expect, it } from "vitest"
import {
  type ClientFile,
  cameFromClinic,
  fileDay,
  previewKindOf,
  whoWords,
} from "./client-file-model"

const file = (over: Partial<ClientFile>): ClientFile => ({
  id: "f1",
  clientId: "c1",
  kind: "otro",
  filename: "archivo.pdf",
  contentType: "application/pdf",
  sizeBytes: 2048,
  adminOnly: false,
  deleteAfter: null,
  source: "persona",
  createdAt: "2026-11-12T15:00:00.000Z",
  createdBy: { userId: "u1", name: "Ada Lovelace" },
  receivedAt: null,
  cargaAt: null,
  inboundEmailId: null,
  cargaDeleteAfter: null,
  cargaDueNow: false,
  ...over,
})

describe("los documentos de la ficha (ADR 0196)", () => {
  it("se ven sin descargar solo las imágenes y el PDF de hasta 10 MB", () => {
    expect(previewKindOf(file({ contentType: "image/webp" }))).toBe("imagen")
    expect(previewKindOf(file({ contentType: "application/pdf" }))).toBe("pdf")
    expect(previewKindOf(file({ sizeBytes: 11 * 1024 * 1024 }))).toBeNull()
    expect(previewKindOf(file({ contentType: "image/svg+xml" }))).toBeNull()
    expect(previewKindOf(file({ contentType: "text/csv" }))).toBeNull()
  })

  it("lo que llegó por correo o por un chat es de la clínica y dice por dónde y cuándo llegó", () => {
    const chat = file({
      kind: "correo",
      source: "whatsapp",
      createdBy: null,
      receivedAt: "2026-11-10T15:00:00.000Z",
    })
    expect(cameFromClinic(chat)).toBe(true)
    expect(whoWords(chat)).toBe("llegó por WhatsApp")
    expect(fileDay(chat)).toBe("2026-11-10T15:00:00.000Z")
    expect(cameFromClinic(file({ kind: "archivo_clinica" }))).toBe(true)
    expect(cameFromClinic(file({ kind: "carta" }))).toBe(false)
    expect(whoWords(file({}))).toBe("lo subió Ada")
    expect(whoWords(file({ source: "kairos" }))).toBe("lo dejó Kairós")
  })
})
