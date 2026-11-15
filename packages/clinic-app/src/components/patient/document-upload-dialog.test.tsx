// @vitest-environment jsdom

/**
 * «No puedo subir archivos» (15 nov): la captura elegida no llegaba nunca a la API. Chrome no
 * envía un archivo del disco que cambió después de elegirlo (`ERR_UPLOAD_FILE_CHANGED`: lo
 * vuelve a guardar un programa o lo baja una carpeta que se sincroniza con la nube), y la
 * ventana lo decía como un corte de conexión, tres veces, con «Subir 0» como único botón; al
 * reenviar fallaba igual. Ahora se sube la copia leída al elegirlo.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import { bareProduct, declareProduct } from "../../product/product-ui"

vi.mock("../../lib/auth-client", () => ({ API_URL: "https://api.test" }))

const { DocumentUploadDialog } = await import("./document-upload-dialog")

declareProduct(bareProduct("dental"))

beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => []
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver
  // El cajón mira el ancho de la pantalla.
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  URL.createObjectURL = () => "blob:vista"
  URL.revokeObjectURL = () => {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function screenshot(): File {
  return new File([PNG], "Captura de pantalla 2026-10-29 155127.png", { type: "image/png" })
}

/**
 * La API, como la ve el navegador: el archivo del disco que cambió después de elegirlo no
 * sale (Chrome rechaza el envío y `fetch` falla), lo que está en memoria sí.
 */
function apiWith(changedOnDisk: ReadonlySet<File>, answer: () => Response | Promise<Response>) {
  const sent: Array<File | null> = []
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const file = ((init?.body as FormData | undefined)?.get("file") ?? null) as File | null
    sent.push(file)
    if (file && changedOnDisk.has(file)) throw new TypeError("Failed to fetch")
    return answer()
  })
  vi.stubGlobal("fetch", fetch)
  return { fetch, sent }
}

const created = () => new Response(JSON.stringify({ data: { id: "doc-1" } }), { status: 201 })

function show(onSuccess = vi.fn(async () => {})) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DocumentUploadDialog
        patientId="p1"
        encounters={[]}
        planItems={[]}
        suggestions={[]}
        open
        onOpenChange={() => {}}
        onSuccess={onSuccess}
      />
    </QueryClientProvider>,
  )
  return onSuccess
}

async function choose(file: File) {
  fireEvent.change(screen.getByLabelText("Archivos"), { target: { files: [file] } })
  await screen.findByText(file.name)
}

/** «Informe» no pide tipo de imagen: la fila queda lista para subir. */
async function asReport() {
  fireEvent.click(screen.getByRole("combobox", { name: /^Categoría/ }))
  const option = await screen.findByRole("option", { name: "Informe" })
  // Un clic del ratón empieza sobre la opción: la lista no toma el que la abrió.
  fireEvent.pointerDown(option, { pointerType: "mouse" })
  fireEvent.click(option)
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: /^Categoría/ }).textContent).toContain("Informe"),
  )
}

describe("subir una captura que cambió en el disco después de elegirla", () => {
  it("se sube lo que se eligió y queda guardada", async () => {
    const chosen = screenshot()
    const api = apiWith(new Set([chosen]), created)
    show()
    await choose(chosen)
    await asReport()
    fireEvent.click(screen.getByRole("button", { name: "Subir 1" }))

    await screen.findByText(/Guardado en Documentos/)
    expect(api.fetch).toHaveBeenCalledTimes(1)
    // Lo que viajó es la copia en memoria, con su nombre, su tipo y sus bytes.
    const sent = api.sent[0]
    expect(sent).not.toBe(chosen)
    expect(sent?.name).toBe(chosen.name)
    expect(sent?.type).toBe("image/png")
    expect(new Uint8Array(await (sent as File).arrayBuffer())).toEqual(PNG)
    expect(screen.queryByText(/no confirmado/i)).toBeNull()
  })

  it("un archivo que ya no se puede leer no entra a la cola y dice qué hacer", async () => {
    const api = apiWith(new Set(), created)
    show()
    const gone = screenshot()
    gone.arrayBuffer = () => Promise.reject(new DOMException("No se pudo leer", "NotReadableError"))
    fireEvent.change(screen.getByLabelText("Archivos"), { target: { files: [gone] } })

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain(`${gone.name}: No se pudo leer desde tu equipo`)
    expect(alert.textContent).toMatch(/vuelve a elegirlo/)
    expect(screen.queryByRole("combobox", { name: /^Categoría/ })).toBeNull()
    expect(api.fetch).not.toHaveBeenCalled()
  })
})

describe("cuando no queda nada por subir", () => {
  it("guardado todo, no queda «Subir 0» ni «Cancelar»: se cierra con «Cerrar»", async () => {
    apiWith(new Set(), created)
    show()
    await choose(screenshot())
    await asReport()
    fireEvent.click(screen.getByRole("button", { name: "Subir 1" }))
    await screen.findByText(/Guardado en Documentos/)

    expect(screen.queryByRole("button", { name: /^Subir/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull()
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeTruthy()
  })

  it("sin respuesta del servidor, lo dice una sola vez, en su fila, con su «Verifiqué: reenviar»", async () => {
    const api = apiWith(new Set(), () => Promise.reject(new TypeError("Failed to fetch")))
    show()
    await choose(screenshot())
    await asReport()
    fireEvent.click(screen.getByRole("button", { name: "Subir 1" }))

    const row = (await screen.findByRole("button", { name: "Verifiqué: reenviar" })).closest(
      "li",
    ) as HTMLElement
    expect(within(row).getByRole("alert").textContent).toMatch(/puede que se haya guardado/)
    // Ni «Hay 1 archivo(s)…» ni «1 archivo(s) sin guardar…» ni «No queda ningún archivo…».
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    expect(screen.queryByText(/archivo\(s\)/)).toBeNull()
    expect(screen.queryByRole("button", { name: /^Subir/ })).toBeNull()
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeTruthy()

    // Reenviar es la decisión de esa fila, y la copia en memoria se vuelve a enviar.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => created()),
    )
    fireEvent.click(within(row).getByRole("button", { name: "Verifiqué: reenviar" }))
    await screen.findByText(/Guardado en Documentos/)
    expect(api.fetch).toHaveBeenCalledTimes(1)
  })
})
