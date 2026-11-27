import { Button, cn, Input, toast } from "@odentia/ui"
import {
  type BrandPalette,
  brandColorName,
  brandPalette,
  dominantColors,
  normalizeBrandColor,
} from "@odentia/ui/lib/brand-color"
import {
  DetailDrawer,
  ErrorState,
  type FieldControl,
  FormDrawer,
  FormField,
  ImageAdjust,
  type ImageAdjustValue,
  LoadingState,
  renderAdjustedImage,
  SubmitButton,
  useAppForm,
  useFieldContext,
  useFormSurface,
  ViewTabs,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  CircleAlert,
  CircleCheck,
  Crop,
  Eye,
  ImagePlus,
  Info,
  ShoppingBag,
  TriangleAlert,
  Upload,
} from "lucide-react"
import {
  type DragEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"
import { z } from "zod"
import { api, type MyStore } from "./lib/api"
import { DraftGuard } from "./lib/draft-guard"
import {
  type BrandView,
  COVER_TYPES,
  colorChoices,
  GESTORIA_COLOR,
  initialsOf,
  LINK_DOMAIN,
  type LinkCheck,
  LOGO_TYPES,
  linkFromText,
  MIN_LOGO_SIDE,
  pickProblem,
} from "./lib/marca"
import { type CatalogItem, money } from "./lib/tienda"
import { Photo, shrinkPhoto } from "./piezas"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * Configuración › Tu marca (lienzo «gestorIA · Configuración, de nuevo», tablero 04): el logo, el
 * color, la portada, el nombre que ve la clienta y el link, con la vista previa grande de lo que
 * ve la clienta al lado.
 *
 * - El logo y la portada se sueltan, se eligen o se pegan (Ctrl + V): arrastrar nunca es la única
 *   forma. El logo se recorta con `ImageAdjust` (flechas y + y −, sin arrastrar) y se sube como
 *   imagen con `renderAdjustedImage`: un SVG se pasa a imagen antes, nunca se guarda como SVG.
 * - Los colores salen del logo, leídos en el navegador; cualquier color vale (ADR 0162) y lo que
 *   el sistema ajusta para que se lea se dice, sin frenar.
 * - Nada se guarda hasta «Guardar», que lo manda todo junto (logo, portada, color, nombre y link):
 *   si algo no se puede, no se guarda nada. Salir antes pregunta (`DraftGuard`).
 */

const BRAND_KEY = (storeId: string) => ["marca", storeId]

export function BrandPage() {
  const { store } = useStoreContext()
  const brand = useQuery({
    queryKey: BRAND_KEY(store.id),
    queryFn: () => api<{ brand: BrandView }>(`/api/tiendas/${store.id}/marca`),
  })
  return (
    <>
      <StoreHeader title="Tu marca" />
      {brand.isPending ? (
        <LoadingState kind="indeterminate" message="Cargando tu marca…" className="max-w-sm" />
      ) : brand.isError ? (
        <ErrorState
          error={brand.error instanceof Error ? brand.error : "No se pudo cargar"}
          onRetry={() => void brand.refetch()}
        />
      ) : (
        <BrandEditor
          // Lo guardado manda cuando cambia: el formulario vuelve a empezar desde ahí.
          key={[
            brand.data.brand.publicName,
            brand.data.brand.link,
            brand.data.brand.brandColor,
            brand.data.brand.logo?.version,
            brand.data.brand.cover?.version,
          ].join("|")}
          store={store}
          brand={brand.data.brand}
        />
      )}
    </>
  )
}

/** El logo o la portada guardados, como URL del navegador (se piden con la sesión). */
function useSavedImage(storeId: string, kind: "logo" | "portada", version: number | null) {
  const blob = useQuery({
    queryKey: ["marca-imagen", storeId, kind, version],
    queryFn: () => api<Blob>(`/api/tiendas/${storeId}/marca/${kind}?v=${version}`, { as: "blob" }),
    enabled: version !== null,
    staleTime: Number.POSITIVE_INFINITY,
  })
  return useBlobUrl(blob.data ?? null)
}

function useBlobUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return url
}

/** Lo que se ve de una imagen de Tu marca: la nueva, ninguna (se quita) o la guardada. */
function shownImage(
  draft: { kind: "igual" | "quitar" | "nuevo" },
  fresh: string | null,
  saved: string | null,
): string | null {
  return draft.kind === "nuevo" ? fresh : draft.kind === "quitar" ? null : saved
}

async function loadImage(source: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.decoding = "async"
  image.src = source
  await image.decode()
  return image
}

/** Lado mayor del logo que se sube: nítido en el catálogo y liviano. */
const LOGO_SIDE = 1024

