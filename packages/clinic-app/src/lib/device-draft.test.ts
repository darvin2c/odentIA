// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearDeviceDraft,
  clearDeviceDraftsOfLink,
  DEVICE_DRAFT_TTL_MS,
  deviceDraftKey,
  deviceDraftsWork,
  draftResumeWords,
  draftUntilWords,
  personalLinkDraftKey,
  readDeviceDraft,
  sweepDeviceDrafts,
  writeDeviceDraft,
} from "./device-draft"

/** El almacenamiento de un navegador, en memoria. */
class MemoryStorage implements Storage {
  private items = new Map<string, string>()
  get length() {
    return this.items.size
  }
  clear() {
    this.items.clear()
  }
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.items.delete(key)
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value))
  }
  keys() {
    return [...this.items.keys()]
  }
}

/** Una ventana privada que no deja guardar: todo lanza. */
const blocked = {
  get length(): number {
    throw new Error("SecurityError")
  },
  clear() {
    throw new Error("SecurityError")
  },
  getItem(): string | null {
    throw new Error("SecurityError")
  },
  key(): string | null {
    throw new Error("SecurityError")
  },
  removeItem() {
    throw new Error("SecurityError")
  },
  setItem() {
    throw new Error("QuotaExceededError")
  },
} as Storage

const START = new Date("2026-11-14T14:15:00-05:00")
const HOUR = 60 * 60 * 1000
let local: MemoryStorage
let session: MemoryStorage

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  local = new MemoryStorage()
  session = new MemoryStorage()
  vi.stubGlobal("window", { localStorage: local, sessionStorage: session })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const marta = personalLinkDraftKey("dental-smile", "token-de-marta-abc123", "2026-11-15T15:00:00.000Z")
const step3 = { item: "medicines", current: 3, total: 6 }

describe("lo escrito queda en este celular un día o hasta enviarlo (entrega 9)", () => {
  it("se guarda con su paso y se repone tal cual", () => {
    writeDeviceDraft(marta, { givenNames: "Marta", medicationsText: "warfarina 5 mg" }, step3)
    const saved = readDeviceDraft<{ givenNames: string }>(marta)
    expect(saved?.values).toEqual({ givenNames: "Marta", medicationsText: "warfarina 5 mg" })
    expect(saved?.step).toEqual(step3)
    expect(saved?.expiresAt).toBe(START.getTime() + DEVICE_DRAFT_TTL_MS)
  })

  it("una hora después sigue; a las 24 horas ya no está y se borra del celular (reloj falso)", () => {
    writeDeviceDraft(marta, { givenNames: "Marta" }, step3)
    vi.setSystemTime(START.getTime() + HOUR)
    expect(readDeviceDraft(marta)?.step).toEqual(step3)
    vi.setSystemTime(START.getTime() + DEVICE_DRAFT_TTL_MS - 1)
    expect(readDeviceDraft(marta)).not.toBeNull()
    vi.setSystemTime(START.getTime() + DEVICE_DRAFT_TTL_MS)
    expect(readDeviceDraft(marta)).toBeNull()
    expect(local.getItem(marta)).toBeNull()
  })

  it("las 24 horas cuentan desde que empezó: seguir escribiendo no las alarga", () => {
    writeDeviceDraft(marta, { givenNames: "Mar" }, step3)
    vi.setSystemTime(START.getTime() + 20 * HOUR)
    writeDeviceDraft(marta, { givenNames: "Marta" }, step3)
    expect(readDeviceDraft(marta)?.expiresAt).toBe(START.getTime() + DEVICE_DRAFT_TTL_MS)
    vi.setSystemTime(START.getTime() + DEVICE_DRAFT_TTL_MS)
    expect(readDeviceDraft(marta)).toBeNull()
  })

  it("si venció con la página abierta, lo que siga escribiendo empieza otro día", () => {
    writeDeviceDraft(marta, { givenNames: "Marta" }, step3)
    const later = START.getTime() + DEVICE_DRAFT_TTL_MS + HOUR
    vi.setSystemTime(later)
    writeDeviceDraft(marta, { givenNames: "Marta R." }, step3)
    expect(readDeviceDraft(marta)).toMatchObject({ startedAt: later, expiresAt: later + DEVICE_DRAFT_TTL_MS })
  })

  it("al enviar se borra", () => {
    writeDeviceDraft(marta, { givenNames: "Marta" }, step3)
    clearDeviceDraft(marta)
    expect(readDeviceDraft(marta)).toBeNull()
    expect(local.keys()).toEqual([])
  })

  it("lo dañado o con un vencimiento de más de un día (reloj cambiado, tocado a mano) no se repone y se borra", () => {
    local.setItem(marta, "{no es json")
    expect(readDeviceDraft(marta)).toBeNull()
    expect(local.getItem(marta)).toBeNull()
    local.setItem(marta, JSON.stringify({ values: { a: "b" }, step: null, startedAt: START.getTime(), expiresAt: START.getTime() + 7 * DEVICE_DRAFT_TTL_MS }))
    expect(readDeviceDraft(marta)).toBeNull()
    expect(local.getItem(marta)).toBeNull()
    // Un paso que no cuadra se ignora, lo escrito no.
    local.setItem(marta, JSON.stringify({ values: { a: "b" }, step: { item: "x", current: 9, total: 3 }, startedAt: START.getTime(), expiresAt: START.getTime() + HOUR }))
    expect(readDeviceDraft(marta)).toMatchObject({ values: { a: "b" }, step: null })
  })
})

