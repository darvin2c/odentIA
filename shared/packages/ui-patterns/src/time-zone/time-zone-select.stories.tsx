import { Checkbox, Field, FieldDescription, FieldError, FieldLabel, Label } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import * as React from "react"
import { FormPanel } from "../form/form-panel.js"
import { DemoPage, DemoStage, demoSubmit } from "../story-fixtures.js"
import { detectedTimeZone, timeZoneMeta, zonesForCountry } from "./time-zone.js"
import { TimeZoneSelect } from "./time-zone-select.js"

/**
 * Zona horaria con búsqueda y valor canónico **IANA** (`America/Lima`), el mismo
 * que guardan `organization.timezone` y `branch.timezone`.
 *
 * Todo sale del runtime (`Intl`): las zonas del catálogo, el desfase (`GMT-5`),
 * la hora local y las zonas de un país (`Intl.Locale.timeZones`). La ciudad se
 * deriva del identificador (`America/Argentina/Buenos_Aires` → `Buenos Aires`),
 * así que se escribe sin tildes: la búsqueda las ignora, `bogota` y `Bogotá`
 * encuentran lo mismo. También se busca por identificador (`asia/tokyo`) y por
 * desfase (`gmt+5:45`).
 *
 * El campo elige **una** zona: la política de «heredar de la organización»
 * (sucursal con `timezone` en `null`) la compone la pantalla, como muestra la
 * historia de sucursal.
 */
const meta = {
  title: "Patrones/TimeZoneSelect",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** Lo que la pantalla recibe: la zona y su lectura en la fecha de referencia. */
function Lectura({ value, reference }: { value: string | null; reference?: Date }) {
  const meta = timeZoneMeta(value, reference)
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-2xl bg-card p-3 text-sm ring-1 ring-foreground/5">
      <dt className="text-muted-foreground">Valor que se guarda</dt>
      <dd className="font-medium">{value ?? "—"}</dd>
      <dt className="text-muted-foreground">Desfase</dt>
      <dd className="font-medium">{meta?.offsetLabel ?? "—"}</dd>
      <dt className="text-muted-foreground">Hora local</dt>
      <dd className="font-medium">{meta?.localTime ?? "—"}</dd>
    </dl>
  )
}

type DemoProps = {
  label?: string
  initialValue?: string | null
  suggested?: readonly string[]
  hint?: string
  referenceDate?: Date
  disabled?: boolean
  invalid?: boolean
}

function Demo({
  label = "Zona horaria",
  initialValue = null,
  suggested,
  hint,
  referenceDate,
  disabled = false,
  invalid = false,
}: DemoProps) {
  const [value, setValue] = React.useState<string | null>(initialValue)
  const id = React.useId()

  return (
    <div className="flex max-w-md flex-col gap-4">
      <Field>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <TimeZoneSelect
          id={id}
          aria-describedby={hint ? `${id}-help` : undefined}
          value={value}
          suggested={suggested}
          referenceDate={referenceDate}
          disabled={disabled}
          invalid={invalid}
          onChange={(next) => setValue(next)}
        />
        {hint ? <FieldDescription id={`${id}-help`}>{hint}</FieldDescription> : null}
      </Field>
      <Lectura value={value} reference={referenceDate} />
    </div>
  )
}

/** Las zonas del país de la organización encabezan la lista (Perú: una sola). */
export const ZonaDeLaOrganizacion: Story = {
  render: () => (
    <DemoPage>
      <Demo
        initialValue="America/Lima"
        suggested={[...zonesForCountry("PE"), detectedTimeZone() ?? ""].filter(Boolean)}
        hint="Escribe lima, america/lima o gmt-5: la búsqueda mira ciudad, identificador y desfase."
      />
    </DemoPage>
  ),
}

/** Un país con varias zonas las ofrece todas arriba, sin dejar de listar el resto. */
export const SugerenciasDelPais: Story = {
  render: () => (
    <DemoPage>
      <Demo
        suggested={zonesForCountry("AR")}
        hint="Argentina tiene doce zonas: encabezan la lista, pero cualquier otra sigue disponible."
      />
    </DemoPage>
  ),
}

