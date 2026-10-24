import {
  type AllergenEntry,
  allergenDetail,
  codeAllergySubstance,
  searchAllergens,
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

/** Lo elegido: una sustancia de la lista o, a propósito, lo escrito sin codificar. */
export type AllergenChoice =
  | { kind: "entry"; entry: AllergenEntry }
  | { kind: "text"; text: string }

type Item = { key: string; label: string; detail: string; choice: AllergenChoice }

function itemOf(choice: AllergenChoice): Item {
  return choice.kind === "entry"
    ? {
        key: `${choice.entry.system}:${choice.entry.code}`,
        label: choice.entry.label,
        detail: allergenDetail(choice.entry),
        choice,
      }
    : {
        key: `texto:${choice.text}`,
        label: `Usar «${choice.text}» como texto, sin codificar`,
        detail: "No avisará por grupo al recetar",
        choice,
      }
}

/**
 * La sustancia de una alergia (tablero 7): se escribe y se elige de la lista
 * («Penicilinas (grupo) · medicamento · ATC J01C»), y el tipo de alérgeno sale
 * de ahí. Lo que no está se puede guardar como texto, sin codificar.
 */
export function AllergenPicker({
  id,
  value,
  onChange,
  allowText = true,
  invalid = false,
  disabled = false,
  "aria-describedby": describedBy,
}: {
  id: string
  value: AllergenChoice | null
  onChange: (value: AllergenChoice | null) => void
  /** «Elegir de la lista» no ofrece volver a dejarla como texto. */
  allowText?: boolean
  invalid?: boolean
  disabled?: boolean
  "aria-describedby"?: string
}) {
  const [typed, setTyped] = useState<string | null>(null)
  const selected = value ? itemOf(value) : null
  const inputValue =
    typed ?? (value ? (value.kind === "entry" ? value.entry.label : value.text) : "")
  const items = useMemo<Item[]>(() => {
    const text = (typed ?? "").trim()
    // La lista del producto de la clínica (latidIA suma la medicina general, issue 229).
    const allergens = productUi().prescribing.catalog.allergens
    const found = searchAllergens(text, 8, allergens).map((entry) => itemOf({ kind: "entry", entry }))
    // Lo escrito que no es exactamente una de la lista se puede guardar tal cual.
    if (allowText && text && !codeAllergySubstance(text, allergens)) found.push(itemOf({ kind: "text", text }))
    return found
  }, [typed, allowText])

  return (
    <Combobox
      items={items}
      value={selected}
      inputValue={inputValue}
      onInputValueChange={(next) => {
        setTyped(next)
        if (value) onChange(null)
      }}
      onValueChange={(item: Item | null) => {
        setTyped(null)
        onChange(item?.choice ?? null)
      }}
      itemToStringLabel={(item: Item) =>
        item.choice.kind === "entry" ? item.choice.entry.label : item.choice.text
      }
      isItemEqualToValue={(a: Item, b: Item) => a.key === b.key}
      filter={() => true}
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        className="w-full"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        placeholder="Escribe: penicilina, látex, maní…"
        triggerLabel="Mostrar la lista de sustancias"
        autoComplete="off"
        disabled={disabled}
      />
      <ComboboxContent aria-label="Sustancias">
        <ComboboxList aria-label="Sustancias">
          {(item: Item) => (
            <ComboboxItem key={item.key} value={item}>
              <span className="flex min-w-0 flex-col">
                <span className="break-words">{item.label}</span>
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