/** El tamaño que tendrá un recorte al pasarlo a `LOGO_SIDE`. */
function sizeAt(width: number, height: number) {
  const scale = Math.min(1, LOGO_SIDE / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Lo elegido, listo para subir: la imagen tal como se guardará (hasta 1024 px, con
 * `renderAdjustedImage`), así lo que se ve, sus colores y lo guardado son lo mismo. Un SVG se
 * dibuja antes a 1024 px: se guarda siempre una imagen, nunca el SVG (puede llevar código). Es la
 * misma cuenta que `rasterize` de `ImageAdjust`, que lo común aún no exporta.
 */
async function prepareLogo(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const owned: string[] = []
  const own = (blob: Blob) => {
    const url = URL.createObjectURL(blob)
    owned.push(url)
    return url
  }
  try {
    let source = own(file)
    let image = await loadImage(source)
    if (file.type === "image/svg+xml") {
      const naturalWidth = image.naturalWidth || LOGO_SIDE
      const naturalHeight = image.naturalHeight || LOGO_SIDE
      const canvas = document.createElement("canvas")
      // Un dibujo no pierde nada al agrandarse: se dibuja a 1024 px por su lado mayor.
      const scale = LOGO_SIDE / Math.max(naturalWidth, naturalHeight)
      canvas.width = Math.round(naturalWidth * scale)
      canvas.height = Math.round(naturalHeight * scale)
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height)
      const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
      if (!png) throw new Error("svg")
      source = own(png)
      image = await loadImage(source)
    }
    const area = { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight }
    const { blob } = await renderAdjustedImage({ shape: "logo", source, area }, LOGO_SIDE)
    return { blob, ...sizeAt(area.width, area.height) }
  } finally {
    for (const url of owned) URL.revokeObjectURL(url)
  }
}

/** Los colores de una imagen, leídos en el navegador sobre blanco (lo transparente es papel). */
async function colorsOf(source: string): Promise<string[]> {
  const image = await loadImage(source)
  const scale = Math.min(1, 320 / Math.max(image.naturalWidth || 1, image.naturalHeight || 1))
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round((image.naturalWidth || 1) * scale))
  canvas.height = Math.max(1, Math.round((image.naturalHeight || 1) * scale))
  const context = canvas.getContext("2d")
  if (!context) return []
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return dominantColors(context.getImageData(0, 0, canvas.width, canvas.height).data, 4, 3)
}

/** El logo nuevo, aún sin guardar: la imagen que se subirá, su nombre y su tamaño. */
interface NewLogo {
  blob: Blob
  fileName: string
  width: number
  height: number
}

/** Quién recibe lo que se pega con Ctrl + V: el logo o la portada. */
type Pickers = RefObject<{ logo?: (file: File) => void; portada?: (file: File) => void }>
type LogoDraft = { kind: "igual" } | { kind: "quitar" } | ({ kind: "nuevo" } & NewLogo)
type CoverDraft = { kind: "igual" } | { kind: "quitar" } | { kind: "nuevo"; file: File }

const CODE_PROBLEM = "El código del color tiene 6 cifras, como #BE185D."

const brandSchema = z.object({
  publicName: z.string().max(80, "Máximo 80 caracteres"),
  link: z.string(),
  color: z.string(),
  logo: z.any(),
  cover: z.any(),
})

interface BrandValues {
  publicName: string
  link: string
  color: string
  logo: LogoDraft
  cover: CoverDraft
}

/**
 * Lo que «Guardar» manda, sin las imágenes: el nombre sin espacios de más, el color (el de
 * gestorIA no se guarda) y el link (vacío, queda el guardado: un link puesto no se quita). Con
 * esto mismo se sabe si hay cambios.
 */
function payloadOf(values: BrandValues, savedLink: string | null) {
  return {
    publicName: values.publicName.trim(),
    brandColor: values.color === GESTORIA_COLOR ? "" : values.color,
    link: linkFromText(values.link) || savedLink || "",
  }
}

