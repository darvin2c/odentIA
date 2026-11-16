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
import { encodeDemoDicom } from "@odentia/clinical"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import type { Encounter } from "../../lib/patients"
import { bareProduct, declareProduct, type ProductSiteUi } from "../../product/product-ui"

vi.mock("../../lib/auth-client", () => ({ API_URL: "https://api.test" }))
// La atención que lee la ventana (sus piezas), sin el contexto de TanStack Start; lo demás, como siempre.
const api = vi.hoisted(() => ({ attention: null as unknown }))
vi.mock("../../lib/api", async (original) => {
  const real = await original<typeof import("../../lib/api")>()
  return {
    ...real,
    apiFetch: (path: string, init?: RequestInit) =>
      api.attention && path === "/api/patients/p1/encounters/e1"
        ? Promise.resolve({ data: api.attention })
        : real.apiFetch(path, init),
  }
})

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

/**
 * Lo que el archivo ya trae se llena solo (16 nov): la fecha de un DICOM o de la foto, el
 * tipo de un DICOM, «Informe» en un PDF, el título si el nombre es el de la cámara y, desde
 * una atención en curso, las piezas que trata. Cada dato dice de dónde salió.
 */
describe("se llena con lo que trae el archivo", () => {
  const SITE = {
    placeLabel: "Pieza",
    placesLabel: "Piezas",
    PlacesPicker: ({ value, id }: { value: number[]; id?: string }) => (
      <output id={id} aria-label="Piezas elegidas">
        {value.join(", ")}
      </output>
    ),
  } as unknown as ProductSiteUi

  beforeAll(() => declareProduct({ ...bareProduct("dental"), site: SITE }))
  afterAll(() => declareProduct(bareProduct("dental")))

  const DRAFT = {
    id: "e1",
    status: "borrador",
    createdAt: new Date().toISOString(),
    reason: "Endodoncia",
    branchId: null,
    professionalUserId: "u1",
    evolution: null,
    indications: null,
    finalizedAt: null,
    finalizedBy: null,
  } as unknown as Encounter

  /** La atención trata la 46 (su procedimiento) y la 11 está anulada: solo cuenta la 46. */
  function apiWithAttention() {
    api.attention = {
      teeth: [],
      procedures: [
        { id: "pr1", description: "Endodoncia", toothNumber: 46, voidedAt: null },
        { id: "pr2", description: "Resina", toothNumber: 11, voidedAt: "2026-11-15T10:00:00Z" },
      ],
      diagnoses: [],
      plannedItems: [],
      indicatedItems: [],
      odontogramEntries: [],
      documents: [],
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => created()),
    )
  }

  function showWith(props: { defaultEncounterId?: string } = {}) {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DocumentUploadDialog
          patientId="p1"
          encounters={[DRAFT]}
          planItems={[]}
          suggestions={[]}
          open
          onOpenChange={() => {}}
          onSuccess={async () => {}}
          {...props}
        />
      </QueryClientProvider>,
    )
  }

  /** Una foto del celular con su EXIF: DateTimeOriginal 2026:11:14. */
  function cameraPhoto(): File {
    const ascii = new TextEncoder().encode("2026:11:14 10:24:05\0")
    const tiff = new Uint8Array(44 + ascii.length)
    const view = new DataView(tiff.buffer)
    tiff.set([0x49, 0x49, 0x2a, 0x00])
    view.setUint32(4, 8, true)
    view.setUint16(8, 1, true)
    view.setUint16(10, 0x8769, true)
    view.setUint16(12, 4, true)
    view.setUint32(14, 1, true)
    view.setUint32(18, 26, true)
    view.setUint16(26, 1, true)
    view.setUint16(28, 0x9003, true)
    view.setUint16(30, 2, true)
    view.setUint32(32, ascii.length, true)
    view.setUint32(36, 44, true)
    tiff.set(ascii, 44)
    const length = 8 + tiff.length
    const exif = [0xff, 0xe1, length >> 8, length & 0xff, ...new TextEncoder().encode("Exif\0\0"), ...tiff]
    return new File([new Uint8Array([0xff, 0xd8, ...exif, 0xff, 0xd9])], "IMG_4821.jpg", { type: "image/jpeg" })
  }

  const titleOf = () => (screen.getByRole("textbox", { name: /^Título/ }) as HTMLInputElement).value

  it("desde una atención en curso, propone las piezas que trata y las pone en el título", async () => {
    apiWithAttention()
    showWith({ defaultEncounterId: "e1" })
    await choose(cameraPhoto())

    await waitFor(() => expect(titleOf()).toMatch(/^Imagen · pieza 46 · 14 nov/))
    expect(screen.getByText("Sugerido con lo que trae el archivo")).toBeTruthy()
    expect(screen.getByText("Tomada del archivo")).toBeTruthy()
    fireEvent.click(screen.getByText(/^Extras/))
    expect(screen.getByLabelText("Piezas elegidas").textContent).toBe("46")
    expect(screen.getByText("De la atención")).toBeTruthy()
  })

  it("sin atención, no propone ninguna pieza", async () => {
    apiWithAttention()
    showWith()
    await choose(cameraPhoto())

    await waitFor(() => expect(titleOf()).toMatch(/^Imagen · 14 nov/))
    fireEvent.click(screen.getByText(/^Extras/))
    expect(screen.getByLabelText("Piezas elegidas").textContent).toBe("")
    expect(screen.queryByText("De la atención")).toBeNull()
  })

  it("el título armado sigue a lo que se elige, hasta que la persona lo escribe", async () => {
    apiWithAttention()
    showWith()
    await choose(cameraPhoto())
    await asReport()
    await waitFor(() => expect(titleOf()).toMatch(/^Informe · 14 nov/))

    fireEvent.change(screen.getByRole("textbox", { name: /^Título/ }), { target: { value: "Receta de otra clínica" } })
    expect(screen.queryByText("Sugerido con lo que trae el archivo")).toBeNull()
    fireEvent.click(screen.getByRole("combobox", { name: /^Categoría/ }))
    const other = await screen.findByRole("option", { name: "Otro" })
    fireEvent.pointerDown(other, { pointerType: "mouse" })
    fireEvent.click(other)
    await waitFor(() => expect(screen.getByRole("combobox", { name: /^Categoría/ }).textContent).toContain("Otro"))
    expect(titleOf()).toBe("Receta de otra clínica")
  })

  it("un PDF con el nombre que le puso la persona: lo conserva y se sugiere como informe", async () => {
    apiWithAttention()
    showWith()
    await choose(new File(["%PDF-1.7"], "Hemograma Rosa Quispe.pdf", { type: "application/pdf" }))

    expect(titleOf()).toBe("Hemograma Rosa Quispe")
    expect(screen.queryByText("Sugerido con lo que trae el archivo")).toBeNull()
    expect(screen.getByRole("combobox", { name: /^Categoría/ }).textContent).toContain("Informe")
    expect(screen.getByText("Sugerida para un PDF")).toBeTruthy()
  })

  it("un DICOM intraoral: radiografía con su fecha, y el tipo queda por elegir", async () => {
    apiWithAttention()
    showWith({ defaultEncounterId: "e1" })
    const bytes = encodeDemoDicom({ width: 4, height: 2, pixels: new Uint16Array(8), studyDate: "20261112" })
    await choose(new File([bytes as BlobPart], "IM000001.dcm", { type: "application/dicom" }))

    await waitFor(() => expect(titleOf()).toMatch(/^Radiografía intraoral · pieza 46 · 12 nov/))
    expect(screen.getByRole("combobox", { name: /^Categoría/ }).textContent).toContain("Radiografía")
    expect(screen.getAllByText("Tomada del archivo")).toHaveLength(2)
    expect(screen.getByRole("combobox", { name: /^Tipo de imagen/ }).textContent).toContain("Elige el tipo")
  })
})
