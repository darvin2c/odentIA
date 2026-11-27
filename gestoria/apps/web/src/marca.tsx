import {
  Button,
  cn,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  toast,
} from "@odentia/ui"
import {
  type BrandPalette,
  brandColorName,
  brandPalette,
  dominantColors,
  normalizeBrandColor,
} from "@odentia/ui/lib/brand-color"
import { ConfirmDialog, LoadingState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Camera, Check, ImagePlus, TriangleAlert } from "lucide-react"
import {
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"
import { api, type MyStore } from "./lib/api"
import { type BrandView, GESTORIA_COLOR, LINK_DOMAIN, linkFromText } from "./lib/marca"
import { FormAlert, fieldErrors, shrinkPhoto } from "./piezas"
import { ErrorBlock, StoreHeader, useStoreContext } from "./tiendas"

/**
 * Configuración › Tu marca (lienzo «gestorIA como odentIA», tablero 10): el kit básico de la
 * tienda. El logo, el nombre que ve el cliente, la foto de portada, el nombre del link y el color
 * de marca. Lo usan la app del equipo (el color, como en las clínicas) y, más adelante, el catálogo.
 *
 * - El logo y la portada se suben al elegirlos (se miran por su contenido en el servidor).
 * - El nombre, el link y el color se guardan juntos con «Guardar». Elegir un color solo cambia la
 *   vista previa hasta guardar.
 * - Cualquier color vale (ADR 0162): los tonos para que se lea se calculan solos; lo que el sistema
 *   ajusta o se parece al rojo de los errores se dice, sin frenar.
 * - Se sugieren los colores del logo y de una foto del letrero, que se lee en el navegador y no
 *   se guarda.
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
        <ErrorBlock error={brand.error} onRetry={() => void brand.refetch()} />
      ) : (
        <BrandEditor
          // Lo guardado manda cuando cambia: el formulario vuelve a empezar desde ahí.
          key={`${brand.data.brand.publicName}|${brand.data.brand.link}|${brand.data.brand.brandColor}`}
          store={store}
          brand={brand.data.brand}
        />
      )}
    </>
  )
}

/** El logo o la portada como URL del navegador, pedidos con la sesión (no son públicos). */
function useBrandImage(storeId: string, kind: "logo" | "portada", version: number | null) {
  const blob = useQuery({
    queryKey: ["marca-imagen", storeId, kind, version],
    queryFn: () => api<Blob>(`/api/tiendas/${storeId}/marca/${kind}?v=${version}`, { as: "blob" }),
    enabled: version !== null,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob.data || version === null) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(blob.data)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob.data, version])
  return { url, blob: version === null ? null : (blob.data ?? null) }
}

/** Lado mayor de lo que se lee de una imagen para sacar sus colores: basta y no pesa. */
const READ_SIDE = 320

