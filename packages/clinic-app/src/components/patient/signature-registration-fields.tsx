import { Input } from "@odentia/ui"
import { withFieldGroup } from "@odentia/ui-patterns"
import type { SignatureRegistration } from "../../lib/encounters"

const EMPTY_REGISTRATION: SignatureRegistration = {
  professionalTitle: "",
  registrationBody: "",
  registrationNumber: "",
}

/**
 * Sin colegiatura no se firma (ADR 0003: nombre y colegiatura en cada
 * atención): se pide donde se firma, sin salir, y se guarda en el perfil
 * profesional para las siguientes. Es el mismo bloque en el cierre de la
 * atención y en «Confirma que informaste» del consentimiento (QA del 16 nov):
 * el título solo se pide si el perfil no lo tiene; el colegio viene propuesto
 * por el país del producto (COP en odentIA, CMP en latidIA) y se puede
 * cambiar. Cada falta se dice en su campo.
 *
 * Va en el formulario que firma, con sus tres campos (`fields`): lo que diga
 * el servidor del perfil cae en el suyo.
 */
export const SignatureRegistrationFields = withFieldGroup({
  defaultValues: EMPTY_REGISTRATION,
  props: {} as {
    /** El nombre con que firma, de su cuenta o su perfil. */
    signAs: string | null
    askTitle: boolean
    disabled: boolean
    /** Qué pide el nombre y la colegiatura: la historia clínica, el consentimiento. */
    reason?: string
    /** El título del bloque; por omisión, «Falta tu colegiatura para firmar». */
    title?: string
    /**
     * La otra salida, dentro de la misma tarjeta y después de un «o»: en el cierre, firmar sin
     * ella escribiendo por qué (ADR 0200). Así las dos salidas se leen juntas.
     */
    orElse?: React.ReactNode
    /** El número es lo que falta escribir: ahí empieza el foco. */
    numberRef?: React.Ref<HTMLInputElement>
  },
  render: function SignatureRegistrationFieldsRender({
    group,
    signAs,
    askTitle,
    disabled,
    reason,
    title,
    orElse,
    numberRef,
  }) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-warning/50 bg-warning-soft p-3">
        <div className="flex flex-col">
          <p className="font-medium">{title ?? "Falta tu colegiatura para firmar"}</p>
          <p className="text-xs text-muted-foreground">
            {signAs ? `Firmarás como ${signAs}. ` : ""}
            {reason ?? "La historia clínica pide nombre y colegiatura."}
          </p>
        </div>
        {askTitle ? (
          <group.AppField name="professionalTitle">
            {(field) => (
              <field.TextField label="Título profesional" maxLength={120} disabled={disabled} />
            )}
          </group.AppField>
        ) : null}
        <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-start gap-3">
          <group.AppField name="registrationBody">
            {(field) => <field.TextField label="Colegio" maxLength={40} disabled={disabled} />}
          </group.AppField>
          <group.AppField name="registrationNumber">
            {(field) => (
              <field.Control
                label="Número de colegiatura"
                description="Se guarda en tu perfil profesional: no la volverá a pedir."
              >
                {(control) => (
                  <Input
                    {...control.props}
                    ref={numberRef}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={20}
                    disabled={disabled}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                )}
              </field.Control>
            )}
          </group.AppField>
        </div>
        {orElse ? (
          <>
            <p className="text-sm font-medium" aria-hidden>
              o
            </p>
            {orElse}
          </>
        ) : null}
      </div>
    )
  },
})

/** Los tres campos con el mismo nombre en el formulario que firma. */
export const REGISTRATION_FIELDS = {
  professionalTitle: "professionalTitle",
  registrationBody: "registrationBody",
  registrationNumber: "registrationNumber",
} as const
