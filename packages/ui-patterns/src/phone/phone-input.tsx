import { useMaskito } from "@maskito/react"
import { cn, InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@odentia/ui"
import * as React from "react"
import { common } from "../common.js"
import { CountrySelect } from "./country-select.js"
import {
  type CountryCode,
  countryOf,
  getCountryCallingCode,
  nationalText,
  normalizeCountry,
  type PhoneMeta,
  phoneDigits,
  phoneMeta,
  readInternational,
  regionCountry,
} from "./phone.js"
import { maskNationalDigits, phoneMaskOptions, phonePlaceholder } from "./phone-mask.js"

export interface PhoneInputProps {
  /**
   * Teléfono en E.164 (`+51987654321`) o `null`. Nunca el texto con máscara: el
   * texto es presentación, el valor es lo que se persiste y se compara.
   */
  value: string | null
  /** Recibe el E.164 (o `null` mientras lo tecleado no sea un número) y su lectura. */
  onChange: (value: string | null, meta: PhoneMeta) => void
  /**
   * País del selector y del formato nacional. Por defecto, el de la clínica
   * (`regionCountry`): el núcleo no supone ninguno.
   */
  defaultCountry?: CountryCode
  /** Acota el selector cuando la organización atiende unos pocos países. */
  countries?: readonly CountryCode[]
  /** Muestra el selector de país. Sin él, el prefijo se muestra dentro del campo. */
  showCountrySelect?: boolean
  invalid?: boolean
  disabled?: boolean
  id?: string
  name?: string
  /** Por defecto, el ejemplo móvil del país (`987 654 321`), que enseña la máscara. */
  placeholder?: string
  autoComplete?: string
  className?: string
  onBlur?: React.FocusEventHandler<HTMLInputElement>
  "aria-describedby"?: string
}

/**
 * Teléfono con máscara por país y valor canónico E.164. El texto que se ve lo
 * formatea `@maskito/phone` con los metadatos de `libphonenumber-js`; el valor
 * que emite es E.164, el mismo formato que guardan `contact.phone` y
 * `patient.phone` y del que dependen la deduplicación y la identidad de canal.
 *
 * **El prefijo internacional lo lleva el selector, no el teclado**: el campo
 * muestra siempre el número nacional (`987 654 321`) y a su izquierda se lee
 * `PE +51`. Pegar un número con prefijo de otro país cambia el selector y deja
 * los dígitos nacionales (si hay prefijo); pegar uno del mismo país descarta el
 * prefijo y conserva el número. Sin selector de país, el prefijo se pinta dentro
 * del campo para no dejarlo invisible.
 *
 * El error lo dibuja la pantalla (`Field`/`FieldError`) y el campo se marca
 * inválido por sí solo al salir si lo escrito no es un teléfono válido: un
 * número a medias no puede parecer correcto. Tampoco valida como verdad final —
 * el servidor sigue siendo autoritativo (`normalizeChannelIdentity`).
 *
 * Tampoco decide identidad: un teléfono compartido no identifica a un paciente
 * único, así que la detección de duplicados vive en servicios y la orquesta la
 * pantalla.
 */
export function PhoneInput({
  value,
  onChange,
  defaultCountry,
  countries,
  showCountrySelect = true,
  invalid: invalidProp = false,
  disabled = false,
  id,
  name,
  placeholder,
  autoComplete = "tel",
  className,
  onBlur,
  "aria-describedby": ariaDescribedBy,
}: PhoneInputProps) {
  const [country, setCountry] = React.useState<CountryCode>(
    // El número guardado manda sobre el país por defecto: la ficha de un
    // paciente argentino debe abrir con la máscara argentina.
    () =>
      (value ? countryOf(value) : undefined) ?? normalizeCountry(defaultCountry) ?? regionCountry(),
  )
  const [display, setDisplay] = React.useState(() => (value ? fieldText(value) : ""))
  const [touched, setTouched] = React.useState(false)
  // Último E.164 emitido: evita repintar lo tecleado cuando el formulario
  // devuelve ese mismo valor (o `null` mientras el número está incompleto).
  const emitted = React.useRef<string | null>(value)

  const maskOptions = React.useMemo(() => phoneMaskOptions(country), [country])
  const maskRef = useMaskito({ options: maskOptions })
  const maskPlaceholder = React.useMemo(() => phonePlaceholder(country), [country])

  /*
   * Un campo con un teléfono a medias no puede parecer correcto: al salir se
   * marca inválido por sí solo. El mensaje lo pone la pantalla (`FieldError`);
   * aquí solo se enciende `aria-invalid`, que es lo que pinta el error.
   */
  const current = React.useMemo(() => phoneMeta(display, country), [country, display])
  const invalid = invalidProp || (touched && current.digits.length > 0 && !current.isValid)

  React.useEffect(() => {
    if (value === emitted.current) return
    emitted.current = value
    setDisplay(value ? fieldText(value) : "")
    const nextCountry = value ? countryOf(value) : undefined
    if (nextCountry && nextCountry !== country) setCountry(nextCountry)
  }, [country, value])

  function emit(nextDisplay: string, nextCountry: CountryCode) {
    const meta = phoneMeta(nextDisplay, nextCountry)
    emitted.current = meta.e164
    onChange(meta.e164, meta)
  }

  function handleInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.value
    setDisplay(next)
    emit(next, country)
  }

  function handleCountryChange(next: CountryCode) {
    if (next === country) return
    setCountry(next)
    const digits = phoneDigits(display)
    if (!digits) return
    const nextDisplay = maskNationalDigits(digits, next)
    setDisplay(nextDisplay)
    emit(nextDisplay, next)
  }

  /** Pegar un número de otro país mueve el selector en vez de dejar el prefijo tecleado. */
  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = readInternational(event.clipboardData.getData("text"))
    if (!pasted || pasted.country === country) return
    event.preventDefault()
    const nextDisplay = maskNationalDigits(phoneDigits(nationalText(pasted.e164)), pasted.country)
    setCountry(pasted.country)
    setDisplay(nextDisplay)
    emit(nextDisplay, pasted.country)
  }

  const inputProps: React.ComponentProps<typeof InputGroupInput> = {
    id,
    name,
    type: "tel",
    inputMode: "tel",
    autoComplete,
    placeholder: placeholder ?? maskPlaceholder ?? common.phone.placeholder,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": invalid || undefined,
    disabled,
    value: display,
    onChange: handleInputChange,
    onPaste: handlePaste,
    onBlur: (event: React.FocusEvent<HTMLInputElement>) => {
      setTouched(true)
      onBlur?.(event)
    },
  }

  return (
    <div className={cn("flex w-full min-w-0 items-center gap-2", className)}>
      {showCountrySelect ? (
        <CountrySelect
          value={country}
          onChange={handleCountryChange}
          countries={countries}
          disabled={disabled}
        />
      ) : null}
      <InputGroup className="h-9 min-w-0 flex-1">
        {showCountrySelect ? null : (
          <InputGroupAddon align="inline-start">
            <InputGroupText>{`+${getCountryCallingCode(country)}`}</InputGroupText>
          </InputGroupAddon>
        )}
        <InputGroupInput ref={maskRef} {...inputProps} />
      </InputGroup>
    </div>
  )
}

/**
 * Texto del campo para un teléfono guardado: el agrupamiento lo pone la máscara
 * del país del propio número. Un dato heredado que no sea un número se muestra
 * tal cual, para no vaciar el campo que la pantalla está editando.
 */
function fieldText(value: string): string {
  const country = countryOf(value)
  return country ? maskNationalDigits(phoneDigits(nationalText(value)), country) : value
}
