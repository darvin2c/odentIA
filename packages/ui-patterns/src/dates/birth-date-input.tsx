import type { MaskitoOptions } from "@maskito/core"
import { useMaskito } from "@maskito/react"
import { cn, Input } from "@odentia/ui"
import * as React from "react"
import { regionToday } from "../schedule/time.js"
import {
  ageText,
  clinicDateLocale,
  padWrittenDate,
  padWrittenPart,
  readWrittenDate,
  yearFirstDate,
  TYPED_DATE_SEPARATOR,
  type WrittenDateFormat,
  type WrittenDateReading,
  writeDate,
  writtenDateFormat,
  writtenDateMask,
  writtenDateProblemText,
} from "./written-date.js"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface BirthDateInputProps {
  /**
   * Fecha ISO 8601 (`1995-07-30`), vacío, o lo escrito tal cual mientras no
   * sea una fecha válida (ver `onChange`).
   */
  value: string
  /**
   * Recibe la fecha ISO cuando lo escrito es una fecha válida, `""` si se
   * borró y, mientras no lo sea (a medias, un día que no existe, una fecha
   * futura), el texto tal cual: así el formulario o el servidor lo rechazan en
   * vez de guardar nada en silencio. `reading` dice por qué no vale.
   */
  onChange: (value: string, reading: WrittenDateReading) => void
  /** La edad debajo («31 años»). Sin ella, el campo sirve para cualquier fecha pasada. */
  showAge?: boolean
  /** «Hoy» (`yyyy-mm-dd`) si lo da el servidor; si no, el de la zona de la clínica. */
  today?: string
  /**
   * País de la clínica, para una página pública que aún no fijó su formato
   * (`setFormatRegion`): el orden sale del formato probable de ese país.
   */
  country?: string | null
  id?: string
  name?: string
  disabled?: boolean
  required?: boolean
  /** El error lo dice la pantalla: el campo solo se marca. */
  invalid?: boolean
  /**
   * La pantalla ya dice el problema de la fecha con las mismas palabras (`writtenDateProblemText`):
   * el campo no lo repite debajo. Sin esto, una fecha imposible decía dos cosas a la vez.
   */
  problemOutside?: boolean
  className?: string
  onBlur?: React.FocusEventHandler<HTMLInputElement>
  "aria-label"?: string
  "aria-describedby"?: string
}

/**
 * «Fecha de nacimiento»: se escribe en el orden del formato de la clínica
 * (30/07/1995 en Perú, 07/30/1995 en Estados Unidos), sin calendario, como
 * recomiendan las guías de diseño para las fechas que uno recuerda. Los
 * separadores los pone el campo. Debajo dice la edad o, si algo no cuadra,
 * qué arreglar. No acepta fechas futuras y guarda en ISO 8601.
 *
 * Con `showAge={false}` (o `PastDateInput`) sirve para las demás fechas
 * pasadas que uno escribe: el inicio o el fin de una enfermedad o de un
 * medicamento.
 */
