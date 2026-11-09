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
import { internationalMaskOptions, maskNationalDigits, phoneMaskOptions, phonePlaceholder } from "./phone-mask.js"

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
   * (`regionCountry`): el núcleo no supone ninguno. Si cambia con el campo
   * vacío y sin país elegido a mano, el selector lo sigue.
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
 * que emite es E.164, el mismo formato que guarda `contact.phone` (el teléfono
 * de la persona) y del que dependen la deduplicación y la identidad de canal.
 *
 * **El prefijo internacional lo lleva el selector, no el teclado**: el campo
 * muestra siempre el número nacional (`987 654 321`) y a su izquierda se lee
 * `PE +51`. Pegar un número con prefijo de otro país cambia el selector y deja
 * los dígitos nacionales (si hay prefijo); pegar uno del mismo país descarta el
 * prefijo y conserva el número. Sin selector de país, el prefijo se pinta dentro
 * del campo para no dejarlo invisible.
 *
 * Escribir «+» al empezar pasa a escribir el número entero con su prefijo
 * (`+44 7700 900878`): el selector toma el país del prefijo y, al salir del
 * campo, queda el número nacional con su país (QA del 8 nov, M10: el «+» se
 * perdía y el número quedaba con el prefijo repetido).
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
  // La persona eligió el país a mano (selector o pegando un número de otro país).
  const countryChosen = React.useRef(false)
  // Último E.164 emitido: evita repintar lo tecleado cuando el formulario
  // devuelve ese mismo valor (o `null` mientras el número está incompleto).
  const emitted = React.useRef<string | null>(value)

  // Escribiendo con «+»: el número entero con su prefijo, sin la máscara nacional.
  const [international, setInternational] = React.useState(false)
  const maskOptions = React.useMemo(
    () => (international ? internationalMaskOptions(country) : phoneMaskOptions(country)),
    [country, international],
  )
  const maskRef = useMaskito({ options: maskOptions })
  const maskPlaceholder = React.useMemo(() => phonePlaceholder(country), [country])

  /*
   * Un campo con un teléfono a medias no puede parecer correcto: al salir se
   * marca inválido por sí solo. El mensaje lo pone la pantalla (`FieldError`);
   * aquí solo se enciende `aria-invalid`, que es lo que pinta el error. Un
   * número posible pero raro para su país (un celular al que le falta un
   * dígito) también se pinta, pero es un aviso y no un error (`data-advisory`):
   * se guarda igual y el foco del envío va a lo que de verdad falta.
   */
  const current = React.useMemo(() => phoneMeta(display, country), [country, display])
  const doubtful = touched && current.digits.length > 0 && !current.isValid
  const invalid = invalidProp || doubtful
  const advisory = !invalidProp && doubtful && current.e164 !== null

  React.useEffect(() => {
    if (value === emitted.current) return
    emitted.current = value
    setDisplay(value ? fieldText(value) : "")
    const nextCountry = value ? countryOf(value) : undefined
    if (nextCountry && nextCountry !== country) setCountry(nextCountry)
  }, [country, value])

  /*
   * El país por defecto puede llegar después de montar el campo (el alta lo
   * elige en otro paso, un perfil que carga tarde). Mientras el campo esté
   * vacío y nadie haya elegido otro país, el selector lo sigue; lo escrito o
   * elegido a mano se respeta (issue 107).
   */
  React.useEffect(() => {
    const next = normalizeCountry(defaultCountry)
    if (!next || countryChosen.current || value || phoneDigits(display)) return
    setCountry((current) => (current === next ? current : next))
  }, [defaultCountry, display, value])

  function emit(nextDisplay: string, nextCountry: CountryCode) {
    const meta = phoneMeta(nextDisplay, nextCountry)
    emitted.current = meta.e164
    onChange(meta.e164, meta)
  }

  function handleInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.value
    if (international && !next.includes("+")) setInternational(false)
    setDisplay(next)
    if (international && next.includes("+")) {
      // El prefijo dice el país: el selector lo sigue mientras se escribe.
      const typed = readInternational(next)
      if (typed && typed.country !== country) {
        countryChosen.current = true
        setCountry(typed.country)
      }
    }
    emit(next, country)
  }

  /**
   * «+» al empezar a escribir: el campo pasa a recibir el número con su prefijo.
   * Se escucha en la envoltura, antes que la máscara nacional del campo (que lo
   * borraría); si ya hay dígitos, el «+» no cambia nada. Devuelve si lo tomó.
   */
  function takePlus(data: string, input: HTMLInputElement): boolean {
    if (international || !data.startsWith("+")) return false
    const whole = (input.selectionStart ?? 0) === 0 && (input.selectionEnd ?? 0) >= input.value.length
    if (phoneDigits(display) && !whole) return false
    const nextDisplay = `+${phoneDigits(data)}`
    setInternational(true)
    setDisplay(nextDisplay)
    emit(nextDisplay, country)
    return true
  }
  const takePlusRef = React.useRef(takePlus)
  takePlusRef.current = takePlus
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const listener = (event: Event) => {
      const input = event.target
      const data = (event as InputEvent).data ?? ""
      // Solo lo tecleado: lo pegado lo resuelve `handlePaste`.
      if (!(input instanceof HTMLInputElement) || (event as InputEvent).inputType !== "insertText") return
      if (!takePlusRef.current(data, input)) return
      event.preventDefault()
      event.stopPropagation()
    }
    // En captura: llega antes que el «beforeinput» de la máscara, que está en el campo.
    wrapper.addEventListener("beforeinput", listener, true)
    return () => wrapper.removeEventListener("beforeinput", listener, true)
  }, [])

  /** Al salir, el número con prefijo queda como siempre: el nacional, con su país en el selector. */
  function settleInternational() {
    if (!international) return
    const typed = readInternational(display)
    if (!typed) return
    setInternational(false)
    countryChosen.current = true
    setCountry(typed.country)
    setDisplay(maskNationalDigits(phoneDigits(nationalText(typed.e164)), typed.country))
  }

  function handleCountryChange(next: CountryCode) {
    if (next === country) return
    countryChosen.current = true
    setCountry(next)
    setInternational(false)
    let digits = phoneDigits(display)
    if (!digits) return
    // «44 7700 900878» escrito con otro país y luego Reino Unido: el prefijo no se repite.
    const withCode = readInternational(`+${digits}`)
    if (international || (withCode && getCountryCallingCode(withCode.country) === getCountryCallingCode(next) && !phoneMeta(display, country).isValid))
      digits = withCode ? phoneDigits(nationalText(withCode.e164)) : digits
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
    countryChosen.current = true
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
    ...(advisory ? { "data-advisory": "true" } : {}),
    disabled,
    value: display,
    onChange: handleInputChange,
    onPaste: handlePaste,
    onBlur: (event: React.FocusEvent<HTMLInputElement>) => {
      setTouched(true)
      settleInternational()
      onBlur?.(event)
    },
  }

  return (
    <div ref={wrapperRef} className={cn("flex w-full min-w-0 items-center gap-2", className)}>
      {showCountrySelect ? (
        <CountrySelect
          value={country}
          onChange={handleCountryChange}
          countries={countries}
          disabled={disabled}
          aria-label={common.phone.country}
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