describe("la clave es de esa clínica y de ese enlace", () => {
  it("otro enlace en el mismo navegador no ve lo de otra persona", () => {
    const rosa = personalLinkDraftKey("dental-smile", "token-de-rosa-xyz789", "2026-11-15T15:00:00.000Z")
    writeDeviceDraft(marta, { medicationsText: "warfarina 5 mg" }, step3)
    expect(rosa).not.toBe(marta)
    expect(readDeviceDraft(rosa)).toBeNull()
  })

  it("otra clínica, otra cita del mismo enlace y el registro son claves distintas", () => {
    const keys = new Set([
      marta,
      personalLinkDraftKey("otra-clinica", "token-de-marta-abc123", "2026-11-15T15:00:00.000Z"),
      personalLinkDraftKey("dental-smile", "token-de-marta-abc123", "2026-12-01T15:00:00.000Z"),
      personalLinkDraftKey("dental-smile", "token-de-marta-abc123", null),
      deviceDraftKey({ clinic: "dental-smile", flow: "registro", token: "token-de-marta-abc123" }),
      deviceDraftKey({ clinic: "dental-smile", flow: "registro", entry: "qr" }),
      deviceDraftKey({ clinic: "dental-smile", flow: "registro", entry: "public_link" }),
    ])
    expect(keys.size).toBe(7)
  })

  it("el token no queda escrito en el celular", () => {
    writeDeviceDraft(marta, { givenNames: "Marta" }, step3)
    expect(local.keys().join(" ")).not.toContain("token-de-marta")
  })

  it("si el enlace ya no sirve se borra lo de todas sus citas, y solo lo suyo", () => {
    const otherAppointment = personalLinkDraftKey("dental-smile", "token-de-marta-abc123", "2026-12-01T15:00:00.000Z")
    const rosa = personalLinkDraftKey("dental-smile", "token-de-rosa-xyz789", null)
    writeDeviceDraft(marta, { givenNames: "Marta" }, step3)
    writeDeviceDraft(otherAppointment, { givenNames: "Marta" }, step3)
    writeDeviceDraft(rosa, { givenNames: "Rosa" }, step3)
    clearDeviceDraftsOfLink("dental-smile", "token-de-marta-abc123")
    expect(local.keys()).toEqual([rosa])
  })
})

describe("al cargar la página", () => {
  it("se borra lo vencido de cualquier enlace, lo vigente se queda, y lo que el registro dejaba en la pestaña se va", () => {
    const old = personalLinkDraftKey("dental-smile", "token-viejo", null)
    writeDeviceDraft(old, { givenNames: "Ana" }, null)
    vi.setSystemTime(START.getTime() + 23 * HOUR)
    writeDeviceDraft(marta, { givenNames: "Marta" }, step3)
    local.setItem("odentia-theme", "dark")
    session.setItem("registro:dental-smile:qr", JSON.stringify({ givenNames: "Luis" }))
    vi.setSystemTime(START.getTime() + 25 * HOUR)
    sweepDeviceDrafts()
    expect(local.keys().sort()).toEqual([marta, "odentia-theme"].sort())
    expect(session.keys()).toEqual([])
  })
})

describe("si el navegador no deja guardar, funciona igual y sin error", () => {
  it("en una ventana privada que lo bloquea", () => {
    vi.stubGlobal("window", { localStorage: blocked, sessionStorage: blocked })
    expect(deviceDraftsWork()).toBe(false)
    expect(() => writeDeviceDraft(marta, { givenNames: "Marta" }, step3)).not.toThrow()
    expect(readDeviceDraft(marta)).toBeNull()
    expect(() => clearDeviceDraft(marta)).not.toThrow()
    expect(() => clearDeviceDraftsOfLink("dental-smile", "t")).not.toThrow()
    expect(() => sweepDeviceDrafts()).not.toThrow()
  })

  it("si leer el almacenamiento lanza, o no hay ventana (servidor)", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError")
      },
    })
    expect(deviceDraftsWork()).toBe(false)
    expect(readDeviceDraft(marta)).toBeNull()
    vi.unstubAllGlobals()
    expect(deviceDraftsWork()).toBe(false)
    expect(() => writeDeviceDraft(marta, {}, null)).not.toThrow()
  })

  it("con almacenamiento, sí guarda y la pantalla lo puede decir", () => {
    expect(deviceDraftsWork()).toBe(true)
    expect(local.keys()).toEqual([])
  })
})

describe("lo que dice la pantalla", () => {
  it("«Vas en el paso 3 de 6» y hasta cuándo sigue, sin lo escrito", () => {
    const until = draftUntilWords(START.getTime() + DEVICE_DRAFT_TTL_MS, START.getTime(), "es-PE", "America/Lima")
    expect(until).toMatch(/^hasta mañana, 2:15\sp\.\sm\.$/)
    expect(draftResumeWords(step3, until)).toEqual({
      title: "Vas en el paso 3 de 6",
      text: `Lo que escribiste sigue guardado en este celular ${until} Todavía no lo enviaste.`,
    })
    // Una hora sin punto final lo lleva.
    expect(draftResumeWords(step3, "hasta mañana, 14:15").text).toContain("hasta mañana, 14:15. Todavía")
    expect(draftResumeWords(null, until).title).toBe("Lo que escribiste sigue aquí")
  })

  it("si vence el mismo día, dice «hasta hoy»", () => {
    const now = new Date("2026-11-14T00:30:00-05:00").getTime()
    expect(draftUntilWords(now + 20 * HOUR, now, "es-PE", "America/Lima")).toMatch(/^hasta hoy, 8:30\sp\.\sm\.$/)
  })
})
