import { Field, FieldDescription, FieldLabel, Input } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { ApiError } from "../lib/api"
import {
  type ProfessionalProfile,
  type ProfessionalProfileInput,
  saveProfessionalProfileApi,
} from "../lib/encounters"
import { useDentalProfile } from "../lib/org"

/**
 * Perfil profesional: nombre de firma, título y colegiatura. Es la identidad
 * con la que se firman atenciones, recetas, consentimientos y, en clínicas de
 * Perú, el odontograma (nadie escribe su nombre a mano al firmar); cada
 * documento guarda su copia, así que cambiarlo no reescribe lo ya firmado.
 * Título y colegio no tienen valor por defecto: si están vacíos se proponen
 * los del país de la clínica cuando los hay (`dentalProfileFor().professional`,
 * «Cirujano dentista» y «COP» solo en Perú), a la vista y editables.
 */
export function ProfessionalProfileDrawer({
  open,
  profile,
  target,
  onClose,
  onSaved,
}: {
  open: boolean
  profile: ProfessionalProfile | null
  /** «me» para el propio perfil; el id del usuario para administración. */
  target: string
  onClose: () => void
  onSaved?: (profile: ProfessionalProfile) => void
}): React.JSX.Element {
  const uid = useId()
  const queryClient = useQueryClient()
  const suggested = useDentalProfile().professional
  const [values, setValues] = useState<Required<ProfessionalProfileInput>>(() => ({
    signatureName: profile?.signatureName ?? "",
    professionalTitle: profile?.professionalTitle || suggested?.title || "",
    registrationBody: profile?.registrationBody || suggested?.registrationBody || "",
    registrationNumber: profile?.registrationNumber ?? "",
    specialtyRegistration: profile?.specialtyRegistration ?? "",
  }))
  const [dirty, setDirty] = useState(false)
  // El país de la clínica puede llegar después de abrir: lo vacío toma su propuesta.
  useEffect(() => {
    if (!suggested) return
    setValues((prev) => ({
      ...prev,
      professionalTitle: prev.professionalTitle || suggested.title,
      registrationBody: prev.registrationBody || suggested.registrationBody,
    }))
  }, [suggested])
  const set = (key: keyof ProfessionalProfileInput, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }
  const save = useMutation({
    mutationFn: () =>
      saveProfessionalProfileApi(target, {
        signatureName: values.signatureName?.trim() || null,
        professionalTitle: values.professionalTitle?.trim(),
        registrationBody: values.registrationBody?.trim(),
        registrationNumber: values.registrationNumber?.trim() || null,
        specialtyRegistration: values.specialtyRegistration?.trim() || null,
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["professional-profile"] })
      await queryClient.invalidateQueries({ queryKey: ["professional-profiles"] })
      await queryClient.invalidateQueries({ queryKey: ["encounter-closing"] })
      setDirty(false)
      onSaved?.(result.data)
      onClose()
    },
  })
  const error =
    save.error instanceof ApiError
      ? save.error.shape.message
      : save.error
        ? "No se pudo guardar el perfil profesional."
        : null
  const registrationValid =
    !values.registrationNumber || /^[A-Za-z0-9-]{1,20}$/.test(values.registrationNumber.trim())

  return (
    <FormDrawer
      open={open}
      title="Perfil profesional"
      description="Con estos datos firmas atenciones, recetas, consentimientos y documentos clínicos."
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        if (registrationValid) save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty={dirty}
      error={error}
      submitDisabled={
        !registrationValid || !values.professionalTitle?.trim() || !values.registrationBody?.trim()
      }
      submitLabel="Guardar perfil"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={`${uid}-name`}>Nombre de firma</FieldLabel>
          <Input
            id={`${uid}-name`}
            maxLength={200}
            placeholder={profile?.accountName ?? ""}
            value={values.signatureName ?? ""}
            onChange={(event) => set("signatureName", event.target.value)}
          />
          <FieldDescription>Si lo dejas vacío se usa el nombre de tu cuenta.</FieldDescription>
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={`${uid}-title`}>Título profesional</FieldLabel>
          <Input
            id={`${uid}-title`}
            maxLength={120}
            required
            aria-describedby={`${uid}-title-help`}
            value={values.professionalTitle ?? ""}
            onChange={(event) => set("professionalTitle", event.target.value)}
          />
          <FieldDescription id={`${uid}-title-help`}>
            Como figura en tu título; aparece junto a tu firma.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${uid}-body`}>Colegio profesional</FieldLabel>
          <Input
            id={`${uid}-body`}
            maxLength={40}
            required
            aria-describedby={`${uid}-body-help`}
            value={values.registrationBody ?? ""}
            onChange={(event) => set("registrationBody", event.target.value)}
          />
          <FieldDescription id={`${uid}-body-help`}>
            El colegio u organismo que emite tu registro, con el nombre o las siglas con que firmas.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${uid}-number`}>Número de colegiatura</FieldLabel>
          <Input
            id={`${uid}-number`}
            maxLength={20}
            inputMode="text"
            aria-invalid={!registrationValid}
            aria-describedby={`${uid}-number-help`}
            value={values.registrationNumber ?? ""}
            onChange={(event) => set("registrationNumber", event.target.value)}
          />
          <FieldDescription id={`${uid}-number-help`}>
            {registrationValid
              ? "Obligatorio para firmar el cierre de una atención."
              : "Solo letras, dígitos y guion, sin espacios."}
          </FieldDescription>
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={`${uid}-rne`}>Registro de especialista (opcional)</FieldLabel>
          <Input
            id={`${uid}-rne`}
            maxLength={40}
            value={values.specialtyRegistration ?? ""}
            onChange={(event) => set("specialtyRegistration", event.target.value)}
          />
        </Field>
      </div>
    </FormDrawer>
  )
}
