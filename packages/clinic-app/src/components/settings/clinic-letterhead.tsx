import { Button, Checkbox, Input, Label, toast } from "@odentia/ui"
import { FormDrawer, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useRef, useState } from "react"
import { ApiError } from "../../lib/api"
import {
  detectMargins,
  getLetterhead,
  getLetterheadPdf,
  LETTERHEAD_QUERY_KEY,
  type LetterheadMargins,
  type LetterheadSummary,
  letterheadImages,
  pdfPageImage,
  previewLetterhead,
  type RenderedLetterhead,
  removeLetterhead,
  renderLetterhead,
  restoreLetterhead,
  saveLetterhead,
} from "../../lib/letterhead"

const MAX_BYTES = 5 * 1024 * 1024
const ACCEPT = "application/pdf,image/png,image/jpeg"
const MM_PER_PT = 25.4 / 72
const SIDES = [
  { key: "topMm", label: "Arriba (mm)" },
  { key: "bottomMm", label: "Abajo (mm)" },
  { key: "leftMm", label: "Izquierda (mm)" },
  { key: "rightMm", label: "Derecha (mm)" },
] as const

/**
 * La hoja membretada de la clínica (ADR 0180): se sube, se ve sobre una receta de
 * ejemplo y se guarda aparte, como el logo. Desde ahí los papeles en hoja salen sobre
 * ella; la casilla evita repetir la dirección y el teléfono, y el recuadro dice dónde
 * va el texto. Quitarla no pregunta: el aviso trae «Deshacer».
 */
export function ClinicLetterheadSettings({ sheetSize }: { sheetSize: string }) {
  const id = useId()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<"new" | "change" | null>(null)
  const state = useQuery({ queryKey: LETTERHEAD_QUERY_KEY, queryFn: getLetterhead })
  const current = state.data?.letterhead ?? null
  const refresh = () => queryClient.invalidateQueries({ queryKey: LETTERHEAD_QUERY_KEY })
  const remove = useMutation({
    mutationFn: removeLetterhead,
    onSuccess: async ({ removedId }) => {
      await refresh()
      toast.success("Hoja quitada. Tus papeles nuevos salen con tu logo.", {
        duration: 10_000,
        ...(removedId
          ? {
              action: {
                label: "Deshacer",
                onClick: () =>
                  void restoreLetterhead(removedId)
                    .then(async () => {
                      toast.success("Hoja membretada puesta de nuevo")
                      await refresh()
                    })
                    .catch(() => toast.error("No se pudo volver a poner: súbela de nuevo")),
              },
            }
          : {}),
      })
    },
    onError: (cause) => toast.error(submitErrorMessage(cause)),
  })
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="font-heading text-base font-medium">
          Hoja membretada
        </h2>
        <p className="text-sm text-muted-foreground">
          {current
            ? "Tus papeles en hoja salen en ella. El ticket de caja no cambia."
            : "Si tienes tu hoja membretada, súbela: tus recetas, consentimientos, presupuestos y demás papeles saldrán en ella. Sin hoja, salen con tu logo y tus datos."}
        </p>
      </div>
      {state.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No pudimos cargar tu hoja.{" "}
          <button type="button" className="underline" onClick={() => void state.refetch()}>
            Reintentar
          </button>
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          {current ? (
            <img
              src={current.thumbnailUrl}
              alt="Tu hoja membretada, en miniatura"
              className="h-[5.25rem] w-15 rounded-sm border bg-white object-cover object-top"
            />
          ) : (
            <div className="flex h-[5.25rem] w-15 items-center justify-center rounded-sm border border-dashed text-center text-xs text-muted-foreground">
              Sin hoja
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={state.isPending || remove.isPending}
              onClick={() => setOpen(current ? "change" : "new")}
            >
              {current ? "Cambiar la hoja" : "Subir la hoja"}
            </Button>
            {current ? (
              <Button
                type="button"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? "Quitando…" : "Quitar la hoja"}
              </Button>
            ) : null}
          </div>
        </div>
      )}
      <LetterheadDrawer
        open={open !== null}
        current={open === "change" ? current : null}
        contact={state.data?.contact ?? { line: null, branches: 0 }}
        sheetSize={sheetSize}
        onClose={() => setOpen(null)}
        onSaved={async () => {
          setOpen(null)
          await refresh()
          toast.success("Hoja guardada. Tus papeles nuevos salen en ella.")
        }}
      />
    </section>
  )
}

interface Preview {
  image: string
  pdf: string
  /** Alto entre ancho del papel de la vista previa. */
  aspect: number
  pages: number
  lowResolution: boolean
  paper: "A4" | "Letter" | null
  signer: string | null
}

