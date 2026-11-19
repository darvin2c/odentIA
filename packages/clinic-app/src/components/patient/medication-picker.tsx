import {
  matchHabitualMedication,
  normalizeDrugText,
  searchHabitualMedications,
} from "@odentia/clinical"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@odentia/ui"
import { useMemo, useState } from "react"
import { productUi } from "../../product/product-ui"

type Item = { key: string; dci: string; detail: string }

/**
 * El principio activo de la medicación habitual (tablero 7): se escribe y se
 * elige de la lista por su DCI, su nombre local o su marca, con su código ATC
 * (el mismo de la receta). Lo escrito que empieza por uno de esos nombres queda
 * tal cual y con su código; lo que no está, tal cual y sin código.
 */
export function MedicationPicker({
  id,
  value,
  onChange,
  disabled = false,
}: {
  id: string
  value: string
  onChange: (dci: string) => void
  disabled?: boolean
}) {
  const [typed, setTyped] = useState<string | null>(null)
  const items = useMemo<Item[]>(() => {
    const text = (typed ?? "").trim()
    // La del producto de la clínica (latidIA suma la medicina general, issue 229).
    const habitual = productUi().prescribing.catalog.habitual
    const found = searchHabitualMedications(text, 8, habitual).map((entry) => ({
      key: entry.atc + entry.dci,
      dci: entry.dci,
      // Si salió por su marca o su nombre local, lo dice: «Fosamax · ATC M05BA04».
      detail: entry.via ? `${entry.via} · ATC ${entry.atc}` : `ATC ${entry.atc}`,
    }))
    // Lo escrito con la dosis («alendronato 70 mg semanal») queda tal cual y con el código de su
    // DCI; lo que no nombra ninguna de la lista, tal cual y sin código.
    const named = text ? matchHabitualMedication(text, habitual) : null
    if (text && (!named || normalizeDrugText(text) !== normalizeDrugText(named.entry.dci)))
      found.push({
        key: `texto:${text}`,
        dci: text,
        detail: named
          ? `Escrito tal cual: ${named.entry.dci} · ATC ${named.entry.atc}`
          : "Escrito tal cual, sin código",
      })
    return found
  }, [typed])
  const selected = value ? { key: `valor:${value}`, dci: value, detail: "" } : null
  return (
    <Combobox
      items={items}
      value={selected}
      inputValue={typed ?? value}
      onInputValueChange={(next) => setTyped(next)}
      onValueChange={(item: Item | null) => {
        setTyped(null)
        onChange(item?.dci ?? "")
      }}
      itemToStringLabel={(item: Item) => item.dci}
      isItemEqualToValue={(a: Item, b: Item) => a.dci === b.dci}
      filter={() => true}
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        className="w-full"
        placeholder="Ej.: losartán, warfarina"
        triggerLabel="Mostrar la lista de medicamentos"
        autoComplete="off"
        disabled={disabled}
        onBlur={() => {
          // Lo escrito sin elegir también vale: queda tal cual.
          if (typed !== null && typed.trim() !== value) onChange(typed.trim())
          setTyped(null)
        }}
      />
      <ComboboxContent aria-label="Medicamentos">
        <ComboboxList aria-label="Medicamentos">
          {(item: Item) => (
            <ComboboxItem key={item.key} value={item}>
              <span className="flex min-w-0 flex-col">
                <span className="break-words">{item.dci}</span>
                <span className="break-words text-xs text-muted-foreground">{item.detail}</span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>Escribe para buscar</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}
