import { Button, Field, FieldLabel, Slider } from "@odentia/ui"
import { ViewTabs } from "@odentia/ui-patterns"
import { useId, useState } from "react"

/** Ajustes de visualización: solo afectan a la pantalla, nunca al archivo. */
export interface ImageAdjustments {
  zoom: number
  brightness: number
  contrast: number
  invert: boolean
}

export const DEFAULT_ADJUSTMENTS: ImageAdjustments = {
  zoom: 1,
  brightness: 100,
  contrast: 100,
  invert: false,
}

function filterOf(a: ImageAdjustments): string {
  return `brightness(${a.brightness}%) contrast(${a.contrast}%)${a.invert ? " invert(1)" : ""}`
}

function sliderValue(value: number | readonly number[]): number {
  return Array.isArray(value) ? (value[0] ?? 0) : (value as number)
}

/** Controles de zoom, brillo, contraste e inversión, accesibles con teclado. */
export function ImageAdjustControls({
  value,
  onChange,
}: {
  value: ImageAdjustments
  onChange: (next: ImageAdjustments) => void
}) {
  const id = useId()
  const changed =
    value.zoom !== 1 || value.brightness !== 100 || value.contrast !== 100 || value.invert
  return (
    <fieldset className="grid grid-cols-1 gap-3 rounded-md border px-3 py-2 sm:grid-cols-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">
        Ajustes de visualización (no modifican el archivo)
      </legend>
      <Field>
        <FieldLabel htmlFor={`${id}-zoom`}>Acercar · {Math.round(value.zoom * 100)} %</FieldLabel>
        <Slider
          id={`${id}-zoom`}
          aria-label="Acercar"
          value={[value.zoom]}
          min={1}
          max={4}
          step={0.1}
          onValueChange={(v) => onChange({ ...value, zoom: sliderValue(v) })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-brightness`}>Brillo · {value.brightness} %</FieldLabel>
        <Slider
          id={`${id}-brightness`}
          aria-label="Brillo"
          value={[value.brightness]}
          min={40}
          max={200}
          step={5}
          onValueChange={(v) => onChange({ ...value, brightness: sliderValue(v) })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-contrast`}>Contraste · {value.contrast} %</FieldLabel>
        <Slider
          id={`${id}-contrast`}
          aria-label="Contraste"
          value={[value.contrast]}
          min={40}
          max={250}
          step={5}
          onValueChange={(v) => onChange({ ...value, contrast: sliderValue(v) })}
        />
      </Field>
      <div className="flex flex-wrap gap-2 sm:col-span-3">
        <Button
          type="button"
          size="sm"
          variant={value.invert ? "secondary" : "outline"}
          aria-pressed={value.invert}
          onClick={() => onChange({ ...value, invert: !value.invert })}
        >
          Invertir
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!changed}
          onClick={() => onChange(DEFAULT_ADJUSTMENTS)}
        >
          Restablecer
        </Button>
      </div>
    </fieldset>
  )
}

/** Imagen con los ajustes aplicados; con zoom se desplaza dentro de su marco. */
export function AdjustedImage({
  src,
  alt,
  adjustments,
  className = "max-h-[60vh]",
}: {
  src: string
  alt: string
  adjustments: ImageAdjustments
  className?: string
}) {
  return (
    // scroll-nativo: visor con zoom; se recorre arrastrando y con el teclado sobre la imagen ampliada.
    <div
      className={`overflow-auto rounded-md bg-black/90 ${className}`}
      // El marco desplazable recibe foco para recorrer la imagen ampliada con teclado.
      tabIndex={adjustments.zoom > 1 ? 0 : undefined}
      role={adjustments.zoom > 1 ? "group" : undefined}
      aria-label={
        adjustments.zoom > 1 ? `${alt} ampliada; usa las flechas para desplazarte` : undefined
      }
    >
      <img
        src={src}
        alt={alt}
        className="mx-auto block h-auto max-w-none object-contain"
        style={{
          width: `${adjustments.zoom * 100}%`,
          filter: filterOf(adjustments),
        }}
      />
    </div>
  )
}

export interface CompareItem {
  url: string
  label: string
  caption: string
}

/**
 * Comparación de dos imágenes: lado a lado o superpuestas con un deslizador
 * que revela la segunda sobre la primera (antes y después, controles).
 * Los mismos ajustes se aplican a ambas para que la comparación sea justa.
 */
export function ImageCompare({ before, after }: { before: CompareItem; after: CompareItem }) {
  const id = useId()
  const [mode, setMode] = useState<"lado" | "superpuesta">("lado")
  const [reveal, setReveal] = useState(50)
  const [adjustments, setAdjustments] = useState<ImageAdjustments>(DEFAULT_ADJUSTMENTS)
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ViewTabs
        label="Modo de comparación"
        value={mode}
        options={[
          { value: "lado", label: "Lado a lado" },
          { value: "superpuesta", label: "Superpuestas" },
        ]}
        onValueChange={setMode}
      />
      {mode === "lado" ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {[before, after].map((item) => (
            <figure key={item.url} className="flex min-w-0 flex-col gap-1">
              <AdjustedImage src={item.url} alt={item.label} adjustments={adjustments} />
              <figcaption className="text-xs text-muted-foreground">{item.caption}</figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <figure className="flex min-w-0 flex-col gap-2">
          <div className="relative overflow-hidden rounded-md bg-black/90">
            <img
              src={before.url}
              alt={before.label}
              className="block max-h-[60vh] w-full object-contain"
              style={{ filter: filterOf(adjustments) }}
            />
            <img
              src={after.url}
              alt={after.label}
              className="absolute inset-0 block h-full w-full object-contain"
              style={{
                filter: filterOf(adjustments),
                clipPath: `inset(0 ${100 - reveal}% 0 0)`,
              }}
            />
          </div>
          <Field>
            <FieldLabel htmlFor={`${id}-reveal`}>
              Mostrar «{after.caption}» sobre «{before.caption}» · {reveal} %
            </FieldLabel>
            <Slider
              id={`${id}-reveal`}
              aria-label="Proporción de la segunda imagen"
              value={[reveal]}
              min={0}
              max={100}
              step={1}
              onValueChange={(v) => setReveal(sliderValue(v))}
            />
          </Field>
        </figure>
      )}
      <ImageAdjustControls value={adjustments} onChange={setAdjustments} />
    </div>
  )
}