function BrandEditor({ store, brand }: { store: MyStore; brand: BrandView }) {
  const canEdit = store.permissions.includes("configuracion")
  const queryClient = useQueryClient()
  const id = useId()
  const saved = brand.brandColor ?? GESTORIA_COLOR
  const savedLogo = useSavedImage(store.id, "logo", brand.logo?.version ?? null)
  const savedCover = useSavedImage(store.id, "portada", brand.cover?.version ?? null)
  const [adjusting, setAdjusting] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const coverZone = useRef<HTMLDivElement>(null)

  const defaults: BrandValues = {
    publicName: brand.publicName ?? "",
    link: brand.link ?? "",
    color: saved,
    logo: { kind: "igual" },
    cover: { kind: "igual" },
  }
  const savedPayload = JSON.stringify(payloadOf(defaults, brand.link))
  const form = useAppForm({
    defaultValues: defaults,
    validators: { onSubmit: brandSchema },
    onSubmit: async ({ value }) => {
      const body = new FormData()
      for (const [key, text] of Object.entries(payloadOf(value, brand.link)))
        if (text) body.set(key, text)
      if (!body.has("brandColor")) body.set("brandColor", "")
      if (!body.has("publicName")) body.set("publicName", "")
      if (value.logo.kind === "nuevo") body.set("logo", value.logo.blob, "logo")
      else if (value.logo.kind === "quitar") body.append("quitar", "logo")
      if (value.cover.kind === "nuevo")
        body.set("portada", await shrinkPhoto(value.cover.file), "portada")
      else if (value.cover.kind === "quitar") body.append("quitar", "portada")
      const { brand: next } = await api<{ brand: BrandView }>(`/api/tiendas/${store.id}/marca`, {
        method: "POST",
        form: body,
      })
      // El color pinta la app de todo el equipo: llega con la tienda.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["yo"] }),
        queryClient.invalidateQueries({ queryKey: ["configuracion-resumen", store.id] }),
      ])
      queryClient.setQueryData(BRAND_KEY(store.id), { brand: next })
      toast.success("Tu marca quedó guardada")
    },
  })
  const { onSubmit, isSubmitting, error } = useFormSurface(form, {
    fieldMap: { brandColor: "color", portada: "cover" },
  })
  // Las imágenes nuevas, aún sin guardar, como URL del navegador (se liberan solas).
  const logoDraft = useStore(form.store, (state) => state.values.logo)
  const coverDraft = useStore(form.store, (state) => state.values.cover)
  const newLogo = useBlobUrl(logoDraft.kind === "nuevo" ? logoDraft.blob : null)
  const newCover = useBlobUrl(coverDraft.kind === "nuevo" ? coverDraft.file : null)

  // Pegar una imagen (Ctrl + V) la pone de logo, o de portada si se está en la portada.
  const pickers: Pickers = useRef({})
  useEffect(() => {
    if (!canEdit) return
    const onPaste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((item) =>
        item.type.startsWith("image/"),
      )
      if (!file) return
      event.preventDefault()
      const inCover = coverZone.current?.contains(document.activeElement) ?? false
      pickers.current[inCover ? "portada" : "logo"]?.(file)
    }
    document.addEventListener("paste", onPaste)
    return () => document.removeEventListener("paste", onPaste)
  }, [canEdit])

  return (
    <form.Subscribe selector={(state) => state.values}>
      {(values) => {
        const shownName = values.publicName.trim() || brand.storeName
        const palette = brandPalette(values.color)
        const logoSource = shownImage(values.logo, newLogo, savedLogo)
        const coverUrl = shownImage(values.cover, newCover, savedCover)
        const dirty =
          JSON.stringify(payloadOf(values, brand.link)) !== savedPayload ||
          values.logo.kind !== "igual" ||
          values.cover.kind !== "igual"
        const pickColor = (hex: string) => form.setFieldValue("color", hex)
        const preview = (
          <ClientPreview
            store={store}
            palette={palette}
            name={shownName}
            logo={logoSource}
            cover={coverUrl}
            link={linkFromText(values.link) || linkFromText(brand.storeName)}
          />
        )
        return (
          // El ancho que manda es el de la página, no el de la ventana: con la columna lateral
          // abierta (Ajustar), la vista previa pasa a «Ver cómo queda».
          <div className="@container">
            <form
              noValidate
              onSubmit={onSubmit}
              aria-label="Tu marca"
              className="grid items-start gap-6 @4xl:grid-cols-[minmax(0,1fr)_22rem]"
            >
              <DraftGuard dirty={dirty && canEdit} />
              <div className="flex min-w-0 flex-col gap-5">
                <Section title="Logo">
                  <form.AppField name="logo">
                    {(field) => (
                      <LogoField
                        name={shownName}
                        palette={palette}
                        shown={logoSource}
                        draft={field.state.value}
                        canEdit={canEdit}
                        pickers={pickers}
                        onPicked={(logo) => field.handleChange({ kind: "nuevo", ...logo })}
                        onRemove={() =>
                          field.handleChange(brand.logo ? { kind: "quitar" } : { kind: "igual" })
                        }
                        onAdjust={() => setAdjusting(true)}
                        error={field.state.meta.errors[0]}
                      />
                    )}
                  </form.AppField>
                </Section>

                <Section
                  title="Color de tu marca"
                  description="Pinta los botones y enlaces de tu catálogo y tu gestorIA."
                >
                  <ColorPicker
                    canEdit={canEdit}
                    chosen={values.color}
                    logoSource={logoSource}
                    onPick={pickColor}
                    other={
                      <form.AppField name="color">
                        {() => <OtherColor id={`${id}-codigo`} canEdit={canEdit} />}
                      </form.AppField>
                    }
                  />
                </Section>

                <Section
                  title="Portada"
                  description="Va arriba en tu catálogo y en la vista previa de tu link."
                >
                  {/* Tocarla la deja enfocada: lo que se pegue después va a la portada. */}
                  <div ref={coverZone} tabIndex={-1} className="outline-none">
                    <form.AppField name="cover">
                      {(field) => (
                        <CoverField
                          url={coverUrl}
                          canEdit={canEdit}
                          pickers={pickers}
                          onPicked={(file) => field.handleChange({ kind: "nuevo", file })}
                          onRemove={() =>
                            field.handleChange(brand.cover ? { kind: "quitar" } : { kind: "igual" })
                          }
                          error={field.state.meta.errors[0]}
                        />
                      )}
                    </form.AppField>
                  </div>
                </Section>

                <Section title="Tu nombre y tu link">
                  <div className="flex flex-col gap-5">
                    <form.AppField name="publicName">
                      {(field) => (
                        <field.TextField
                          label="Nombre que ve la clienta"
                          id={`${id}-nombre`}
                          placeholder={brand.storeName}
                          maxLength={80}
                          disabled={!canEdit}
                          description={`Si lo dejas vacío, es el de la tienda: ${brand.storeName}.`}
                        />
                      )}
                    </form.AppField>
                    <form.AppField name="link">
                      {() => (
                        <LinkField
                          store={store}
                          id={`${id}-link`}
                          saved={brand.link}
                          placeholder={linkFromText(brand.storeName)}
                          canEdit={canEdit}
                        />
                      )}
                    </form.AppField>
                  </div>
                </Section>

                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 @4xl:hidden"
                  onClick={() => setPreviewOpen(true)}
                >
                  <Eye aria-hidden />
                  Ver cómo queda
                </Button>

                {canEdit && dirty ? (
                  <section
                    aria-label="Cambios sin guardar"
                    className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-xl bg-foreground p-3 pl-4 text-background shadow-lg"
                  >
                    <span className="w-full text-sm font-medium sm:mr-auto sm:w-auto">
                      Tienes cambios sin guardar
                    </span>
                    {error ? (
                      <span
                        role="alert"
                        className="basis-full text-sm text-background/90 sm:order-first"
                      >
                        <CircleAlert aria-hidden className="mr-1.5 inline size-4" />
                        {error}
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 flex-1 border-background/30 bg-transparent text-background hover:bg-background/10 hover:text-background sm:flex-none"
                      disabled={isSubmitting}
                      onClick={() => form.reset()}
                    >
                      Descartar
                    </Button>
                    <SubmitButton
                      type="submit"
                      className="min-h-11 flex-1 sm:flex-none"
                      pending={isSubmitting}
                    >
                      Guardar
                    </SubmitButton>
                  </section>
                ) : null}
              </div>

              <aside
                aria-label="Así lo ve tu clienta"
                className="sticky top-14 hidden flex-col gap-3 @4xl:flex"
              >
                {preview}
              </aside>
            </form>

            {/* Fuera del formulario: un envío dentro de un cajón no debe guardar Tu marca. */}
            <DetailDrawer
              open={previewOpen}
              onClose={() => setPreviewOpen(false)}
              title="Así lo ve tu clienta"
              dock={false}
            >
              {preview}
            </DetailDrawer>

            <form.AppField name="logo">
              {(field) => (
                <AdjustLogo
                  open={adjusting}
                  name={shownName}
                  logo={field.state.value}
                  source={logoSource}
                  onClose={() => setAdjusting(false)}
                  onDone={(next) => {
                    field.handleChange({ kind: "nuevo", ...next })
                    setAdjusting(false)
                  }}
                />
              )}
            </form.AppField>
          </div>
        )
      }}
    </form.Subscribe>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-col gap-0.5">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

/** Soltar un archivo sobre la zona: lo marca mientras se arrastra encima. */
function useDrop(onFile: (file: File) => void, enabled: boolean) {
  const [over, setOver] = useState(false)
  const handlers = {
    onDragOver: (event: DragEvent) => {
      if (!enabled || !event.dataTransfer.types.includes("Files")) return
      event.preventDefault()
      event.dataTransfer.dropEffect = "copy"
      setOver(true)
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
    },
    onDrop: (event: DragEvent) => {
      if (!enabled) return
      event.preventDefault()
      setOver(false)
      const file = event.dataTransfer.files[0]
      if (file) onFile(file)
    },
  }
  return { over, handlers }
}

/** Fondo de cuadros: lo transparente del logo se ve transparente. */
const CHECKERBOARD =
  "bg-[repeating-conic-gradient(var(--color-muted)_0_25%,var(--color-card)_0_50%)] bg-[length:12px_12px]"

function LogoField({
  name,
  palette,
  shown,
  draft,
  canEdit,
  pickers,
  onPicked,
  onRemove,
  onAdjust,
  error,
}: {
  name: string
  palette: BrandPalette
  /** El logo que se ve ahora: el nuevo o el guardado. */
  shown: string | null
  draft: LogoDraft
  canEdit: boolean
  pickers: Pickers
  onPicked: (logo: NewLogo) => void
  onRemove: () => void
  onAdjust: () => void
  /** Lo que dijo el servidor del logo al guardar. */
  error?: unknown
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [shownSize, setShownSize] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    if (!shown) return
    let live = true
    loadImage(shown)
      .then((image) => {
        if (live) setShownSize({ width: image.naturalWidth, height: image.naturalHeight })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [shown])

  const choose = async (file: File) => {
    const bad = pickProblem(file, "logo")
    setProblem(bad)
    if (bad) return
    setBusy(true)
    try {
      onPicked({ ...(await prepareLogo(file)), fileName: file.name || "Imagen pegada" })
    } catch {
      setProblem("No se pudo abrir esa imagen. Prueba con otra.")
    } finally {
      setBusy(false)
    }
  }
  pickers.current.logo = (file) => void choose(file)

  const { over, handlers } = useDrop((file) => void choose(file), canEdit && !busy)
  const size =
    draft.kind === "nuevo" ? { width: draft.width, height: draft.height } : shown ? shownSize : null
  const small = size !== null && Math.max(size.width, size.height) < MIN_LOGO_SIDE
  const pickButton = (label: string, first: boolean) => (
    <Button
      type="button"
      variant={first ? "secondary" : "outline"}
      className="min-h-11"
      disabled={!canEdit || busy}
      onClick={() => input.current?.click()}
      aria-describedby={`${id}-ayuda`}
    >
      {first ? <ImagePlus aria-hidden /> : null}
      {busy ? "Abriendo…" : label}
    </Button>
  )

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={input}
        type="file"
        accept={LOGO_TYPES.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void choose(file)
          event.target.value = ""
        }}
      />
      <div
        {...handlers}
        className={cn(
          "rounded-xl border-2 border-dashed transition-colors",
          over
            ? "border-primary bg-primary-soft"
            : shown
              ? "border-transparent"
              : "border-border bg-muted/40",
        )}
      >
        {shown ? (
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className={cn(
                  "flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border p-1",
                  CHECKERBOARD,
                )}
              >
                <img src={shown} alt="" className="size-full object-contain" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-semibold">{name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {draft.kind === "nuevo" ? draft.fileName : "Tu logo de ahora"}
                  {size ? ` · ${size.width} × ${size.height}` : ""}
                </span>
                {canEdit ? (
                  <span className="text-xs text-muted-foreground">
                    {over ? "Suéltalo para cambiarlo" : "Suelta otro aquí para cambiarlo"}
                  </span>
                ) : null}
              </div>
            </div>
            {canEdit ? (
              <div className="flex flex-wrap gap-1.5 border-t pt-3">
                <Button type="button" variant="outline" className="min-h-11" onClick={onAdjust}>
                  <Crop aria-hidden />
                  Ajustar
                </Button>
                {pickButton("Cambiar", false)}
                <Button type="button" variant="ghost" className="min-h-11" onClick={onRemove}>
                  Quitar
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 px-4 py-7 text-center">
            <span
              aria-hidden
              className="flex size-14 items-center justify-center rounded-full font-serif text-lg font-bold"
              style={{ backgroundColor: palette.light.fill, color: palette.light.fillForeground }}
            >
              {initialsOf(name)}
            </span>
            <div className="flex flex-col gap-1">
              <p className="flex items-center justify-center gap-1.5 text-sm font-semibold">
                <Upload aria-hidden className="size-4" />
                {over ? "Suéltalo aquí" : "Suelta aquí tu logo"}
              </p>
              <p className="text-xs text-muted-foreground">
                PNG, JPG, WebP o SVG · desde {MIN_LOGO_SIDE} px
              </p>
            </div>
            {canEdit ? pickButton("Elegir imagen", true) : null}
          </div>
        )}
      </div>
      <p id={`${id}-ayuda`} className="text-xs text-muted-foreground">
        {shown
          ? "También puedes pegar otro con Ctrl + V."
          : `Sin logo, tu clienta ve tus iniciales en tu color. También puedes pegarlo con Ctrl + V.`}
      </p>
      {small ? (
        <p className="flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          Mide {size ? Math.max(size.width, size.height) : 0} px: se verá borroso en el catálogo.
          Puedes usarlo igual o subir uno de {MIN_LOGO_SIDE} px o más.
        </p>
      ) : null}
      {problem || typeof error === "string" ? (
        <p role="alert" className="text-sm text-danger">
          {problem ?? String(error)}
        </p>
      ) : null}
    </div>
  )
}

/** «Ajustar»: el recorte común (`ImageAdjust`, modo logo), en la columna lateral. */
function AdjustLogo({
  open,
  name,
  logo,
  source,
  onClose,
  onDone,
}: {
  open: boolean
  name: string
  logo: LogoDraft
  /** El logo que se ve ahora (el nuevo o el guardado): es el que se recorta. */
  source: string | null
  onClose: () => void
  onDone: (logo: NewLogo) => void
}) {
  const [value, setValue] = useState<ImageAdjustValue | null>(null)
  const [baking, setBaking] = useState(false)
  useEffect(() => {
    if (open) setValue(null)
  }, [open])
  return (
    <FormDrawer
      open={open && source !== null}
      onClose={onClose}
      title="Ajustar el logo"
      description="Deja solo tu logo, sin bordes de más. Con el teclado: las flechas mueven el recuadro."
      submitLabel="Usar así"
      submitDisabled={value === null}
      isDirty={value !== null}
      isSubmitting={baking}
      onSubmit={(event) => {
        event.preventDefault()
        if (!value) return
        setBaking(true)
        // El recorte queda hecho aquí, tal como se subirá.
        renderAdjustedImage(value, LOGO_SIDE)
          .then(({ blob }) =>
            onDone({
              blob,
              fileName: logo.kind === "nuevo" ? logo.fileName : "Tu logo, ajustado",
              ...sizeAt(value.area.width, value.area.height),
            }),
          )
          .catch(() => {
            toast.error("No se pudo recortar el logo. Prueba otra vez o elige otra imagen.")
            onClose()
          })
          .finally(() => setBaking(false))
      }}
    >
      {source ? (
        <ImageAdjust
          key={source}
          shape="logo"
          name={name}
          defaultSource={source}
          onChange={setValue}
        />
      ) : null}
    </FormDrawer>
  )
}

function ColorPicker({
  canEdit,
  chosen,
  logoSource,
  onPick,
  other: otherField,
}: {
  canEdit: boolean
  chosen: string
  logoSource: string | null
  onPick: (hex: string) => void
  other: ReactNode
}) {
  const [fromLogo, setFromLogo] = useState<string[]>([])
  const [other, setOther] = useState(false)
  useEffect(() => {
    let live = true
    if (!logoSource) {
      setFromLogo([])
      return
    }
    colorsOf(logoSource)
      .then((colors) => {
        if (live) setFromLogo(colors)
      })
      .catch(() => {
        if (live) setFromLogo([])
      })
    return () => {
      live = false
    }
  }, [logoSource])
  const choices = colorChoices(fromLogo, chosen)
  const palette = brandPalette(chosen)
  const name = brandColorName(chosen).toLowerCase()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Colores para elegir</legend>
          {choices.map((hex) => {
            const selected = hex === chosen
            return (
              <button
                key={hex}
                type="button"
                aria-pressed={selected}
                aria-label={`${brandColorName(hex)} ${hex.toUpperCase()}`}
                title={`${brandColorName(hex)} ${hex.toUpperCase()}`}
                disabled={!canEdit}
                onClick={() => onPick(hex)}
                className={cn(
                  "flex size-11 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-shadow focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground disabled:opacity-60",
                  selected
                    ? "ring-2 ring-foreground"
                    : "ring-1 ring-foreground/15 hover:ring-foreground/40",
                )}
                style={{ backgroundColor: hex, color: brandPalette(hex).light.fillForeground }}
              >
                {selected ? <Check aria-hidden className="size-5" strokeWidth={3} /> : null}
              </button>
            )
          })}
        </fieldset>
        <span className="text-sm text-muted-foreground">
          {fromLogo.length > 0 ? "De tu logo" : "El de gestorIA, hasta que pongas el tuyo"}
        </span>
        {canEdit ? (
          <Button
            type="button"
            variant="link"
            className="ml-auto min-h-11 px-0"
            aria-expanded={other}
            onClick={() => setOther((open) => !open)}
          >
            Otro color
          </Button>
        ) : null}
      </div>
      {other ? otherField : null}
      <div aria-live="polite" className="flex flex-col gap-2">
        {palette.nearWhite ? (
          <Notice tone="warning" title="Casi blanco">
            No se distingue del fondo: los botones saldrán en un gris. Puedes usarlo igual.
          </Notice>
        ) : palette.lightened ? (
          <Notice tone="warning" title="Color claro">
            Los botones usarán un tono más oscuro para que se lean. Tú decides.
          </Notice>
        ) : (
          <Notice tone="success" title="Se lee bien">
            El texto blanco sobre este {name} se lee bien en botones y enlaces.
          </Notice>
        )}
        {palette.reddish ? (
          <Notice tone="warning" title="Parecido al rojo de los errores">
            Un botón tuyo podría confundirse con un aviso. Puedes usarlo igual.
          </Notice>
        ) : null}
      </div>
    </div>
  )
}

/** «Otro color»: la paleta del navegador o el código de la marca. */
/**
 * «Otro color»: la paleta del navegador o el código de la marca. Lo escrito a medias se queda
 * aquí; al campo llega solo un color válido, y al salir se dice si el código no vale.
 */
function OtherColor({ id, canEdit }: { id: string; canEdit: boolean }) {
  const field = useFieldContext<string>()
  const [text, setText] = useState(field.state.value.toUpperCase())
  const [wrong, setWrong] = useState(false)
  // Lo elegido con un toque o en la paleta se ve escrito.
  useEffect(() => {
    setText((current) =>
      normalizeBrandColor(current) === field.state.value
        ? current
        : field.state.value.toUpperCase(),
    )
  }, [field.state.value])
  return (
    <FormField
      label="Otro color"
      id={id}
      description={
        wrong
          ? CODE_PROBLEM
          : "Toca el cuadro para elegir en la paleta, o escribe el código de tu marca."
      }
    >
      {(control: FieldControl) => (
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="color"
            aria-label="Elegir en la paleta"
            value={field.state.value}
            disabled={!canEdit}
            onChange={(event) => field.handleChange(event.target.value.toLowerCase())}
            className="h-11 w-16 cursor-pointer rounded-lg border border-input-border bg-card p-0.5"
          />
          <Input
            {...control.props}
            aria-invalid={wrong || undefined}
            value={text}
            disabled={!canEdit}
            onChange={(event) => {
              setText(event.target.value)
              const valid = normalizeBrandColor(event.target.value)
              if (valid) {
                setWrong(false)
                field.handleChange(valid)
              }
            }}
            onBlur={() => {
              setWrong(normalizeBrandColor(text) === null)
              control.onBlur()
            }}
            autoComplete="off"
            spellCheck={false}
            className="w-36 uppercase"
          />
        </div>
      )}
    </FormField>
  )
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "success" | "warning"
  title: string
  children: ReactNode
}) {
  return (
    <p
      className={cn(
        "flex flex-wrap items-start gap-x-2 gap-y-1 rounded-lg p-3 text-sm",
        tone === "success" ? "bg-success-soft" : "bg-warning-soft",
      )}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5 font-semibold",
          tone === "success" ? "text-success" : "text-warning",
        )}
      >
        {tone === "success" ? (
          <CircleCheck aria-hidden className="size-4" />
        ) : (
          <Info aria-hidden className="size-4" />
        )}
        {title}
      </span>
      <span className="text-foreground">{children}</span>
    </p>
  )
}

function CoverField({
  url,
  canEdit,
  pickers,
  onPicked,
  onRemove,
  error,
}: {
  url: string | null
  canEdit: boolean
  pickers: Pickers
  onPicked: (file: File) => void
  onRemove: () => void
  error?: unknown
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const choose = (file: File) => {
    const bad = pickProblem(file, "portada")
    setProblem(bad)
    if (bad) return
    onPicked(file)
  }
  pickers.current.portada = choose
  const { over, handlers } = useDrop(choose, canEdit)
  const serverError = typeof error === "string" ? error : null
  return (
    <div className="flex flex-col gap-2">
      <input
        ref={input}
        type="file"
        accept={COVER_TYPES.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) choose(file)
          event.target.value = ""
        }}
      />
      <div
        {...handlers}
        className={cn(
          "flex flex-col items-stretch gap-3 rounded-xl border-2 border-dashed p-3 sm:flex-row sm:items-center",
          over ? "border-primary bg-primary-soft" : "border-border bg-muted/40",
        )}
      >
        <span className="flex aspect-[16/7] w-full shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted sm:w-56">
          {url ? (
            <img src={url} alt="Tu portada" className="size-full object-cover" />
          ) : (
            <ImagePlus aria-hidden className="size-6 text-muted-foreground" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="text-sm font-semibold">
            {over
              ? "Suéltala aquí"
              : url
                ? "Tu vitrina o tus productos"
                : "Suelta una foto horizontal"}
          </p>
          <p id={`${id}-ayuda`} className="text-xs text-muted-foreground">
            JPG, PNG o WebP.{" "}
            {url ? "Suelta otra aquí para cambiarla." : "Tu vitrina o tus productos."}
          </p>
          {canEdit ? (
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                variant={url ? "outline" : "secondary"}
                className="min-h-11"
                aria-describedby={`${id}-ayuda`}
                onClick={() => input.current?.click()}
              >
                {url ? "Cambiar" : "Elegir foto"}
              </Button>
              {url ? (
                <Button type="button" variant="ghost" className="min-h-11" onClick={onRemove}>
                  Quitar
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {problem || serverError ? (
        <p role="alert" className="text-sm text-danger">
          {problem ?? serverError}
        </p>
      ) : null}
    </div>
  )
}

/** Espera a que se deje de escribir antes de preguntar. */
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

function LinkField({
  store,
  id,
  saved,
  placeholder,
  canEdit,
}: {
  store: MyStore
  id: string
  saved: string | null
  placeholder: string
  canEdit: boolean
}) {
  const field = useFieldContext<string>()
  const name = useSettled(linkFromText(field.state.value))
  const check = useQuery({
    queryKey: ["marca-link", store.id, name],
    queryFn: () =>
      api<{ check: LinkCheck }>(
        `/api/tiendas/${store.id}/marca/link?nombre=${encodeURIComponent(name)}`,
      ),
    enabled: canEdit && name.length > 0 && name !== saved,
    staleTime: 30_000,
  })
  const result = name === saved ? null : check.data?.check
  return (
    <FormField label="Tu link" id={id}>
      {(control: FieldControl) => (
        <div className="flex flex-col gap-2">
          <div className="flex min-w-0 items-stretch overflow-hidden rounded-lg border border-input-border bg-card focus-within:ring-3 focus-within:ring-ring/30">
            <Input
              {...control.props}
              value={field.state.value}
              placeholder={placeholder}
              maxLength={63}
              disabled={!canEdit}
              autoComplete="off"
              spellCheck={false}
              // Se escribe como se guarda: sin tildes, mayúsculas ni espacios.
              onChange={(event) => field.handleChange(linkFromText(event.target.value, true))}
              onBlur={() => {
                field.handleChange(linkFromText(field.state.value))
                control.onBlur()
              }}
              className="min-w-0 flex-1 rounded-none border-0 shadow-none focus-visible:ring-0"
            />
            <span className="flex shrink-0 items-center border-l bg-muted px-3 text-sm text-muted-foreground">
              {LINK_DOMAIN}
            </span>
          </div>
          <div aria-live="polite" className="text-sm">
            {!result ? (
              <span className="text-muted-foreground">
                {saved
                  ? "Sin tildes ni espacios. Si lo cambias, el de antes sigue siendo tuyo."
                  : "Sin tildes ni espacios: el nombre de tu tienda, como se escribe en internet."}
              </span>
            ) : result.state === "libre" ? (
              <span className="inline-flex items-center gap-1.5 text-success">
                <CircleCheck aria-hidden className="size-4" />
                Está libre.{saved ? " Si lo cambias, el de antes sigue siendo tuyo." : ""}
              </span>
            ) : result.state === "tuyo" ? (
              <span className="inline-flex items-center gap-1.5 text-success">
                <CircleCheck aria-hidden className="size-4" />
                Es un link tuyo de antes: vuelve a ser el de ahora.
              </span>
            ) : result.state === "vigente" ? null : result.state === "no-vale" ? (
              <span className="text-danger">{result.message}</span>
            ) : (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-danger">
                {result.message}
                {result.suggestion ? (
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto min-h-11 px-0 sm:min-h-0"
                    onClick={() => field.handleChange(result.suggestion ?? "")}
                  >
                    Usar «{result.suggestion}»
                  </Button>
                ) : null}
              </span>
            )}
          </div>
        </div>
      )}
    </FormField>
  )
}

type PreviewView = "catalogo" | "carrito" | "link"

/**
 * «Así lo ve tu clienta»: el catálogo, el carrito y la vista previa del link, con lo elegido aún
 * sin guardar. Los productos son los primeros del catálogo de la tienda.
 */
function ClientPreview({
  store,
  palette,
  name,
  logo,
  cover,
  link,
}: {
  store: MyStore
  palette: BrandPalette
  name: string
  logo: string | null
  cover: string | null
  link: string
}) {
  const [view, setView] = useState<PreviewView>("catalogo")
  const seesCatalog = store.permissions.includes("catalogo.ver")
  const catalog = useQuery({
    queryKey: ["catalogo", store.id],
    queryFn: () => api<{ products: CatalogItem[] }>(`/api/tiendas/${store.id}/catalogo`),
    enabled: seesCatalog,
  })
  const products = (catalog.data?.products ?? []).slice(0, 3)
  const { light } = palette
  const mark = (size: string) =>
    logo ? (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-white bg-white",
          size,
        )}
      >
        <img src={logo} alt="" className="size-full object-contain p-0.5" />
      </span>
    ) : (
      <span
        aria-hidden
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full border-2 border-white font-serif font-bold",
          size,
        )}
        style={{ backgroundColor: light.fill, color: light.fillForeground }}
      >
        {initialsOf(name)}
      </span>
    )
  const first = products[0]
  const price = (item: CatalogItem) => money(item.fromCents, store.currency)
  const domain = `${link}${LINK_DOMAIN}`
  return (
    <div className="flex flex-col gap-3">
      <ViewTabs
        label="Qué ver"
        value={view}
        onValueChange={setView}
        options={[
          { value: "catalogo", label: "Catálogo" },
          { value: "carrito", label: "Carrito" },
          { value: "link", label: "Link en WhatsApp" },
        ]}
      />
      <div className="theme-light mx-auto w-full max-w-[19rem] overflow-hidden rounded-[2rem] border-[7px] border-neutral-900 bg-white text-neutral-900 shadow-xl">
        {view === "catalogo" ? (
          <div className="flex min-h-[27rem] flex-col">
            <div className="relative h-28 shrink-0" style={{ backgroundColor: light.soft }}>
              {cover ? <img src={cover} alt="" className="size-full object-cover" /> : null}
            </div>
            <div className="relative z-10 -mt-7 flex flex-col gap-1 px-4">
              {mark("size-14 text-lg")}
              <p
                className="mt-1 truncate font-serif text-lg font-bold"
                style={{ color: light.primary }}
              >
                {name}
              </p>
              <p className="text-xs text-neutral-500">Pide por WhatsApp · {domain}</p>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-4">
              {(products.length > 0 ? products : [null, null]).map((item, index) => (
                <div
                  key={item?.id ?? `ejemplo-${index}`}
                  className="flex items-center gap-3 rounded-xl border border-neutral-200 p-2"
                >
                  {item ? (
                    <Photo storeId={store.id} photoId={item.photoId} alt="" className="size-11" />
                  ) : (
                    <span className="flex size-11 items-center justify-center rounded-lg bg-neutral-100">
                      <ShoppingBag aria-hidden className="size-4 text-neutral-400" />
                    </span>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold">
                      {item?.name ?? "Tu producto"}
                    </span>
                    <span className="truncate text-xs text-neutral-500">
                      {item?.options[0]
                        ? `${item.options[0].name}: ${item.options[0].values.slice(0, 3).join(", ")}`
                        : "Con su foto y su precio"}
                    </span>
                  </div>
                  <span className="text-sm font-semibold">{item ? price(item) : "—"}</span>
                </div>
              ))}
              <span
                className="mt-auto rounded-full py-2.5 text-center text-sm font-semibold"
                style={{ backgroundColor: light.fill, color: light.fillForeground }}
              >
                Lo quiero
              </span>
            </div>
          </div>
        ) : view === "carrito" ? (
          <div className="flex min-h-[27rem] flex-col">
            <div className="flex items-center gap-2 border-b border-neutral-200 p-3">
              {mark("size-9 text-xs")}
              <span className="truncate text-sm font-semibold">{name}</span>
            </div>
            <div className="flex flex-1 flex-col gap-3 p-4">
              <p className="text-sm font-semibold">Tu pedido</p>
              {first ? (
                <div className="flex items-center gap-3">
                  <Photo storeId={store.id} photoId={first.photoId} alt="" className="size-12" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{first.name}</span>
                    <span className="text-xs text-neutral-500">1 unidad</span>
                  </div>
                  <span className="text-sm font-semibold">{price(first)}</span>
                </div>
              ) : (
                <p className="text-sm text-neutral-500">Tu producto, con su foto y su precio.</p>
              )}
              <p className="text-xs">
                <span className="font-semibold underline" style={{ color: light.primary }}>
                  Agregar otro producto
                </span>
              </p>
              <div className="mt-auto flex items-center justify-between border-t border-neutral-200 pt-3 text-sm">
                <span>Total</span>
                <span className="font-bold">{first ? price(first) : "—"}</span>
              </div>
              <span
                className="rounded-full py-2.5 text-center text-sm font-semibold"
                style={{ backgroundColor: light.fill, color: light.fillForeground }}
              >
                Pedir por WhatsApp
              </span>
            </div>
          </div>
        ) : (
          <div className="flex min-h-[27rem] flex-col justify-end gap-2 bg-[#efe7dd] p-3">
            <div className="ml-auto w-[88%] overflow-hidden rounded-xl rounded-tr-sm bg-[#d9fdd3] p-1 shadow-sm">
              <div className="overflow-hidden rounded-lg bg-white/70">
                <div className="h-28" style={{ backgroundColor: light.soft }}>
                  {cover ? <img src={cover} alt="" className="size-full object-cover" /> : null}
                </div>
                <div className="flex flex-col gap-0.5 p-2">
                  <span className="text-xs font-semibold">
                    {name}
                    {first ? ` · ${first.name} ${price(first)}` : ""}
                  </span>
                  <span className="text-[11px] text-neutral-500">{domain}</span>
                </div>
              </div>
              <p className="break-all px-1.5 py-1 text-xs text-sky-700 underline">
                https://{domain}
              </p>
            </div>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Es una vista previa: tu catálogo con link aún no está publicado. Lo que no cambia por
        tienda: el orden, la letra y los colores de «agotado» y de error, para que se lea siempre
        bien.
      </p>
    </div>
  )
}
