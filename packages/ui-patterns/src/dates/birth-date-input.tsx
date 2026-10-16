import type { MaskitoOptions } from "@maskito/core"
import { useMaskito } from "@maskito/react"
import { cn, Input } from "@odentia/ui"
import * as React from "react"
import { regionToday } from "../schedule/time.js"
import {
  ageText,
  clinicDateLocale,
  readWrittenDate,
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

  const options = React.useMemo(() => maskOptions(format), [format])
  const maskRef = useMaskito({ options })

  const reading = readWrittenDate(display, today, format)
  // A medias solo se avisa al salir; una fecha completa que no vale, enseguida.
  const showProblem =
    reading.problem !== null && (touched || reading.problem.kind !== "incompleta")
  const hint = showProblem && reading.problem
    ? writtenDateProblemText(reading.problem, format)
    : showAge && reading.iso
      ? ageText(reading.iso, today)
      : ""

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.value
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
 * fecha ISO pegada o autocompletada (`1995-07-30`) se pasa al orden del campo.
 */
function maskOptions(format: WrittenDateFormat): MaskitoOptions {
  return {
    mask: writtenDateMask(format),
    preprocessors: [
      ({ elementState, data }, actionType) => {
        if (actionType === "insert" && ISO_DATE.test(data.trim())) {
          return { elementState, data: writeDate(data.trim(), format) }
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
