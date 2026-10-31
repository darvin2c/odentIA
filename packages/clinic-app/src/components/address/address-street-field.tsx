import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList, FieldDescription } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { MapPin } from "lucide-react"
import { useEffect, useId, useState } from "react"
import type { AddressPick, AddressSource, AddressSuggestion } from "../../lib/address-suggestions"

/**
 * «Calle y número» con sugerencias (issue 36, ADR 0077): al escribir desde la
 * tercera letra se ofrecen direcciones (y, en la sede, también la clínica por
 * su nombre); elegir una llena lo demás, que se puede corregir. Las
 * sugerencias nunca obligan: lo escrito se guarda tal cual. Sin proveedor, sin
 * respuesta o pasado el tope del día, es un campo de texto como cualquiera.
 *
 * La etiqueta, la ayuda y el error los pinta la pantalla; el campo solo suma
 * su pista (qué hacer si no aparece, qué llenó la elección) a `aria-describedby`.
 */
export function AddressStreetField({
  id: idProp,
  value,
  onChange,
  onPick,
  source,
  placeholder,
  pickedHint,
  maxLength = 300,
  invalid = false,
  autoComplete = "street-address",
  onBlur,
  "aria-describedby": describedBy,
}: {
  id?: string
  value: string
  /** Lo escrito: también cuando no se elige ninguna sugerencia. */
  onChange: (value: string) => void
  /** Lo elegido de la lista, para llenar los demás campos. */
  onPick: (pick: AddressPick) => void
  /** De dónde salen las sugerencias; sin él, el campo de siempre. */
  source?: AddressSource
  placeholder?: string
  /** Lo que se dice después de elegir: «Lo llenó Google Maps; puedes corregirlo…». */
  pickedHint: string
  maxLength?: number
  /** El error lo dice la pantalla: el campo solo se marca. */
  invalid?: boolean
  autoComplete?: string
  onBlur?: () => void
  "aria-describedby"?: string
}) {
  const fallbackId = useId()
  const id = idProp ?? fallbackId
  const hintId = useId()
  // Una sesión por búsqueda: termina al elegir (el proveedor cobra la búsqueda entera una sola vez).
  const [session, setSession] = useState(() => crypto.randomUUID())
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const [debounced, setDebounced] = useState("")
  const [picked, setPicked] = useState(false)
  const [off, setOff] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(typed.trim()), 300)
    return () => clearTimeout(timer)
  }, [typed])
  const results = useQuery({
    queryKey: ["address-suggestions", session, debounced],
    queryFn: () => (source ? source.suggest({ text: debounced, session }) : Promise.resolve(null)),
    enabled: Boolean(source) && !off && debounced.length >= 3,
    staleTime: 60_000,
    retry: false,
  })
  // Sin proveedor o pasado el tope, no se vuelve a preguntar en esta pantalla.
  useEffect(() => {
    if (results.data && !results.data.available) setOff(true)
    // Si la respuesta llega cuando ya se salió del campo (Esc, otro campo), la lista no se abre encima.
    if (results.data && typeof document !== "undefined" && document.activeElement?.id !== id) setOpen(false)
  }, [results.data, id])
  const items = results.data?.available ? results.data.suggestions : []
  const attribution = results.data?.attribution ?? null

  async function choose(item: AddressSuggestion) {
    setOpen(false)
    // Sin esto, la sesión nueva repetiría la última búsqueda (y el proveedor la cobraría).
    setTyped("")
    setDebounced("")
    const address = item.address ?? (source?.resolve ? await source.resolve({ id: item.id, session }).catch(() => null) : null)
    setSession(crypto.randomUUID())
    if (!address) {
      // Sin la dirección completa queda lo que dice la sugerencia: se corrige a mano.
      onChange(item.isPlace ? (item.secondary?.split(",")[0] ?? item.main) : item.main)
      return
    }
    setPicked(true)
    // Primero lo escrito y después lo elegido: quien escucha `onChange` puede soltar lo que traía la elección anterior.
    // Una ciudad, un distrito o un negocio sin calle no son «Calle y número»: queda vacía para escribirla.
    onChange(address.line ?? "")
    onPick({ ...address, placeName: item.isPlace ? item.main : null })
  }

  return (
    <>
      <Combobox
        items={items}
        filter={null}
        value={null}
        open={open && items.length > 0}
        onOpenChange={setOpen}
        inputValue={value}
        itemToStringLabel={(item: AddressSuggestion) => item.main}
        onInputValueChange={(next, details) => {
          if (details.reason !== "input-change") return
          setPicked(false)
          setTyped(next)
          setOpen(true)
          onChange(next)
        }}
        onValueChange={(item: AddressSuggestion | null) => {
          if (item) void choose(item)
        }}
      >
        <ComboboxInput
          id={id}
          className="w-full"
          placeholder={placeholder}
          maxLength={maxLength}
          autoComplete={autoComplete}
          aria-invalid={invalid || undefined}
          aria-describedby={[describedBy, picked || (source && !off) ? hintId : undefined].filter(Boolean).join(" ") || undefined}
          onBlur={() => onBlur?.()}
          showTrigger={false}
        />
        <ComboboxContent aria-label="Direcciones sugeridas">
          <ComboboxList aria-label="Direcciones sugeridas">
            {(item: AddressSuggestion) => (
              <ComboboxItem key={item.id} value={item} className="items-start">
                <MapPin aria-hidden className="mt-0.5 text-primary" />
                <span className="flex min-w-0 flex-col">
                  <span className="break-words">{item.main}</span>
                  {item.secondary ? <span className="break-words text-xs font-normal text-muted-foreground">{item.secondary}</span> : null}
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
          {/* La mención que piden las condiciones del proveedor, solo en la lista. */}
          {attribution ? <p className="px-4 pb-2 text-right text-[11px] text-muted-foreground">{attribution}</p> : null}
        </ComboboxContent>
      </Combobox>
      {picked || (source && !off) ? (
        <FieldDescription id={hintId}>
          {picked ? pickedHint : "Si no aparece en la lista, sigue escribiendo: se guarda tal cual."}
        </FieldDescription>
      ) : null}
    </>
  )
}