function LetterheadDrawer({
  open,
  current,
  contact,
  sheetSize,
  onClose,
  onSaved,
}: {
  open: boolean
  /** La hoja de hoy, si se abrió con «Cambiar la hoja». */
  current: LetterheadSummary | null
  contact: { line: string | null; branches: number }
  sheetSize: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const ids = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [rendered, setRendered] = useState<RenderedLetterhead | null>(null)
  const [detected, setDetected] = useState<LetterheadMargins | null>(null)
  const [margins, setMargins] = useState<LetterheadMargins | null>(null)
  const [hasContact, setHasContact] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const [dirty, setDirty] = useState(false)
  const previewTurn = useRef(0)

  // Al abrir: vacío, o la hoja de hoy dibujada para corregirla sin volver a subirla.
  useEffect(() => {
    if (!open) return
    setFile(null)
    setRendered(null)
    setDetected(null)
    setMargins(null)
    setPreview(null)
    setFileError(null)
    setSaveError(null)
    setAdjusting(false)
    setDirty(false)
    setHasContact(current?.hasContact ?? false)
    if (!current) return
    let alive = true
    setBusy(true)
    getLetterheadPdf()
      .then(renderLetterhead)
      .then((drawn) => {
        if (!alive) return
        const own = {
          topMm: current.topMm,
          bottomMm: current.bottomMm,
          leftMm: current.leftMm,
          rightMm: current.rightMm,
        }
        setRendered(drawn)
        setDetected(detectMargins(drawn))
        setMargins(own)
      })
      .catch(
        () =>
          alive && setFileError("No pudimos abrir tu hoja. Vuelve a elegirla con «Elegir otra»."),
      )
      .finally(() => alive && setBusy(false))
    return () => {
      alive = false
    }
  }, [open, current])

  // La vista previa se rehace al cambiar la hoja, la casilla o dónde va el texto.
  useEffect(() => {
    if (!open || !rendered || !margins) return
    const turn = ++previewTurn.current
    const timer = setTimeout(() => {
      setBusy(true)
      previewLetterhead(file, margins, hasContact)
        .then(async (result) => {
          const image = await pdfPageImage(result.pdf, 800)
          const probe = new Image()
          probe.src = image
          await probe.decode().catch(() => undefined)
          if (turn !== previewTurn.current) return
          setPreview({
            image,
            pdf: result.pdf,
            aspect: probe.naturalWidth ? probe.naturalHeight / probe.naturalWidth : 297 / 210,
            pages: result.pages,
            lowResolution: result.lowResolution,
            paper: result.paper,
            signer: result.signer,
          })
          setFileError(null)
        })
        .catch((cause) => {
          if (turn !== previewTurn.current) return
          setPreview(null)
          setFileError(fieldError(cause) ?? "No pudimos preparar la vista previa. Prueba de nuevo.")
        })
        .finally(() => turn === previewTurn.current && setBusy(false))
    }, 350)
    return () => clearTimeout(timer)
  }, [open, rendered, margins, hasContact, file])

  async function choose(next: File | undefined) {
    if (!next) return
    setSaveError(null)
    if (!/^(application\/pdf|image\/png|image\/jpeg)$/.test(next.type)) {
      setFileError("La hoja debe ser PDF, PNG o JPG")
      return
    }
    if (next.size > MAX_BYTES) {
      setFileError("La hoja no puede superar 5 MB")
      return
    }
    setBusy(true)
    setFileError(null)
    try {
      const drawn = await renderLetterhead(next)
      const found = detectMargins(drawn)
      setFile(next)
      setRendered(drawn)
      setDetected(found)
      setMargins(found)
      setDirty(true)
    } catch {
      setFileError("No pudimos leer esa hoja. Si es un PDF con clave, guárdalo sin clave.")
      setBusy(false)
    }
  }

  function setSide(key: keyof LetterheadMargins, value: number) {
    if (!Number.isFinite(value)) return
    setMargins((now) => (now ? { ...now, [key]: Math.max(0, Math.round(value * 2) / 2) } : now))
    setDirty(true)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!rendered || !margins) {
      setFileError("Elige tu hoja")
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      await saveLetterhead({
        file,
        margins,
        hasContact: contact.line ? hasContact : false,
        images: await letterheadImages(rendered, margins),
      })
      await onSaved()
    } catch (cause) {
      const field = fieldError(cause)
      if (field) setFileError(field)
      else setSaveError(submitErrorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  const sheetWidthMm = rendered ? rendered.widthPt * MM_PER_PT : 210
  const box =
    preview && margins
      ? {
          top: (margins.topMm / sheetWidthMm / preview.aspect) * 100,
          bottom: (margins.bottomMm / sheetWidthMm / preview.aspect) * 100,
          left: (margins.leftMm / sheetWidthMm) * 100,
          right: (margins.rightMm / sheetWidthMm) * 100,
        }
      : null
  const ownPaper = sheetSize === "Letter" ? "Letter" : "A4"
  const paperWords = { A4: "A4", Letter: "Carta" } as const

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="Hoja membretada"
      description="PDF, PNG o JPG. Mejor sin RUC, dirección ni teléfono: esos los ponemos desde tus datos."
      onSubmit={(event) => void submit(event)}
      isDirty={dirty}
      isSubmitting={saving}
      error={saveError}
      submitLabel="Usar esta hoja"
      submitDisabled={!rendered || !preview || busy}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {file?.name ?? current?.fileName ?? "Ningún archivo elegido"}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={saving}
            >
              {file || current ? "Elegir otra" : "Elegir la hoja"}
            </Button>
          </div>
          <input
            ref={inputRef}
            id={`${ids}-file`}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            aria-label="Elegir la hoja membretada"
            aria-invalid={fileError ? true : undefined}
            aria-describedby={fileError ? `${ids}-file-error` : undefined}
            onChange={(event) => {
              void choose(event.target.files?.[0])
              event.target.value = ""
            }}
          />
          {fileError ? (
            <p id={`${ids}-file-error`} role="alert" className="text-sm text-destructive">
              {fileError}
            </p>
          ) : null}
        </div>

        {rendered && margins ? (
          <>
            <div className="flex flex-col gap-2">
              <div
                className="relative w-full overflow-hidden rounded-sm border bg-white"
                aria-busy={busy}
              >
                {preview ? (
                  <img
                    src={preview.image}
                    alt="Vista previa: una receta de ejemplo sobre tu hoja"
                    className="block h-auto w-full"
                  />
                ) : (
                  <div className="flex aspect-[210/297] items-center justify-center text-sm text-muted-foreground">
                    Preparando la vista previa…
                  </div>
                )}
                {box ? (
                  <TextBox
                    box={box}
                    adjusting={adjusting}
                    onDrag={(key, fraction) => {
                      if (!preview) return
                      const mm =
                        key === "leftMm" || key === "rightMm"
                          ? fraction * sheetWidthMm
                          : fraction * sheetWidthMm * preview.aspect
                      setSide(key, mm)
                    }}
                  />
                ) : null}
                {busy && preview ? (
                  <span className="absolute top-2 right-2 rounded bg-background/90 px-2 py-0.5 text-xs">
                    Actualizando…
                  </span>
                ) : null}
              </div>
              {preview ? (
                <button
                  type="button"
                  className="self-start text-sm font-medium text-primary underline-offset-4 hover:underline"
                  onClick={() => openPdf(preview.pdf)}
                >
                  Ver en grande
                </button>
              ) : null}
              <p className="text-sm text-muted-foreground">
                {preview?.signer
                  ? `Así sale una receta de ${preview.signer} sobre tu hoja. `
                  : "Así sale una receta sobre tu hoja. "}
                Esta hoja la usan los papeles de todo el equipo: si lleva el nombre o la colegiatura
                de una persona, la receta de otro profesional saldrá con los dos. Pide a quien la
                diseñó una versión sin esos datos.
              </p>
              {contact.branches > 1 ? (
                <p className="text-sm text-muted-foreground">
                  Tu clínica tiene {contact.branches} sedes: si tu hoja dice una dirección, saldrá
                  en los papeles de todas.
                </p>
              ) : null}
              {preview && preview.pages > 1 ? (
                <p className="text-sm">Tu PDF tiene {preview.pages} páginas: usamos la primera.</p>
              ) : null}
              {preview?.lowResolution ? (
                <p className="text-sm">
                  Se imprimirá borrosa: si tienes tu hoja en PDF, súbela en PDF.
                </p>
              ) : null}
              {preview?.paper && preview.paper !== ownPaper ? (
                <p className="text-sm">
                  Tu hoja es {paperWords[preview.paper]} y tus papeles salen en{" "}
                  {paperWords[ownPaper]}: la encajamos sin deformarla. El tamaño de tus papeles se
                  cambia en «Medios de pago y ticket».
                </p>
              ) : null}
            </div>

            {contact.line ? (
              <div className="flex items-start gap-2">
                <Checkbox
                  id={`${ids}-contact`}
                  checked={hasContact}
                  onCheckedChange={(value) => {
                    setHasContact(value === true)
                    setDirty(true)
                  }}
                  aria-describedby={`${ids}-contact-hint`}
                  className="mt-0.5"
                />
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor={`${ids}-contact`}>
                    Mi hoja ya trae la dirección y el teléfono
                  </Label>
                  <p id={`${ids}-contact-hint`} className="text-sm text-muted-foreground">
                    Si la marcas, no agregamos «{contact.line}».
                  </p>
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-3">
              <Button
                type="button"
                variant="link"
                className="h-auto self-start p-0"
                aria-expanded={adjusting}
                aria-controls={`${ids}-adjust`}
                onClick={() => setAdjusting((now) => !now)}
              >
                Ajustar dónde va el texto
              </Button>
              {adjusting ? (
                <div id={`${ids}-adjust`} className="flex flex-col gap-3 rounded-lg border p-3">
                  <p className="text-sm text-muted-foreground">
                    Lo encontramos solos. Si el texto pisa tu diseño, arrastra los bordes del
                    recuadro o escribe cuánto dejar desde cada borde de la hoja.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {SIDES.map((side) => (
                      <div key={side.key} className="flex flex-col gap-1">
                        <Label htmlFor={`${ids}-${side.key}`}>{side.label}</Label>
                        <Input
                          id={`${ids}-${side.key}`}
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step={0.5}
                          value={margins[side.key]}
                          onChange={(event) => setSide(side.key, Number(event.target.value))}
                        />
                      </div>
                    ))}
                  </div>
                  {detected ? (
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto self-start p-0"
                      onClick={() => {
                        setMargins(detected)
                        setDirty(true)
                      }}
                    >
                      Volver a lo que encontramos
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        ) : busy ? (
          <p className="text-sm text-muted-foreground" role="status">
            Leyendo tu hoja…
          </p>
        ) : null}
      </div>
    </FormDrawer>
  )
}

/**
 * El recuadro de dónde va el texto, encima de la vista previa. Al ajustar, sus bordes se
 * arrastran; los mismos valores se escriben en los campos (la vía con teclado).
 */
function TextBox({
  box,
  adjusting,
  onDrag,
}: {
  box: { top: number; bottom: number; left: number; right: number }
  adjusting: boolean
  onDrag: (key: keyof LetterheadMargins, fraction: number) => void
}) {
  const frame = useRef<HTMLDivElement>(null)
  const drag = (key: keyof LetterheadMargins) => (event: React.PointerEvent<HTMLSpanElement>) => {
    const area = frame.current?.getBoundingClientRect()
    if (!area) return
    event.preventDefault()
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const move = (moved: PointerEvent) => {
      const x = (moved.clientX - area.left) / area.width
      const y = (moved.clientY - area.top) / area.height
      const fraction =
        key === "topMm" ? y : key === "bottomMm" ? 1 - y : key === "leftMm" ? x : 1 - x
      onDrag(key, Math.min(0.6, Math.max(0, fraction)))
    }
    const end = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", end)
    }
    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", end)
  }
  const handle = "absolute size-3.5 rounded-[3px] border-2 border-primary bg-white touch-none"
  return (
    <div ref={frame} className="pointer-events-none absolute inset-0" aria-hidden>
      <div
        // Por fuera del espacio del texto: el borde no tapa la primera letra.
        className="absolute rounded-sm outline-2 outline-offset-2 outline-primary outline-dashed"
        style={{
          top: `${box.top}%`,
          bottom: `${box.bottom}%`,
          left: `${box.left}%`,
          right: `${box.right}%`,
        }}
      >
        {adjusting ? (
          <>
            <span className="absolute -top-6 left-0 rounded bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
              Aquí va el texto
            </span>
            <span
              className={`${handle} pointer-events-auto -top-2 left-1/2 -ml-1.5 cursor-ns-resize`}
              onPointerDown={drag("topMm")}
            />
            <span
              className={`${handle} pointer-events-auto -bottom-2 left-1/2 -ml-1.5 cursor-ns-resize`}
              onPointerDown={drag("bottomMm")}
            />
            <span
              className={`${handle} pointer-events-auto top-1/2 -left-2 -mt-1.5 cursor-ew-resize`}
              onPointerDown={drag("leftMm")}
            />
            <span
              className={`${handle} pointer-events-auto top-1/2 -right-2 -mt-1.5 cursor-ew-resize`}
              onPointerDown={drag("rightMm")}
            />
          </>
        ) : null}
      </div>
    </div>
  )
}

/** El error que el servidor dijo junto al archivo, si lo dijo. */
function fieldError(cause: unknown): string | null {
  if (!(cause instanceof ApiError)) return null
  return cause.shape.fields?.file ?? (cause.status === 413 ? "La hoja no puede superar 5 MB" : null)
}

/** «Ver en grande»: la vista previa como PDF, en otra pestaña. */
function openPdf(base64: string) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
  window.open(url, "_blank", "noopener")
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
