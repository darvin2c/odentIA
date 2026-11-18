import { Field, FieldDescription, FieldError, FieldLabel, Input } from "@odentia/ui"
import type { Meta, StoryObj } from "@storybook/react"
import * as React from "react"
import { FormPanel } from "../form/form-panel.js"
import { DemoPage, DemoStage, demoSubmit } from "../story-fixtures.js"
import { countryLabel, countryOf, isValidE164, type PhoneMeta } from "./phone.js"
import { PhoneInput, type PhoneInputProps } from "./phone-input.js"

/**
 * Teléfono con máscara por país y valor canónico **E.164**.
 *
 * El texto que se ve lo formatea `@maskito/phone` con los metadatos de
 * `libphonenumber-js` (el mismo origen que valida el número); el valor que
 * emite es E.164, el formato que guarda `contact.phone`, el teléfono de la persona.
 * La lectura bajo cada campo muestra ese valor: es el contrato del componente.
 *
 * **El prefijo internacional lo lleva el selector de país**, no el teclado: el
 * campo muestra siempre el número nacional (`987 654 321`) junto a `PE +51`, y
 * su plantilla (ejemplo móvil del país) enseña la máscara antes de teclear.
 * Pegar un número con prefijo de otro país mueve el selector y deja los dígitos
 * nacionales; pegar uno del mismo país descarta el prefijo.
 *
 * El error lo dibuja la pantalla con `FieldError` según `isValidE164`; el
 * componente solo expone `invalid`. La validez es informativa: el servidor
 * sigue siendo autoritativo.
 */
const meta = {
  title: "Patrones/PhoneInput",
  parameters: { layout: "fullscreen" },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/**
 * Mismo criterio que una pantalla: hay error cuando lo escrito no es un
 * teléfono usable (incompleto o completo pero inválido).
 */
function phoneError(value: string | null, meta: PhoneMeta | null): string | null {
  if (!meta || meta.e164 === null) {
    return meta && meta.digits.length > 0 ? "Faltan dígitos del teléfono" : null
  }
  return isValidE164(value) ? null : "Teléfono inválido"
}

/** Lo que el formulario recibe del campo: el E.164, su validez y su país. */
function Lectura({ value }: { value: string | null }) {
  const country = value ? countryOf(value) : undefined
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-2xl bg-card p-3 text-sm ring-1 ring-foreground/5">
      <dt className="text-muted-foreground">E.164 que se guarda</dt>
      <dd className="font-medium">{value ?? "—"}</dd>
      <dt className="text-muted-foreground">Válido</dt>
      <dd className="font-medium">{value ? (isValidE164(value) ? "sí" : "no") : "—"}</dd>
      <dt className="text-muted-foreground">País</dt>
      <dd className="font-medium">{country ? `${countryLabel(country)} (${country})` : "—"}</dd>
    </dl>
  )
}

type DemoProps = Partial<PhoneInputProps> & {
  label?: string
  initialValue?: string | null
  hint?: string
}

function Demo({ label = "Teléfono", initialValue = null, hint, ...props }: DemoProps) {
  const [value, setValue] = React.useState<string | null>(initialValue)
  const [meta, setMeta] = React.useState<PhoneMeta | null>(null)
  const error = phoneError(value, meta)

  return (
    <div className="flex max-w-md flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="phone-demo">{label}</FieldLabel>
        <PhoneInput
          id="phone-demo"
          {...props}
          value={value}
          invalid={error !== null}
          aria-describedby={error ? "phone-demo-error" : undefined}
          onChange={(next, nextMeta) => {
            setValue(next)
            setMeta(nextMeta)
          }}
        />
        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
        <FieldError id="phone-demo-error">{error}</FieldError>
      </Field>
      <Lectura value={value} />
    </div>
  )
}

/**
 * Máscara nacional peruana. La plantilla del campo sale del ejemplo móvil
 * oficial del país, y el prefijo lo lleva el selector.
 */
export const NacionalPeru: Story = {
  render: () => (
    <DemoPage>
      <Demo hint="Escribe 987654321: la máscara agrupa sola. El prefijo +51 lo pone el selector; no se teclea." />
    </DemoPage>
  ),
}

/** Pegar un número con prefijo de otro país mueve el selector y conserva sus dígitos. */
export const PegadoDeOtroPais: Story = {
  render: () => (
    <DemoPage>
      <Demo
        initialValue="+5491123456789"
        hint="Pega un número con prefijo (por ejemplo +54 9 11 2345 6789) y el selector pasa a Argentina."
      />
    </DemoPage>
  ),
}

/** `countries` acota el selector cuando la organización atiende unos pocos países. */
export const SelectorAcotado: Story = {
  render: () => (
    <DemoPage>
      <Demo defaultCountry="PE" countries={["PE", "CL", "AR"]} />
    </DemoPage>
  ),
}

/** `showCountrySelect={false}`: una sola región, con el prefijo dentro del campo. */
export const SinSelector: Story = {
  render: () => (
    <DemoPage>
      <Demo
        defaultCountry="PE"
        showCountrySelect={false}
        hint="Sin selector, el prefijo se muestra dentro del campo para no dejarlo invisible."
      />
    </DemoPage>
  ),
}

/** Estado de error y campo deshabilitado, como los pinta una pantalla. */
export const ConError: Story = {
  render: () => (
    <DemoPage>
      <div className="flex max-w-md flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="phone-error">Teléfono</FieldLabel>
          <PhoneInput
            id="phone-error"
            value="+5191234567"
            invalid
            onChange={() => {}}
            aria-describedby="phone-error-message"
          />
          <FieldError id="phone-error-message">Teléfono inválido</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="phone-disabled">Teléfono (bloqueado)</FieldLabel>
          <PhoneInput id="phone-disabled" value="+51987654321" disabled onChange={() => {}} />
        </Field>
      </div>
    </DemoPage>
  ),
}

/** El formulario completo: el campo valida y Guardar no acepta un teléfono a medias. */
export const EnFormulario: Story = {
  render: function EnFormularioStory() {
    const [value, setValue] = React.useState<string | null>("+51999888777")
    const [meta, setMeta] = React.useState<PhoneMeta | null>(null)
    const error = phoneError(value, meta)

    return (
      <DemoStage className="max-w-md">
        <FormPanel
          title="Editar paciente"
          description="Rosa Quispe"
          isDirty={value !== "+51999888777"}
          submitDisabled={error !== null}
          onSubmit={demoSubmit}
          onClose={() => {}}
        >
          <Field>
            <FieldLabel htmlFor="phone-form">Teléfono</FieldLabel>
            <PhoneInput
              id="phone-form"
              value={value}
              invalid={error !== null}
              aria-describedby={error ? "phone-form-error" : undefined}
              onChange={(next, nextMeta) => {
                setValue(next)
                setMeta(nextMeta)
              }}
            />
            <FieldDescription>
              Es también el identificador de WhatsApp: se guarda en formato internacional (E.164).
            </FieldDescription>
            <FieldError id="phone-form-error">{error}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="phone-form-notes">Notas</FieldLabel>
            <Input id="phone-form-notes" placeholder="Sin datos" />
          </Field>
        </FormPanel>
      </DemoStage>
    )
  },
}
