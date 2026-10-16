import { Field, FieldDescription, FieldLabel } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import * as React from "react"
import { DatePickerButton } from "../date-picker-button.js"
import { setFormatRegion } from "../locale.js"
import { DemoPage } from "../story-fixtures.js"
import { BirthDateInput, PastDateInput } from "./birth-date-input.js"
import { DueAtField } from "./due-at-field.js"
import { TimeSelect } from "./time-select.js"

/**
 * Los cuatro controles de fecha y hora de la aplicación. Ninguna pantalla usa
 * los campos de fecha u hora del navegador, que escriben día/mes o mes/día y
 * 24 o 12 horas según el equipo.
 *
 * - **Fecha de nacimiento**: se escribe en el orden de la clínica, sin
 *   calendario, con la edad debajo. Sin edad, para las fechas pasadas de los
 *   antecedentes.
 * - **Día**: el calendario estándar con el mes y el año en lista y el año
 *   escrito en el botón. Un periodo son dos «Día», el segundo con mínimo.
 * - **Día y hora**: lo que vence, en la zona de la clínica.
 * - **Hora**: una lista cada 15 minutos, como en la Agenda.
 *
 * La lectura bajo cada campo es lo que recibe el formulario: siempre ISO 8601.
 */
const meta = {
  title: "Patrones/Fechas",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function Lectura({ value }: { value: string | null }) {
  return (
    <p className="text-sm text-muted-foreground">
      Se guarda: <span className="font-medium text-foreground tabular-nums">{value || "—"}</span>
    </p>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="flex max-w-md flex-col gap-4 rounded-2xl bg-card p-5 ring-1 ring-foreground/5">{children}</div>
}

/** Recepción escribe 30071995 y el campo muestra «30/07/1995 · 31 años». */
export const FechaDeNacimiento: Story = {
  render: () => {
    function Demo() {
      const [value, setValue] = React.useState("1995-07-30")
      return (
        <Card>
          <Field>
            <FieldLabel htmlFor="nacimiento">Fecha de nacimiento</FieldLabel>
            <BirthDateInput id="nacimiento" value={value} onChange={setValue} />
          </Field>
          <Lectura value={value} />
        </Card>
      )
    }
    return (
      <DemoPage>
        <Demo />
      </DemoPage>
    )
  },
}

/** El mismo campo en una clínica de Estados Unidos: mes/día/año. */
export const FechaDeNacimientoOtroFormato: Story = {
  render: () => {
    function Demo() {
      React.useState(() => setFormatRegion({ locale: "en-US", timeZone: "America/New_York" }))
      React.useEffect(() => () => setFormatRegion({}), [])
      const [value, setValue] = React.useState("1995-07-30")
      return (
        <Card>
          <Field>
            <FieldLabel htmlFor="nacimiento-us">Fecha de nacimiento</FieldLabel>
            <BirthDateInput id="nacimiento-us" value={value} onChange={setValue} />
          </Field>
          <Lectura value={value} />
        </Card>
      )
    }
    return (
      <DemoPage>
        <Demo />
      </DemoPage>
    )
  },
}

/** Una fecha futura o un día que no existe se dicen en palabras, junto al campo. */
export const FechaConError: Story = {
  render: () => {
    function Demo() {
      const [future, setFuture] = React.useState("01/01/2099")
      const [missing, setMissing] = React.useState("31/02/1990")
      return (
        <Card>
          <Field>
            <FieldLabel htmlFor="futura">Fecha de nacimiento</FieldLabel>
            <BirthDateInput id="futura" value={future} onChange={setFuture} />
          </Field>
          <Field>
            <FieldLabel htmlFor="no-existe">Fecha de nacimiento</FieldLabel>
            <BirthDateInput id="no-existe" value={missing} onChange={setMissing} />
          </Field>
        </Card>
      )
    }
    return (
      <DemoPage>
        <Demo />
      </DemoPage>
    )
  },
}

/** Sin la edad, para el inicio o el fin de una enfermedad o un medicamento. */
export const FechaPasada: Story = {
  render: () => {
    function Demo() {
      const [start, setStart] = React.useState("2024-03-01")
      const [end, setEnd] = React.useState("")
      return (
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="inicio">Inicio</FieldLabel>
              <PastDateInput id="inicio" value={start} onChange={setStart} />
            </Field>
            <Field>
              <FieldLabel htmlFor="fin">Fin (vacío = activa)</FieldLabel>
              <PastDateInput id="fin" value={end} onChange={setEnd} />
            </Field>
          </div>
          <Lectura value={[start, end].filter(Boolean).join(" → ")} />
        </Card>
      )
    }
    return (
      <DemoPage>
        <Demo />
      </DemoPage>
    )
  },
}

/** «Día»: el calendario de siempre, con mes y año en lista; el botón escribe el año. */
export const Dia: Story = {
  render: () => {
    function Demo() {
      const [value, setValue] = React.useState("2026-11-20")
      const [optional, setOptional] = React.useState("")
      return (
        <Card>
          <Field>
            <FieldLabel htmlFor="dia">Fecha de toma</FieldLabel>
            <DatePickerButton id="dia" className="w-56" value={value} onChange={setValue} />
          </Field>
          <Field>
            <FieldLabel htmlFor="opcional">Válida hasta (opcional)</FieldLabel>
            <DatePickerButton
              id="opcional"
              className="w-56"
              value={optional}
              emptyLabel="Sin fecha"
              onChange={setOptional}
            />
            <FieldDescription>Opcional: el calendario ofrece quitarla.</FieldDescription>
          </Field>
          <Lectura value={[value, optional].filter(Boolean).join(" · ")} />
        </Card>
      )
    }
    return (
      <DemoPage>
        <Demo />
      </DemoPage>
    )
  },
}

/** Un periodo dentro de un formulario: dos «Día», el segundo no antes del primero. */
export const Periodo: Story = {
  render: () => {
    function Demo() {
      const [from, setFrom] = React.useState("2026-10-16")
      const [until, setUntil] = React.useState("")
      return (
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="desde">Vale desde</FieldLabel>
              <DatePickerButton
                id="desde"
                value={from}
                emptyLabel="Siempre"
                onChange={(next) => {
                  setFrom(next)
                  if (until && next && until < next) setUntil(next)
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="hasta">Vale hasta</FieldLabel>
              <DatePickerButton
                id="hasta"
                value={until}
                min={from || undefined}
                emptyLabel="Sin vencimiento"
                onChange={setUntil}
              />
            </Field>
          </div>
          <Lectura value={`${from || "siempre"} → ${until || "sin vencimiento"}`} />
        </Card>
      )
    }
    return (
      <DemoPage>
        <Demo />
      </DemoPage>
    )
  },
}

/** «Día y hora»: cuándo vence una tarea, en la zona de la clínica. */
export const DiaYHora: Story = {
  render: () => {
    function Demo() {
      const [value, setValue] = React.useState<string | null>(null)
      return (
        <Card>
          <DueAtField value={value} onChange={setValue} description="Al elegir solo el día, vence a las 9:00." />
          <Lectura value={value} />
        </Card>
      )
    }
    return (
      <DemoPage>
        <Demo />
      </DemoPage>
    )
  },
}

/** «Hora»: cada 15 minutos; una hora guardada fuera del paso (10:35) se conserva. */
export const Hora: Story = {
  render: () => {
    function Demo() {
      const [from, setFrom] = React.useState("08:00")
      const [until, setUntil] = React.useState("10:35")
      const [end, setEnd] = React.useState("")
      return (
        <Card>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="hora-desde">Desde</FieldLabel>
              <TimeSelect id="hora-desde" className="w-full" value={from} onChange={setFrom} />
            </Field>
            <Field>
              <FieldLabel htmlFor="hora-hasta">Hasta</FieldLabel>
              <TimeSelect id="hora-hasta" className="w-full" value={until} onChange={setUntil} />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="hora-fin">Hora de fin</FieldLabel>
            <TimeSelect
              id="hora-fin"
              className="w-44"
              min="09:00"
              max="10:35"
              emptyLabel="Ahora (10:35)"
              value={end}
              onChange={setEnd}
            />
          </Field>
          <Lectura value={[from, until, end || "ahora"].join(" · ")} />
        </Card>
      )
    }
    return (
      <DemoPage>
        <Demo />
      </DemoPage>
    )
  },
}