/** La sucursal hereda de la organización: la política la pone la pantalla. */
export const SucursalQueHereda: Story = {
  render: function SucursalStory() {
    const [inherit, setInherit] = React.useState(true)
    const [value, setValue] = React.useState<string | null>("America/Lima")

    return (
      <DemoPage>
        <div className="flex max-w-md flex-col gap-4">
          <div className="flex items-center gap-3">
            <Checkbox
              id="tz-inherit"
              checked={inherit}
              onCheckedChange={(checked) => setInherit(checked === true)}
            />
            <Label htmlFor="tz-inherit">Usar la zona horaria de la organización</Label>
          </div>
          <Field>
            <FieldLabel htmlFor="tz-branch">Zona horaria de la sucursal</FieldLabel>
            <TimeZoneSelect
              id="tz-branch"
              value={value}
              disabled={inherit}
              suggested={zonesForCountry("PE")}
              onChange={(next) => setValue(next)}
            />
            <FieldDescription>
              {inherit
                ? "Sin zona propia: la sucursal usa la de la organización (se guarda en null)."
                : "Zona propia de esta sucursal."}
            </FieldDescription>
          </Field>
        </div>
      </DemoPage>
    )
  },
}

/** Desfase y hora local dependen de la fecha: la agenda pasa la fecha de la cita. */
export const FechaDeLaCita: Story = {
  render: () => (
    <DemoPage>
      <div className="flex max-w-md flex-col gap-8">
        <Demo
          label="Cita en enero (Madrid)"
          initialValue="Europe/Madrid"
          referenceDate={new Date("2026-01-15T12:00:00Z")}
        />
        <Demo
          label="Cita en julio (Madrid)"
          initialValue="Europe/Madrid"
          referenceDate={new Date("2026-07-15T12:00:00Z")}
        />
      </div>
    </DemoPage>
  ),
}

/** Un valor heredado con alias se muestra canonicalizado; uno inválido, vacío. */
export const DatosHeredados: Story = {
  render: () => (
    <DemoPage>
      <div className="flex max-w-md flex-col gap-8">
        <Demo
          label="Guardado como US/Pacific"
          initialValue="US/Pacific"
          referenceDate={new Date("2026-01-15T12:00:00Z")}
          hint="El alias se lee como America/Los_Angeles: el valor guardado no se esconde."
        />
        <Demo
          label="Guardado como «Lima» (no es una zona)"
          initialValue="Lima"
          hint="El campo queda vacío en vez de mostrar una zona inventada; la pantalla puede marcarlo."
        />
      </div>
    </DemoPage>
  ),
}

/** Estado de error, como lo pinta una pantalla con `FieldError`. */
export const ConError: Story = {
  render: () => (
    <DemoPage>
      <div className="flex max-w-md flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="tz-error">Zona horaria</FieldLabel>
          <TimeZoneSelect
            id="tz-error"
            value={null}
            invalid
            onChange={() => {}}
            aria-describedby="tz-error-message"
          />
          <FieldError id="tz-error-message">Elige una zona horaria</FieldError>
        </Field>
      </div>
    </DemoPage>
  ),
}

/** Dentro del formulario real: `FormPanel` de configuración de la organización. */
export const EnFormulario: Story = {
  render: function EnFormularioStory() {
    const [value, setValue] = React.useState<string | null>("America/Lima")

    return (
      <DemoStage className="max-w-md">
        <FormPanel
          title="Datos de la organización"
          description="Definen la agenda y los horarios de atención"
          isDirty={value !== "America/Lima"}
          onSubmit={demoSubmit}
          onClose={() => {}}
        >
          <Field>
            <FieldLabel htmlFor="tz-form">Zona horaria</FieldLabel>
            <TimeZoneSelect
              id="tz-form"
              value={value}
              suggested={zonesForCountry("PE")}
              onChange={(next) => setValue(next)}
            />
            <FieldDescription>
              Se usa para la agenda, los recordatorios y la fecha de cada atención.
            </FieldDescription>
          </Field>
        </FormPanel>
      </DemoStage>
    )
  },
}