async function pixelsOf(source: Blob): Promise<{ pixels: ImageData; url: string }> {
  const bitmap = await createImageBitmap(source)
  const scale = Math.min(1, READ_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext("2d")
  if (!context) throw new Error("El navegador no deja leer la imagen")
  // Lo transparente (un logo sin fondo) se lee sobre blanco, como el papel.
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return {
    pixels: context.getImageData(0, 0, canvas.width, canvas.height),
    url: canvas.toDataURL("image/jpeg", 0.85),
  }
}

/** El color donde se tocó la foto: el promedio de un cuadrito, para que un píxel suelto no mande. */
function colorAt(pixels: ImageData, x: number, y: number): string {
  const total = [0, 0, 0]
  let count = 0
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const px = Math.min(pixels.width - 1, Math.max(0, Math.round(x) + dx))
      const py = Math.min(pixels.height - 1, Math.max(0, Math.round(y) + dy))
      const at = (py * pixels.width + px) * 4
      for (let channel = 0; channel < 3; channel++)
        total[channel] = (total[channel] ?? 0) + (pixels.data[at + channel] ?? 0)
      count++
    }
  return `#${total
    .map((sum) =>
      Math.round(sum / count)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}

/** Los colores del logo, leídos en el navegador con la misma cuenta que los de una foto. */
function useLogoColors(logo: Blob | null): string[] {
  const [colors, setColors] = useState<string[]>([])
  useEffect(() => {
    let live = true
    if (!logo) {
      setColors([])
      return
    }
    pixelsOf(logo)
      .then(({ pixels }) => {
        if (live) setColors(dominantColors(pixels.data, 4, 3))
      })
      .catch(() => {
        if (live) setColors([])
      })
    return () => {
      live = false
    }
  }, [logo])
  return colors
}

interface SignPhoto {
  url: string
  pixels: ImageData
  colors: string[]
  picked: string | null
}

function BrandEditor({ store, brand }: { store: MyStore; brand: BrandView }) {
  const canEdit = store.permissions.includes("configuracion")
  const queryClient = useQueryClient()
  const id = useId()
  const saved = brand.brandColor ?? GESTORIA_COLOR
  const [publicName, setPublicName] = useState(brand.publicName ?? "")
  const [link, setLink] = useState(brand.link ?? "")
  const [chosen, setChosen] = useState(saved)
  const [code, setCode] = useState(saved.toUpperCase())
  const [codeError, setCodeError] = useState<string | null>(null)
  const [photo, setPhoto] = useState<SignPhoto | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const logo = useBrandImage(store.id, "logo", brand.logo?.version ?? null)
  const cover = useBrandImage(store.id, "portada", brand.cover?.version ?? null)
  const fromLogo = useLogoColors(logo.blob)
  const palette = brandPalette(chosen)
  const shownName = publicName.trim() || brand.storeName

  const dirty =
    publicName.trim() !== (brand.publicName ?? "") ||
    linkFromText(link) !== (brand.link ?? "") ||
    chosen !== saved

  const save = useMutation({
    mutationFn: () =>
      api<{ brand: BrandView }>(`/api/tiendas/${store.id}/marca`, {
        method: "PUT",
        body: {
          publicName: publicName.trim(),
          // El de gestorIA no se guarda: queda sin color propio.
          brandColor: chosen === GESTORIA_COLOR ? "" : chosen,
          link: linkFromText(link) || null,
        },
      }),
    onSuccess: async ({ brand: next }) => {
      queryClient.setQueryData(BRAND_KEY(store.id), { brand: next })
      // El color pinta la app de todo el equipo: llega con la tienda.
      await queryClient.invalidateQueries({ queryKey: ["yo"] })
      toast.success("Tu marca quedó guardada")
    },
  })
  const errors = fieldErrors(save.error)

  const pick = (hex: string) => {
    setChosen(hex)
    setCode(hex.toUpperCase())
    setCodeError(null)
  }
  const onCode = (value: string) => {
    setCode(value)
    const valid = normalizeBrandColor(value)
    if (valid) {
      setChosen(valid)
      setCodeError(null)
    }
  }
  const onPhoto = async (file: File | undefined) => {
    if (!file) return
    setPhotoError(null)
    try {
      const { pixels, url } = await pixelsOf(file)
      setPhoto({ url, pixels, colors: dominantColors(pixels.data, 4, 4), picked: null })
    } catch {
      setPhotoError("No pudimos leer esa foto. Prueba con otra, en JPG o PNG.")
    }
  }
  const pickInPhoto = (event: MouseEvent<HTMLImageElement>) => {
    if (!photo) return
    const box = event.currentTarget.getBoundingClientRect()
    const hex = colorAt(
      photo.pixels,
      ((event.clientX - box.left) / box.width) * photo.pixels.width,
      ((event.clientY - box.top) / box.height) * photo.pixels.height,
    )
    setPhoto({ ...photo, picked: hex })
    pick(hex)
  }
  const photoColors = photo
    ? [...new Set([photo.picked, ...photo.colors].filter((hex): hex is string => !!hex))]
    : []

  const reset = () => {
    setPublicName(brand.publicName ?? "")
    setLink(brand.link ?? "")
    pick(saved)
    save.reset()
  }
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!normalizeBrandColor(code)) {
      setCodeError("El código del color tiene 6 cifras, como #BE185D.")
      document.getElementById(`${id}-codigo`)?.focus()
      return
    }
    save.mutate()
  }

  const swatch = (hex: string, name: string) => {
    const selected = chosen === hex
    return (
      <button
        key={`${name}-${hex}`}
        type="button"
        aria-pressed={selected}
        disabled={!canEdit}
        onClick={() => pick(hex)}
        className={cn(
          "flex min-h-11 items-center gap-2.5 rounded-xl bg-card pr-3.5 pl-1.5 transition-shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-60",
          selected
            ? "border-2 border-foreground"
            : "border border-input hover:border-foreground/40",
        )}
      >
        <span
          aria-hidden
          className="flex size-8 items-center justify-center rounded-lg border border-foreground/10"
          style={{ backgroundColor: hex, color: brandPalette(hex).light.fillForeground }}
        >
          {selected ? <Check className="size-4" strokeWidth={3} /> : null}
        </span>
        <span className="text-sm font-medium">{name}</span>
      </button>
    )
  }

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      aria-label="Tu marca"
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]"
    >
      <div className="elevated flex min-w-0 flex-col gap-6 rounded-xl border bg-card p-5">
        <FieldGroup className="gap-6">
          <BrandImageField
            store={store}
            kind="logo"
            label="Logo"
            url={logo.url}
            canEdit={canEdit}
            empty={<Initials name={shownName} color={palette.light} />}
            help="Va en tu gestorIA y, más adelante, en tu catálogo. De él te sugerimos colores."
          />
          <Field data-invalid={errors.publicName ? true : undefined}>
            <FieldLabel htmlFor={`${id}-nombre`}>Nombre que ve el cliente</FieldLabel>
            <Input
              id={`${id}-nombre`}
              value={publicName}
              placeholder={brand.storeName}
              maxLength={80}
              disabled={!canEdit}
              onChange={(event) => setPublicName(event.target.value)}
              aria-invalid={errors.publicName ? true : undefined}
              aria-describedby={`${id}-nombre-ayuda`}
            />
            {errors.publicName ? (
              <FieldError id={`${id}-nombre-ayuda`}>{errors.publicName}</FieldError>
            ) : (
              <FieldDescription id={`${id}-nombre-ayuda`}>
                Si lo dejas vacío, es el de la tienda: {brand.storeName}.
              </FieldDescription>
            )}
          </Field>
          <Field data-invalid={errors.link ? true : undefined}>
            <FieldLabel htmlFor={`${id}-link`}>Nombre del link</FieldLabel>
            <div className="flex min-w-0 items-center gap-2">
              <Input
                id={`${id}-link`}
                value={link}
                placeholder={linkFromText(brand.storeName)}
                maxLength={63}
                disabled={!canEdit}
                autoComplete="off"
                spellCheck={false}
                // Se escribe como se guarda: sin tildes, mayúsculas ni espacios.
                onChange={(event) => setLink(linkFromText(event.target.value, true))}
                onBlur={() => setLink(linkFromText(link))}
                aria-invalid={errors.link ? true : undefined}
                aria-describedby={`${id}-link-ayuda`}
                className="min-w-0 flex-1"
              />
              <span className="shrink-0 text-sm text-muted-foreground">{LINK_DOMAIN}</span>
            </div>
            {errors.link ? (
              <FieldError id={`${id}-link-ayuda`}>{errors.link}</FieldError>
            ) : (
              <FieldDescription id={`${id}-link-ayuda`}>
                La dirección de tu catálogo, que llega más adelante. Sin tildes ni espacios; algunos
                nombres están reservados (app, api, admin, acceso, pago…). Si lo cambias, el de
                antes sigue siendo tuyo.
              </FieldDescription>
            )}
          </Field>
          <BrandImageField
            store={store}
            kind="portada"
            label="Foto de portada"
            url={cover.url}
            canEdit={canEdit}
            wide
            empty={
              <span className="px-3 text-center text-xs text-muted-foreground">
                Tu vitrina o tus productos
              </span>
            }
            help="Va arriba en tu catálogo, más adelante: la vitrina o tus productos."
          />

          <FieldSet>
            <FieldLegend>Color de marca</FieldLegend>
            <FieldDescription>
              Lo ve todo tu equipo en gestorIA. Cualquier color vale: los tonos para que se lea bien
              se calculan solos.
            </FieldDescription>
            <FieldGroup className="gap-4">
              {fromLogo.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-semibold">Del logo</p>
                  <div className="flex flex-wrap gap-2">
                    {fromLogo.map((hex) => swatch(hex, brandColorName(hex)))}
                  </div>
                </div>
              ) : null}
              <div className="flex flex-col gap-2">
                <p className="text-sm font-semibold">De gestorIA</p>
                <div className="flex flex-wrap gap-2">
                  {swatch(GESTORIA_COLOR, "Naranja, el de gestorIA")}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-semibold">De una foto del letrero</p>
                {photo ? (
                  <>
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: tocar la foto es un atajo; con teclado se eligen los colores sacados de ella, aquí debajo. */}
                    <img
                      src={photo.url}
                      alt="Tu foto. Tócala donde está el color de tu letrero."
                      onClick={canEdit ? pickInPhoto : undefined}
                      className="max-h-48 max-w-full cursor-crosshair self-start rounded-lg border"
                    />
                    <div className="flex flex-wrap gap-2">
                      {photoColors.map((hex) =>
                        swatch(
                          hex,
                          hex === photo.picked
                            ? `${brandColorName(hex)}, donde tocaste`
                            : brandColorName(hex),
                        ),
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {photoColors.length > 0
                        ? "Elige uno, o toca en la foto el color de tu letrero. La foto no se guarda."
                        : "No encontramos un color en la foto: tócala donde está tu color, o prueba con otra más de cerca. La foto no se guarda."}
                    </p>
                  </>
                ) : null}
                {canEdit ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 self-start"
                    onClick={() => photoInput.current?.click()}
                  >
                    <Camera aria-hidden />
                    {photo ? "Otra foto" : "Subir foto"}
                  </Button>
                ) : null}
                <input
                  ref={photoInput}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => {
                    void onPhoto(event.target.files?.[0])
                    event.target.value = ""
                  }}
                />
                {photoError ? (
                  <p role="alert" className="text-sm text-danger">
                    {photoError}
                  </p>
                ) : null}
              </div>
              <Field data-invalid={codeError ? true : undefined}>
                <FieldLabel htmlFor={`${id}-codigo`}>Otro color</FieldLabel>
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="color"
                    aria-label="Elegir en la paleta"
                    value={chosen}
                    disabled={!canEdit}
                    onChange={(event) => pick(event.target.value.toLowerCase())}
                    className="h-11 w-16 cursor-pointer rounded-lg border border-input-border bg-card p-0.5"
                  />
                  <Input
                    id={`${id}-codigo`}
                    value={code}
                    disabled={!canEdit}
                    onChange={(event) => onCode(event.target.value)}
                    onBlur={() =>
                      setCodeError(
                        normalizeBrandColor(code)
                          ? null
                          : "El código del color tiene 6 cifras, como #BE185D.",
                      )
                    }
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={codeError ? true : undefined}
                    aria-describedby={`${id}-codigo-ayuda`}
                    className="w-36 uppercase"
                  />
                </div>
                {codeError || errors.brandColor ? (
                  <FieldError id={`${id}-codigo-ayuda`}>
                    {codeError ?? errors.brandColor}
                  </FieldError>
                ) : (
                  <FieldDescription id={`${id}-codigo-ayuda`}>
                    Toca el color para elegir en la paleta, o escribe el código de tu marca.
                  </FieldDescription>
                )}
              </Field>
              <ColorNotices palette={palette} chosen={chosen} />
            </FieldGroup>
          </FieldSet>
        </FieldGroup>
        {canEdit ? (
          <div className="flex flex-col gap-2">
            <FormAlert error={save.error} />
            <div className="flex flex-wrap items-center gap-3">
              <SubmitButton type="submit" pending={save.isPending}>
                Guardar
              </SubmitButton>
              {dirty ? (
                <Button type="button" variant="ghost" onClick={reset} disabled={save.isPending}>
                  Cancelar
                </Button>
              ) : null}
              {dirty && !save.isPending ? (
                <span className="text-sm font-medium text-warning">Aún no se guarda</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      <Preview palette={palette} name={shownName} logo={logo.url} cover={cover.url} />
    </form>
  )
}

/** Sin logo, sus iniciales en el color: como el cuadro del selector de tiendas. */
function Initials({ name, color }: { name: string; color: BrandPalette["light"] }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word.charAt(0).toUpperCase())
      .join("") || "?"
  return (
    <span
      aria-hidden
      className="flex size-full items-center justify-center text-sm font-bold"
      style={{ backgroundColor: color.fill, color: color.fillForeground }}
    >
      {initials}
    </span>
  )
}

/** El logo o la portada: lo que hay, y «Cambiar»/«Quitar»; se sube al elegirla. */
function BrandImageField({
  store,
  kind,
  label,
  url,
  canEdit,
  empty,
  help,
  wide = false,
}: {
  store: MyStore
  kind: "logo" | "portada"
  label: string
  url: string | null
  canEdit: boolean
  empty: ReactNode
  help: string
  wide?: boolean
}) {
  const id = useId()
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [removing, setRemoving] = useState(false)
  const done = (next: BrandView) => queryClient.setQueryData(BRAND_KEY(store.id), { brand: next })
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const blob = await shrinkPhoto(file)
      return api<{ brand: BrandView }>(`/api/tiendas/${store.id}/marca/${kind}`, {
        method: "POST",
        raw: { type: blob.type, data: blob },
      })
    },
    onSuccess: ({ brand }) => {
      done(brand)
      toast.success(kind === "logo" ? "Logo guardado" : "Foto de portada guardada")
    },
  })
  const remove = useMutation({
    mutationFn: () =>
      api<{ brand: BrandView }>(`/api/tiendas/${store.id}/marca/${kind}`, { method: "DELETE" }),
    onSuccess: ({ brand }) => {
      setRemoving(false)
      done(brand)
      toast.success(kind === "logo" ? "Logo quitado" : "Foto de portada quitada")
    },
  })
  const busy = upload.isPending || remove.isPending
  return (
    <Field data-invalid={upload.isError ? true : undefined}>
      <FieldLabel htmlFor={`${id}-subir`}>{label}</FieldLabel>
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={cn(
            "flex shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted",
            wide ? "h-20 w-36" : "size-16",
          )}
        >
          {url ? (
            <img
              src={url}
              alt={kind === "logo" ? "Tu logo" : "Tu foto de portada"}
              className={cn("size-full", kind === "logo" ? "object-contain" : "object-cover")}
            />
          ) : (
            empty
          )}
        </span>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button
              id={`${id}-subir`}
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => input.current?.click()}
              aria-describedby={`${id}-ayuda`}
            >
              <ImagePlus aria-hidden />
              {upload.isPending
                ? "Subiendo…"
                : url
                  ? kind === "logo"
                    ? "Cambiar logo"
                    : "Cambiar foto"
                  : kind === "logo"
                    ? "Subir logo"
                    : "Subir foto de portada"}
            </Button>
            {url ? (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setRemoving(true)}
              >
                Quitar
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) upload.mutate(file)
          event.target.value = ""
        }}
      />
      {upload.isError ? (
        <FieldError id={`${id}-ayuda`}>{upload.error.message}</FieldError>
      ) : (
        <FieldDescription id={`${id}-ayuda`}>{help}</FieldDescription>
      )}
      <ConfirmDialog
        open={removing}
        title={kind === "logo" ? "¿Quitar el logo?" : "¿Quitar la foto de portada?"}
        description="Puedes subir otra cuando quieras."
        confirmLabel="Quitar"
        cancelLabel="Dejarla"
        onConfirm={() => remove.mutate()}
        onClose={() => setRemoving(false)}
      />
    </Field>
  )
}

/** Lo que el sistema ajusta o nota del color elegido: informa, no frena. */
function ColorNotices({ palette, chosen }: { palette: BrandPalette; chosen: string }) {
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      {palette.lightened ? (
        <p className="rounded-xl bg-muted p-3 text-sm">
          {palette.light.fill === chosen
            ? "Tu color es claro: los botones lo llevan tal cual y los textos, un tono más oscuro para que se lean."
            : "Para que se lea, los botones y los textos llevan un tono más oscuro. Tu logo no cambia."}
        </p>
      ) : null}
      {palette.nearWhite ? (
        <p className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-sm text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          Es casi blanco y no se distingue del fondo: los botones saldrán en un gris. Puedes usarlo
          igual.
        </p>
      ) : null}
      {palette.reddish ? (
        <p className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-sm text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          Se parece al rojo de los errores: un botón tuyo podría confundirse con un aviso. Puedes
          usarlo igual.
        </p>
      ) : null}
    </div>
  )
}

/** Así se ve: tu gestorIA y tu catálogo con lo elegido, aún sin guardar. */
function Preview({
  palette,
  name,
  logo,
  cover,
}: {
  palette: BrandPalette
  name: string
  logo: string | null
  cover: string | null
}) {
  const id = useId()
  const { light } = palette
  const mark = logo ? (
    <img src={logo} alt="" className="size-7 shrink-0 rounded-md object-contain" />
  ) : (
    <span className="size-7 shrink-0 overflow-hidden rounded-md">
      <Initials name={name} color={light} />
    </span>
  )
  return (
    <section aria-labelledby={`${id}-titulo`} className="flex flex-col gap-2 self-start">
      <h2 id={`${id}-titulo`} className="text-sm font-semibold">
        Así se ve
      </h2>
      <div className="theme-light overflow-hidden rounded-xl border bg-card text-card-foreground">
        <div className="border-b bg-muted px-3 py-1.5 text-xs font-semibold text-muted-foreground">
          Tu gestorIA
        </div>
        <div className="flex flex-col gap-1.5 p-3 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            {mark}
            <span className="truncate font-semibold">{name}</span>
          </div>
          <span
            className="rounded-md px-2 py-1.5 font-semibold"
            style={{ backgroundColor: light.soft, color: light.softForeground }}
          >
            Pedidos
          </span>
          <span className="px-2 py-1">Catálogo</span>
          <span
            className="self-start rounded-md px-2.5 py-1.5 font-semibold"
            style={{ backgroundColor: light.fill, color: light.fillForeground }}
          >
            Anotar un pedido
          </span>
        </div>
      </div>
      <div className="theme-light overflow-hidden rounded-xl border bg-card text-card-foreground">
        <div className="border-b bg-muted px-3 py-1.5 text-xs font-semibold text-muted-foreground">
          Tu catálogo, más adelante
        </div>
        <div className="flex flex-col text-xs">
          <span className="flex h-20 items-center justify-center overflow-hidden bg-muted">
            {cover ? (
              <img src={cover} alt="" className="size-full object-cover" />
            ) : (
              <span className="text-muted-foreground">Foto de portada</span>
            )}
          </span>
          <div className="flex flex-col gap-2 p-3">
            <div className="flex min-w-0 items-center gap-2">
              {mark}
              <span className="truncate font-semibold">{name}</span>
            </div>
            <span
              className="self-start rounded-full px-3 py-1.5 font-semibold"
              style={{ backgroundColor: light.fill, color: light.fillForeground }}
            >
              Pedir por WhatsApp
            </span>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Los colores de error, listo y aviso no cambian.
      </p>
    </section>
  )
}
