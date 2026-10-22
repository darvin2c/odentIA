/**
 * Piezas de los formularios de Inventario: números enteros con el separador
 * de miles de la clínica (sin las flechas de `type="number"`), importes con su
 * símbolo, la unidad de la lista (o una propia) y el buscador de un producto o
 * un proveedor. Todas van dentro de un `Field` de la pantalla, que pone la
 * etiqueta, la ayuda y el error.
 */
import { INVENTORY_UNITS } from "@odentia/clinical"
import {
  cn,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  Input,
} from "@odentia/ui"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@odentia/ui/components/input-group"
import { normalizeSearchText } from "@odentia/ui-patterns"
import * as React from "react"
import { ChoiceSelect } from "../ui/choice-select"
import { currencySymbol, formatWhole, parseWhole, TONE_CLASS, type Tone } from "../../lib/inventory"

/** Un estado con palabras y su color: nunca solo el color. */
export function Chip({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-xs font-bold", TONE_CLASS[tone], className)}>
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * Un entero escrito con el teclado numérico del teléfono y el separador de
 * miles de la clínica al salir del campo. `suffix` dice en qué se cuenta.
 */
export function QuantityInput({
  id,
  value,
  onChange,
  prefix,
  suffix,
  invalid = false,
  disabled = false,
  placeholder,
  className,
  inputRef,
  onKeyDown,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  ...rest
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  prefix?: React.ReactNode
  suffix?: React.ReactNode
  invalid?: boolean
  disabled?: boolean
  placeholder?: string
  className?: string
  inputRef?: React.Ref<HTMLInputElement>
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
  "aria-label"?: string
  "aria-describedby"?: string
  "data-count-input"?: string
}) {
  return (
    <InputGroup className={cn("h-11 sm:h-9", className)} data-disabled={disabled || undefined}>
      {prefix ? (
        <InputGroupAddon align="inline-start">
          <InputGroupText className="whitespace-nowrap">{prefix}</InputGroupText>
        </InputGroupAddon>
      ) : null}
      <InputGroupInput
        id={id}
        ref={inputRef}
        inputMode="numeric"
        autoComplete="off"
        enterKeyHint="next"
        className="tabular-nums"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        onBlur={() => {
          const parsed = parseWhole(value)
          if (parsed !== null && !Number.isNaN(parsed)) onChange(formatWhole(parsed))
        }}
        onKeyDown={onKeyDown}
        {...rest}
      />
      {suffix ? (
        <InputGroupAddon align="inline-end">
          <InputGroupText className="whitespace-nowrap">{suffix}</InputGroupText>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  )
}

/** Un importe en la moneda de la clínica, con su símbolo delante («S/ 36.50»). */
export function MoneyInput({
  id,
  value,
  onChange,
  currency,
  invalid = false,
  disabled = false,
  placeholder,
  className,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  currency: string
  invalid?: boolean
  disabled?: boolean
  placeholder?: string
  className?: string
  "aria-label"?: string
  "aria-describedby"?: string
}) {
  return (
    <InputGroup className={cn("h-11 sm:h-9", className)} data-disabled={disabled || undefined}>
      <InputGroupAddon align="inline-start">
        <InputGroupText>{currencySymbol(currency)}</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        inputMode="decimal"
        autoComplete="off"
        className="tabular-nums"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
    </InputGroup>
  )
}

const OTHER = "__otra__"

/**
 * La unidad: una de la lista, por su nombre, o una propia escrita («bolsa»).
 * El servidor guarda la palabra y, si la tiene, su código internacional.
 */
export function UnitSelect({
  id,
  value,
  onChange,
  disabled = false,
  invalid = false,
  label,
  "aria-describedby": describedBy,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  invalid?: boolean
  /** Nombre del campo, para el campo de la unidad propia. */
  label: string
  "aria-describedby"?: string
}) {
  const listed = INVENTORY_UNITS.some((unit) => unit.word === value.trim().toLowerCase())
  const [other, setOther] = React.useState(value !== "" && !listed)
  const showOther = other || (value !== "" && !listed)
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ChoiceSelect
        id={id}
        value={showOther ? OTHER : value}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        placeholder="Elige la unidad"
        onChange={(event) => {
          const next = event.target.value
          if (next === OTHER) {
            setOther(true)
            onChange("")
            return
          }
          setOther(false)
          onChange(next)
        }}
      >
        {INVENTORY_UNITS.map((unit) => (
          <option key={unit.word} value={unit.word}>
            {unit.word}
          </option>
        ))}
        <option value={OTHER}>Otra unidad…</option>
      </ChoiceSelect>
      {showOther ? (
        <Input
          aria-label={`${label}: escribe la unidad`}
          placeholder="Por ejemplo: bolsa"
          maxLength={60}
          value={value}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </div>
  )
}

export interface PickOption {
  id: string
  label: string
  detail?: string
}

/**
 * Buscar y elegir uno de una lista (un producto, un proveedor): se escribe el
 * nombre y se toca. Con `resetOnPick` el campo queda vacío para agregar otro
 * («Buscar producto…» al final de las filas de una compra).
 */
export function PickCombobox({
  id,
  label,
  options,
  value,
  onPick,
  placeholder = "Buscar…",
  invalid = false,
  disabled = false,
  resetOnPick = false,
  empty = "Sin coincidencias",
  "aria-describedby": describedBy,
}: {
  id: string
  /** Nombre accesible del campo y de su lista. */
  label: string
  options: readonly PickOption[]
  value: string
  onPick: (id: string) => void
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
  resetOnPick?: boolean
  empty?: React.ReactNode
  "aria-describedby"?: string
}) {
  type Item = PickOption & { search: string }
  const items = React.useMemo<Item[]>(
    () => options.map((option) => ({ ...option, search: normalizeSearchText(`${option.label} ${option.detail ?? ""}`) })),
    [options],
  )
  const selected = resetOnPick ? null : (items.find((item) => item.id === value) ?? null)
  const [typed, setTyped] = React.useState<{ text: string; forValue: string } | null>(null)
  const showingLabel = !typed || typed.forValue !== value
  const inputValue = showingLabel ? (selected?.label ?? "") : typed.text
  return (
    <Combobox
      items={items}
      value={selected}
      inputValue={inputValue}
      onInputValueChange={(next) => setTyped({ text: next, forValue: value })}
      onValueChange={(item) => {
        setTyped(resetOnPick ? { text: "", forValue: value } : null)
        if (item) onPick(item.id)
      }}
      itemToStringLabel={(item: Item) => item.label}
      isItemEqualToValue={(a: Item, b: Item) => a.id === b.id}
      filter={(item: Item, query: string) => {
        const needle = normalizeSearchText(query.trim())
        return !needle || item.search.includes(needle)
      }}
      disabled={disabled}
    >
      <ComboboxInput
        id={id}
        className="w-full"
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        placeholder={placeholder}
        triggerLabel={`Mostrar la lista: ${label}`}
        disabled={disabled}
        onFocus={() => {
          if (showingLabel) setTyped({ text: "", forValue: value })
        }}
        onBlur={() => setTyped(null)}
      />
      <ComboboxContent aria-label={label}>
        <ComboboxList aria-label={label}>
          {(item: Item) => (
            <ComboboxItem key={item.id} value={item}>
              <span className="grid min-w-0">
                <span className="truncate">{item.label}</span>
                {item.detail ? <span className="truncate text-xs text-muted-foreground">{item.detail}</span> : null}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{empty}</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  )
}

/** «(opcional)» en la etiqueta de lo que puede quedar vacío. */
export function Optional() {
  return <span className="font-normal text-muted-foreground">(opcional)</span>
}
