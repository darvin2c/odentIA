import {
  type BrandPalette,
  brandColorName,
  brandPalette,
  normalizeBrandColor,
  PRODUCT_BRAND_COLORS,
  suggestedBrandColors,
} from "@odentia/clinical"
import { Button, cn, toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { rootRouteId, useRouter } from "@tanstack/react-router"
import { Check, TriangleAlert } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { apiFetch } from "../../lib/api"
import { forgetClinicAppearance } from "../../lib/clinic-color"
import { productUi } from "../../product/product-ui"

/** Cómo se llama el color de fábrica de cada producto, para «Volver al …». */
const FACTORY_WORDS = {
  dental: { color: "turquesa", brand: "odentIA" },
  medical: { color: "morado", brand: "latidIA" },
} as const

/** Qué tiene mal un código escrito a mano, dicho en concreto; null si es un color. */
function codeProblem(text: string): string | null {
  if (normalizeBrandColor(text)) return null
  const body = text.trim().replace(/^#/, "")
  if (!body) return "Escribe el código de tu color, como #1D5FA8."
  if (/[^0-9a-f]/i.test(body)) return "El código lleva solo números y letras de la A a la F, como #1D5FA8."
  const gap = 6 - body.length
  const count = Math.abs(gap)
  const digits = count === 1 ? "1 cifra" : `${count} cifras`
  return `${gap > 0 ? (count === 1 ? "Le falta" : "Le faltan") : count === 1 ? "Le sobra" : "Le sobran"} ${digits}: el código tiene 6, como #1D5FA8.`
}

/**
 * El color de la marca (ADR 0162, lienzo «Color de la marca»): un solo color para toda
 * la clínica. Primero los colores de su logo, porque casi nadie sabe el código de su
 * color; luego los sugeridos, y «Elegir otro color» con la paleta y el código. Elegir
 * solo cambia la vista previa: se guarda con «Usar este color», aparte del «Guardar»
 * de los datos, porque cambia al instante lo que ven los pacientes. Cualquier color
 * vale; lo que el sistema ajusta para que se lea, o el parecido con el rojo de los
 * errores, se dice sin frenar.
 */
export function ClinicBrandColorSettings({
  brandColor,
  logo,
  clinicName,
  onDirtyChange,
}: {
  brandColor: string | null
  logo: string | null
  clinicName: string
  /** La página cuida un solo borrador: este bloque le dice si hay un color sin guardar. */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const id = useId()
  const queryClient = useQueryClient()
  const router = useRouter()
  const product = productUi().product === "medical" ? "medical" : "dental"
  const factory = PRODUCT_BRAND_COLORS[product]
  const saved = brandColor ?? factory
  const [chosen, setChosen] = useState(saved)
  const [otherOpen, setOtherOpen] = useState(false)
  const [code, setCode] = useState(saved.toUpperCase())
  const [codeError, setCodeError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Lo guardado manda cuando cambia (al guardar o desde otra pestaña).
  useEffect(() => {
    setChosen(saved)
    setCode(saved.toUpperCase())
  }, [saved])
  const dirty = chosen !== saved
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])

  const logoColors = useQuery({
    queryKey: ["org-logo-colors", logo],
    queryFn: () => apiFetch<{ data: { colors: string[] } }>("/api/org-profile/logo-colors").then((r) => r.data.colors),
    enabled: !!logo,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const fromLogo = (logo ? (logoColors.data ?? []) : []).map((hex) => ({ hex, name: brandColorName(hex) }))
  const suggested = suggestedBrandColors(product)
  const palette = brandPalette(chosen)
  // El nombre del color en uso: el de la lista, el del logo o uno aproximado; nunca solo el código.
  const savedName =
    saved === factory
      ? `${suggested[0]?.name ?? "Turquesa"}, el de ${FACTORY_WORDS[product].brand}`
      : (suggested.find((color) => color.hex === saved)?.name ??
        (fromLogo.some((color) => color.hex === saved) ? `${brandColorName(saved)} de tu logo` : brandColorName(saved)))

  const save = useMutation({
    mutationFn: (color: string) =>
      color === factory
        ? apiFetch<{ data: { brandColor: string | null } }>("/api/org-profile/brand-color", { method: "DELETE" })
        : apiFetch<{ data: { brandColor: string | null } }>("/api/org-profile/brand-color", {
            method: "PUT",
            body: JSON.stringify({ color }),
          }),
    onSuccess: async (_result, color) => {
      setError(null)
      await queryClient.invalidateQueries({ queryKey: ["org-profile"] })
      // Solo la raíz vuelve a pedir el color: la app cambia sin recargar ni volver a cargar la página.
      forgetClinicAppearance()
      await router.invalidate({ filter: (match) => match.routeId === rootRouteId })
      toast.success(color === factory ? `Volvió el ${FACTORY_WORDS[product].color} de ${FACTORY_WORDS[product].brand}` : "Color guardado. Tus pacientes ya lo ven.")
    },
    onError: (cause) => setError(submitErrorMessage(cause)),
  })

  const pick = (hex: string) => {
    setChosen(hex)
    setCode(hex.toUpperCase())
    setCodeError(null)
    setError(null)
  }
  const onCode = (value: string) => {
    setCode(value)
    const valid = normalizeBrandColor(value)
    if (valid) {
      setChosen(valid)
      setCodeError(null)
    }
  }
  const submit = () => {
    const problem = otherOpen ? codeProblem(code) : null
    if (problem) {
      setCodeError(problem)
      document.getElementById(`${id}-code`)?.focus()
      return
    }
    save.mutate(chosen)
  }

  const swatch = (hex: string, name: string, wide: boolean) => {
    const selected = chosen === hex
    // La marca de elegido va en tinta sobre un color claro, en blanco sobre uno oscuro.
    const mark = brandPalette(hex).light.fillForeground
    return (
      <button
        key={`${name}-${hex}`}
        type="button"
        aria-pressed={selected}
        aria-label={name}
        title={wide ? undefined : name}
        // Mientras guarda no se elige otro: lo elegido en la espera se perdería al llegar lo guardado.
        disabled={save.isPending}
        onClick={() => pick(hex)}
        className={cn(
          "flex min-h-11 items-center gap-2.5 rounded-xl bg-card transition-shadow disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground",
          wide ? "pr-3.5 pl-1.5" : "size-11 justify-center p-1",
          selected ? "border-2 border-foreground" : "border border-input hover:border-foreground/40",
        )}
      >
        <span
          aria-hidden
          className={cn("flex items-center justify-center rounded-lg border border-foreground/10", wide ? "size-8" : "size-full")}
          style={{ backgroundColor: hex, color: mark }}
        >
          {selected ? <Check className="size-4" strokeWidth={3} /> : null}
        </span>
        {wide ? <span className="text-sm font-medium">{name}</span> : null}
      </button>
    )
  }

  return (
    <section aria-labelledby={`${id}-title`} className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="font-heading text-base font-medium">
          Color de la marca
        </h2>
        <p className="text-sm text-muted-foreground">
          Lo verán tu equipo en la app y tus pacientes en la página de sus citas, la reserva y el chat de tu web. En tus
          documentos va en la línea bajo el logo o, si no hay logo, en el cuadro de sus iniciales. Se guarda aparte, con
          «Usar este color».
        </p>
      </div>

      <p className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
        <span className="text-muted-foreground">Tus pacientes ven:</span>
        <span aria-hidden className="size-5 rounded-md border border-foreground/10" style={{ backgroundColor: saved }} />
        <span className="font-medium">{savedName}</span>
        <span className="text-muted-foreground">{saved.toUpperCase()}</span>
      </p>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="order-1 flex flex-col gap-4 sm:col-start-1 sm:row-start-1">
          {fromLogo.length > 0 ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-semibold">De tu logo</legend>
              <div className="flex flex-wrap gap-2">{fromLogo.map((color) => swatch(color.hex, color.name, true))}</div>
            </fieldset>
          ) : null}

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-semibold">{fromLogo.length > 0 ? "Otros colores" : "Colores"}</legend>
            <div className="grid grid-cols-6 gap-1.5 sm:flex sm:flex-wrap">
              {suggested.map((color) => swatch(color.hex, color.factory ? `${color.name}, el de ${FACTORY_WORDS[product].brand}` : color.name, false))}
            </div>
            <p className="text-sm text-muted-foreground">
              {logo ? null : "Sube tu logo en «Logo», aquí arriba, y te sugerimos sus colores. "}
              El primero es el {FACTORY_WORDS[product].color} con el que viene {FACTORY_WORDS[product].brand}.
            </p>
          </fieldset>

          {otherOpen ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-semibold">Otro color</legend>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-palette`} className="text-sm font-medium">
                    En la paleta
                  </label>
                  <input
                    id={`${id}-palette`}
                    type="color"
                    value={chosen}
                    onChange={(event) => pick(event.target.value.toLowerCase())}
                    disabled={save.isPending}
                    className="h-11 w-16 cursor-pointer rounded-lg border border-input bg-card p-0.5"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-code`} className="text-sm font-medium">
                    Código, si lo tienes
                  </label>
                  <input
                    id={`${id}-code`}
                    value={code}
                    onChange={(event) => onCode(event.target.value)}
                    disabled={save.isPending}
                    // Al salir del campo con un código que no es un color, se dice ahí mismo.
                    onBlur={() => setCodeError(codeProblem(code))}
                    aria-invalid={codeError ? true : undefined}
                    aria-describedby={`${id}-code-help`}
                    autoComplete="off"
                    spellCheck={false}
                    className={cn(
                      "h-11 w-36 rounded-lg border bg-card px-3 text-base uppercase",
                      codeError ? "border-destructive" : "border-input",
                    )}
                  />
                </div>
              </div>
              <p id={`${id}-code-help`} className={cn("text-sm", codeError ? "text-destructive" : "text-muted-foreground")}>
                {codeError ?? "Toca el color para elegir en la paleta, o escribe el código de tu marca."}
              </p>
            </fieldset>
          ) : (
            <Button type="button" variant="outline" className="min-h-11 self-start" onClick={() => setOtherOpen(true)}>
              <span
                aria-hidden
                className="size-4 rounded-full"
                style={{ background: "conic-gradient(#ef4444,#f59e0b,#22c55e,#06b6d4,#3b82f6,#a855f7,#ef4444)" }}
              />
              Elegir otro color
            </Button>
          )}

          <ColorNotices palette={palette} chosen={chosen} />
        </div>

        <ColorPreview palette={palette} clinicName={clinicName} logo={logo} />

        <div className="order-2 flex flex-col gap-2 sm:col-start-1 sm:row-start-2">
          <div className="flex flex-wrap items-center gap-3">
            {dirty ? (
              <Button type="button" className="min-h-11" disabled={save.isPending} onClick={submit}>
                {save.isPending ? "Guardando…" : "Usar este color"}
              </Button>
            ) : null}
            {dirty && !save.isPending ? <span className="text-sm font-medium text-warning">Aún no se guarda</span> : null}
            {!dirty && brandColor ? (
              <Button type="button" variant="ghost" className="min-h-11" disabled={save.isPending} onClick={() => save.mutate(factory)}>
                Volver al {FACTORY_WORDS[product].color} de {FACTORY_WORDS[product].brand}
              </Button>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}

/** Lo que el sistema ajusta o nota del color elegido: informa, no frena. */
function ColorNotices({ palette, chosen }: { palette: BrandPalette; chosen: string }) {
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      {palette.lightened ? (
        <div className="flex items-center gap-3 rounded-xl bg-muted p-3">
          <div className="flex gap-1.5" aria-hidden>
            <span className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
              <span
                className="flex size-8 items-center justify-center rounded-lg border border-foreground/10 text-xs font-bold"
                style={{ backgroundColor: palette.light.fill, color: palette.light.fillForeground }}
              >
                Aa
              </span>
              Botones
            </span>
            <span className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
              <span className="size-8 rounded-lg" style={{ backgroundColor: palette.light.primary }} />
              Textos
            </span>
          </div>
          <p className="text-sm">
            {palette.light.fill === chosen
              ? "Tu color es claro: los botones lo llevan tal cual y los textos, un tono más oscuro para que se lean."
              : "Para que se lea, los botones y los textos llevan este tono más oscuro. Tu logo no cambia."}
          </p>
        </div>
      ) : null}
      {palette.nearWhite ? (
        <p className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-sm text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          Es casi blanco y no se distingue del fondo: los botones saldrán en un gris. Puedes usarlo igual.
        </p>
      ) : null}
      {palette.reddish ? (
        <p className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-sm text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          Se parece al rojo de los errores: un botón tuyo podría confundirse con un aviso. Puedes usarlo igual.
        </p>
      ) : null}
    </div>
  )
}

/** Así se verá: una muestra de la app, de lo del paciente y del papel, con el color elegido aún sin guardar. */
function ColorPreview({ palette, clinicName, logo }: { palette: BrandPalette; clinicName: string; logo: string | null }) {
  const id = useId()
  const { light, paper } = palette
  return (
    <section className="order-3 flex flex-col gap-2 sm:col-start-2 sm:row-span-2 sm:row-start-1" aria-labelledby={`${id}-preview`}>
      <h3 id={`${id}-preview`} className="text-sm font-semibold">
        Así se verá
      </h3>
      <div className="grid gap-2">
        <div className="theme-light overflow-hidden rounded-xl border bg-card text-card-foreground">
          <div className="border-b bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">Tu app</div>
          <div className="flex items-center gap-2 p-2.5 text-xs">
            <span
              className="rounded-md px-1.5 py-1 font-semibold"
              style={{ backgroundColor: light.soft, color: light.softForeground }}
            >
              Personas
            </span>
            <span
              className="rounded-md px-2 py-1 text-center font-semibold"
              style={{ backgroundColor: light.fill, color: light.fillForeground }}
            >
              Atender
            </span>
            <span className="font-semibold underline" style={{ color: light.primary }}>
              Ver su plan
            </span>
          </div>
        </div>
        <div className="theme-light overflow-hidden rounded-xl border bg-card text-card-foreground">
          <div className="border-b bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
            Lo que ve tu paciente
          </div>
          <div className="p-2.5 text-xs">
            <div className="overflow-hidden rounded-lg border">
              <div className="truncate px-2 py-1 font-semibold" style={{ backgroundColor: light.fill, color: light.fillForeground }}>
                {clinicName}
              </div>
              <div className="m-1.5 rounded-md bg-muted px-2 py-1">Hola, ¿en qué podemos ayudarte?</div>
            </div>
          </div>
        </div>
        <div className="theme-light overflow-hidden rounded-xl border bg-card text-card-foreground">
          <div className="border-b bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
            Tus documentos
          </div>
          <div className="flex flex-col gap-1.5 p-2.5">
            <div className="flex min-w-0 items-center gap-1.5">
              {logo ? (
                <img src={logo} alt="" className="h-5 max-w-12 object-contain" />
              ) : (
                // Sin logo, el papel lleva el cuadro de iniciales en el color.
                <span aria-hidden className="size-5 shrink-0" style={{ backgroundColor: paper }} />
              )}
              <span className="truncate font-serif text-sm">{clinicName}</span>
            </div>
            <span aria-hidden className="h-0.5" style={{ backgroundColor: paper }} />
            <span className="font-serif text-xs font-semibold tracking-wide">RECETA</span>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Los colores de error, listo y aviso no cambian.</p>
    </section>
  )
}
