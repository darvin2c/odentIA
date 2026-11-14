// @vitest-environment jsdom
import { DEFAULT_REGISTRATION_CONFIG } from "@odentia/clinical"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEVICE_DRAFT_TTL_MS, deviceDraftKey, readDeviceDraft } from "../../lib/device-draft"
import { bareProduct, declareProduct } from "../../product/product-ui"
import { type RegistrationFill, RegistrationQuestionnaire } from "./registration-questionnaire"

// Mesa de formularios del 13 nov, entrega 9: el cuestionario de verdad, montado en un navegador
// de prueba, escribe en el celular, se cierra y se vuelve a abrir.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const config = { ...DEFAULT_REGISTRATION_CONFIG, enabled: true, privacyNotice: "Aviso de demostración" }
const key = deviceDraftKey({ clinic: "dental-smile", flow: "registro", entry: "qr" })
const PROMISE = "Lo que escribas se guarda en este celular hasta que lo envíes, por un día."
const mounted: Array<{ host: HTMLElement; root: Root }> = []

async function open(
  props: {
    resume?: boolean
    fill?: RegistrationFill
    /** Recibe lo que contó de su visita. */
    onSubmit?: (visitReason: string | undefined) => Promise<void>
  } = {},
) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted.push({ host, root })
  await act(async () => {
    root.render(
      <RegistrationQuestionnaire
        config={config}
        today="2026-11-13"
        countryCode="PE"
        draftKey={key}
        resume={props.resume}
        fill={props.fill}
        submitLabel="Enviar"
        onSubmit={async (_answers, extra) => {
          await props.onSubmit?.(extra.visit?.reason)
        }}
      />,
    )
  })
  return host
}

/** Cerrar el navegador: la página se va, el celular se queda con lo suyo. */
async function closeAll() {
  for (const { host, root } of mounted.splice(0)) {
    await act(async () => root.unmount())
    host.remove()
  }
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent === label && !item.hidden && !item.closest("[hidden]"))

async function press(element: Element | null | undefined) {
  if (!element) throw new Error("No está en la pantalla")
  await act(async () => (element as HTMLElement).click())
  // El envío espera su validación y la respuesta: se deja terminar.
  await act(async () => new Promise((done) => setTimeout(done, 20)))
}

async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("Falta el campo")
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const givenNames = (host: HTMLElement) => host.querySelector<HTMLInputElement>('[data-field="givenNames"] input')

/** «Para mí», «Siguiente» y su nombre: queda en el paso 2. */
async function writeName(host: HTMLElement, name: string) {
  await press(host.querySelector('input[value="patient"]'))
  await press(button(host, "Siguiente"))
  await type(givenNames(host), name)
}

beforeEach(() => {
  declareProduct(bareProduct("dental"))
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(async () => {
  await closeAll()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("si la interrumpen, lo escrito sigue en su celular", () => {
  it("lo dice mientras escribe, y guarda lo escrito con su paso", async () => {
    const host = await open()
    expect(host.textContent).toContain(PROMISE)
    await writeName(host, "Marta")
    const saved = readDeviceDraft<{ givenNames: string }>(key)
    expect(saved?.values.givenNames).toBe("Marta")
    expect(saved?.step).toMatchObject({ item: "person", current: 2 })
  })

  it("cierra y vuelve: «Vas en el paso 2 de …» y un toque en «Seguir donde ibas» la deja con lo escrito", async () => {
    await writeName(await open(), "Marta")
    await closeAll()
    const host = await open()
    expect(host.textContent).toMatch(/Vas en el paso 2 de \d+/)
    expect(host.textContent).toContain("Todavía no lo enviaste.")
    // Nunca lo que escribió, antes de decidir.
    expect(host.textContent).not.toContain("Marta")
    await press(button(host, "Seguir donde ibas"))
    expect(givenNames(host)?.value).toBe("Marta")
    expect(host.querySelector('[role="progressbar"]')?.textContent).toMatch(/^Paso 2 de \d+$/)
  })

  it("desde «Seguir donde ibas» de su tarjeta, sigue sin volver a preguntar", async () => {
    await writeName(await open(), "Marta")
    await closeAll()
    const host = await open({ resume: true })
    expect(button(host, "Seguir donde ibas")).toBeUndefined()
    expect(givenNames(host)?.value).toBe("Marta")
  })

  it("«Empezar de nuevo» lo borra del celular y empieza en blanco", async () => {
    await writeName(await open(), "Marta")
    await closeAll()
    const host = await open()
    await press(button(host, "Empezar de nuevo"))
    expect(readDeviceDraft(key)).toBeNull()
    expect(host.textContent).not.toContain("Vas en el paso")
    expect(host.querySelector('[role="progressbar"]')?.textContent).toMatch(/^Paso 1 de/)
  })

  it("dos días después ya no está y no se promete nada de lo de antes (reloj falso)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-11T14:15:00-05:00"))
    await writeName(await open(), "Marta")
    await closeAll()
    vi.setSystemTime(new Date("2026-11-13T14:15:00-05:00"))
    const host = await open()
    expect(host.textContent).not.toContain("Vas en el paso")
    expect(host.textContent).not.toContain("Seguir donde ibas")
    expect(localStorage.getItem(key)).toBeNull()
    expect(givenNames(host)?.value ?? "").toBe("")
  })

  it("a las 23 horas sigue ahí", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const start = new Date("2026-11-11T14:15:00-05:00").getTime()
    vi.setSystemTime(start)
    await writeName(await open(), "Marta")
    await closeAll()
    vi.setSystemTime(start + DEVICE_DRAFT_TTL_MS - 60 * 60 * 1000)
    expect((await open()).textContent).toContain("Seguir donde ibas")
  })

  it("«Antes de tu cita»: al enviar se borra del celular; si el envío falla, sigue ahí", async () => {
    let fails = true
    let calls = 0
    const sent: string[] = []
    const host = await open({
      fill: {
        missing: new Set(),
        health: false,
        hasRepresentative: true,
        firstName: "Marta",
        visit: { purpose: null, questions: { reason: true, pain: false, more: false }, reader: "la Dra. Ana Torres" },
      },
      onSubmit: async (visit) => {
        calls++
        if (fails) throw new Error("Sin conexión")
        sent.push(visit ?? "")
      },
    })
    const reason = host.querySelector<HTMLTextAreaElement>('[data-field="visitReason"] textarea')
    if (!reason) throw new Error("Falta «¿A qué vienes?»")
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(reason, "Me duele una muela")
      reason.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(readDeviceDraft<{ visitReason: string }>(key)?.values.visitReason).toBe("Me duele una muela")
    await press(button(host, "Enviar"))
    // No llegó: lo escrito no se borra.
    expect(calls).toBe(1)
    expect(readDeviceDraft(key)).not.toBeNull()
    fails = false
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(reason, "Me duele una muela.")
      reason.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await press(button(host, "Enviar"))
    expect(sent).toEqual(["Me duele una muela."])
    expect(readDeviceDraft(key)).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it("en una ventana privada que no deja guardar, funciona igual, sin error y sin prometer", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Bloqueado", "SecurityError")
    })
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const host = await open()
    expect(host.textContent).not.toContain(PROMISE)
    await writeName(host, "Marta")
    expect(givenNames(host)?.value).toBe("Marta")
    expect(localStorage.length).toBe(0)
    expect(errors).not.toHaveBeenCalled()
  })
})
