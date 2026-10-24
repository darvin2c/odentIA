import { findHabitualMedication, searchHabitualMedications } from "@odentia/clinical"
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
 * elige de la lista por su DCI, con su código ATC (el mismo de la receta). Lo
 * que no está se guarda tal cual, sin código.
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
      detail: `ATC ${entry.atc}`,
    }))
    if (text && !findHabitualMedication(text, habitual))
      found.push({ key: `texto:${text}`, dci: text, detail: "Escrito tal cual, sin código" })
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
