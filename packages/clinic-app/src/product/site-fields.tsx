import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { type PlacesPickerProps, productUi, type SitePickerProps } from "./product-ui"

const ALL_PLACES = "todas"

/**
 * «Todas las piezas ▾»: filtrar por lugar en Historia y en Documentos (decisión
 * 7), si el producto registra dónde. Un lugar que no es suyo se ve como todos.
 */
export function PlaceSelect({
  id,
  value,
  onChange,
  className,
}: {
  id?: string
  value: number | undefined
  onChange: (place: number | undefined) => void
  className?: string
}) {
  const site = productUi().site
  if (!site) return null
  const items: Record<string, string> = {
    [ALL_PLACES]: site.allPlacesLabel,
    ...Object.fromEntries(
      site.placeGroups
        .flatMap((group) => group.places)
        .map((place) => [String(place), site.placeName(place)]),
    ),
  }
  const current = value != null && items[String(value)] ? String(value) : ALL_PLACES
  return (
    <Select
      items={items}
      value={current}
      onValueChange={(next) => onChange(next && next !== ALL_PLACES ? Number(next) : undefined)}
    >
      <SelectTrigger id={id} aria-label={site.placeLabel} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_PLACES}>{site.allPlacesLabel}</SelectItem>
        {site.placeGroups.map((group) => (
          <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.places.map((place) => (
              <SelectItem key={place} value={String(place)}>
                {site.placeName(place)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Los lugares de algo (un documento, una imagen, un campo de formulario), si el
 * producto registra dónde (odentIA: las piezas). Si no, no hay nada que elegir.
 * No pinta etiqueta: la pantalla lo nombra con `site.placesLabel`.
 */
export function PlacesField(props: PlacesPickerProps) {
  const site = productUi().site
  return site ? <site.PlacesPicker {...props} /> : null
}

/** Un lugar con sus partes (el diagnóstico, el procedimiento), si el producto registra dónde. Sin etiqueta propia. */
export function SiteField(props: SitePickerProps) {
  const site = productUi().site
  return site ? <site.SitePicker {...props} /> : null
}

/** Las partes de un lugar en palabras («Oclusal, Mesial»). */
export function partNames(parts: readonly string[]): string {
  const site = productUi().site
  return parts.map((part) => site?.partName(part) ?? part).join(", ")
}