export function BirthDateInput({
  value,
  onChange,
  showAge = true,
  today: todayProp,
  country,
  id,
  name,
  disabled = false,
  required,
  invalid = false,
  problemOutside = false,
  className,
  onBlur,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}: BirthDateInputProps) {
  const format = writtenDateFormat(clinicDateLocale(country))
  const today = todayProp ?? regionToday()
  const [display, setDisplay] = React.useState(() => writeDate(value, format))
  const [touched, setTouched] = React.useState(false)
  // Último valor emitido: si el formulario lo devuelve igual, no se repinta lo
  // que la persona está escribiendo.
  const emitted = React.useRef(value)
  const hintId = React.useId()

  React.useEffect(() => {
    if (value === emitted.current) return
    emitted.current = value
    setDisplay(writeDate(value, format))
  }, [value, format])

  // Se empezó por el año («1990-…»): sus ocho números se leen como año, mes y día.
  const yearFirst = React.useRef(false)
  // Ya tecleó un separador: quien escribe «12/10/…» nunca empezó por el año.
  const typedSeparator = React.useRef(false)
  const options = React.useMemo(
    () =>
      maskOptions(format, {
        startYearFirst: () => {
          yearFirst.current = true
        },
        isYearFirst: () => yearFirst.current,
        separatorTyped: () => {
          const before = typedSeparator.current
          typedSeparator.current = true
          return before
        },
      }),
    [format],
  )
  const maskRef = useMaskito({ options })

  const reading = readWrittenDate(display, today, format)
  // A medias (o con el año en dos números, que puede seguir) solo se avisa al salir; una fecha
  // completa que no vale, enseguida.
  const showProblem =
    reading.problem !== null && (touched || (reading.problem.kind !== "incompleta" && reading.problem.kind !== "anio-corto"))
  const hint = showProblem && reading.problem
    ? problemOutside
      ? ""
      : writtenDateProblemText(reading.problem, format)
    : showAge && reading.iso
      ? ageText(reading.iso, today)
      : ""

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    let next = event.target.value
    if (next.replace(/\D/g, "") === "") {
      yearFirst.current = false
      typedSeparator.current = false
    }
    if (yearFirst.current) {
      const turned = yearFirstDate(next, format)
      if (turned !== null) {
        next = turned
        yearFirst.current = false
      }
    }
    setDisplay(next)
    const nextReading = readWrittenDate(next, today, format)
    const out = nextReading.iso ?? (nextReading.empty ? "" : next)
    emitted.current = out
    onChange(out, nextReading)
  }

  return (
    <div className={cn("grid min-w-0 gap-1", className)}>
      <Input
        ref={maskRef}
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete={showAge ? "bday" : "off"}
        placeholder={format.placeholder}
        value={display}
        disabled={disabled}
        required={required}
        aria-label={ariaLabel}
        aria-invalid={invalid || showProblem || undefined}
        aria-describedby={[describedBy, hint ? hintId : undefined].filter(Boolean).join(" ") || undefined}
        onChange={handleChange}
        onBlur={(event) => {
          setTouched(true)
          // «1990-4-3»: con el año primero, el día de un número lleva su cero al salir.
          if (yearFirst.current && display.replace(/\D/g, "").length === 7) {
            const turned = yearFirstDate(`${display.slice(0, -1)}0${display.slice(-1)}`, format)
            if (turned !== null) {
              yearFirst.current = false
              setDisplay(turned)
              const turnedReading = readWrittenDate(turned, today, format)
              const out = turnedReading.iso ?? turned
              emitted.current = out
              onChange(out, turnedReading)
            }
          }
          onBlur?.(event)
        }}
      />
      {hint ? (
        <p
          id={hintId}
          className={cn("text-sm", showProblem ? "text-destructive" : "text-muted-foreground")}
        >
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** Una fecha pasada que uno escribe, sin la edad: el mismo campo que `BirthDateInput`. */
export function PastDateInput(props: Omit<BirthDateInputProps, "showAge">) {
  return <BirthDateInput {...props} showAge={false} />
}

/**
 * Máscara del campo: dígitos y separadores fijos en el orden de la clínica. Una
 * fecha ISO pegada o autocompletada (`1995-07-30`) se pasa al orden del campo, y
 * la escrita como se dice, con barras y sin ceros («3/4/1990»), se completa.
 */
function maskOptions(
  format: WrittenDateFormat,
  yearFirst: { startYearFirst: () => void; isYearFirst: () => boolean; separatorTyped: () => boolean },
): MaskitoOptions {
  return {
    mask: writtenDateMask(format),
    preprocessors: [
      ({ elementState, data }, actionType) => {
        if (actionType === "insert" && ISO_DATE.test(data.trim())) {
          return { elementState, data: writeDate(data.trim(), format) }
        }
        if (actionType === "insert") {
          const whole = padWrittenDate(data, format)
          if (whole) return { elementState, data: whole }
          const [from, to] = elementState.selection
          const atEnd = from === to && to === elementState.value.length
          if (atEnd && data.length === 1 && TYPED_DATE_SEPARATOR.test(data)) {
            // «1990-»: cuatro números de corrido y un guion, el primer separador tecleado, son un año
            // (como en ISO 8601). El campo ya puso su barra («19/90»): lo demás se lee como mes y
            // día al completar los ocho. Quien escribe «12/10/…» tecleó antes su barra: no cambia.
            const digits = elementState.value.replace(/\D/g, "")
            const yearAt = format.order.indexOf("year")
            const firstSeparator = !yearFirst.separatorTyped()
            if (yearAt !== 0 && firstSeparator && data === "-" && digits.length === 4) {
              yearFirst.startYearFirst()
              return { elementState, data: "" }
            }
            // Con el año primero, el mes de un número lleva su cero («1990-4-» → mes 04).
            if (yearFirst.isYearFirst()) {
              if (digits.length !== 5) return { elementState, data: "" }
              // Se vuelve a escribir su número detrás de un cero: así el campo lo toma como tecleado.
              const value = `${elementState.value.slice(0, -1)}0`
              return { elementState: { value, selection: [value.length, value.length] }, data: elementState.value.slice(-1) }
            }
            // El separador que teclee (barra, guion, punto, espacio) vale por el del campo.
            const padded = padWrittenPart(elementState.value, format)
            return padded === null
              ? { elementState, data: format.separator }
              : { elementState: { value: padded, selection: [padded.length, padded.length] }, data: format.separator }
          }
        }
        if (actionType === "validation" && ISO_DATE.test(elementState.value.trim())) {
          const written = writeDate(elementState.value.trim(), format)
          return { elementState: { value: written, selection: [written.length, written.length] }, data }
        }
        return { elementState, data }
      },
    ],
  }
}
