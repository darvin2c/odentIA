import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId } from "react"
import { z } from "zod"
import {
  type ProfessionalProfile,
  type ProfessionalProfileInput,
  saveProfessionalProfileApi,
} from "../lib/encounters"
import { useOrgProfile } from "../lib/org"
import { productUi } from "../product/product-ui"

/** Colegiatura: letras, dígitos y guion, sin espacios (como `REGISTRATION_RE` del servicio). */
const REGISTRATION_RE = /^[A-Za-z0-9-]{1,20}$/

// Los mismos topes que `profileInput` de la API.
const profileSchema = z.object({
  signatureName: z.string().max(200, "El nombre de firma admite hasta 200 caracteres."),
  professionalTitle: z
    .string()
    .trim()
    .min(1, "Escribe el título profesional.")
    .max(120, "El título profesional admite hasta 120 caracteres."),
  registrationBody: z
    .string()
    .trim()
    .min(1, "Escribe el colegio profesional.")
    .max(40, "El colegio profesional admite hasta 40 caracteres."),
  registrationNumber: z
    .string()
    .trim()
    .refine((value) => !value || REGISTRATION_RE.test(value), "Solo letras, dígitos y guion, sin espacios."),
  specialtyRegistration: z.string().max(40, "El registro de especialista admite hasta 40 caracteres."),
})

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
  // Lo que propone el país para el producto (odentIA: «Cirujano dentista» y el COP en Perú).
  const suggested = productUi().country.professional(useOrgProfile().data?.countryCode)
  const save = useMutation({
    mutationFn: (input: ProfessionalProfileInput) => saveProfessionalProfileApi(target, input),
  })
  const form = useAppForm({
    defaultValues: {
      signatureName: profile?.signatureName ?? "",
      professionalTitle: profile?.professionalTitle || suggested?.title || "",
      registrationBody: profile?.registrationBody || suggested?.registrationBody || "",
      registrationNumber: profile?.registrationNumber ?? "",
      specialtyRegistration: profile?.specialtyRegistration ?? "",
    },
    validators: { onSubmit: profileSchema },
    onSubmit: async ({ value }) => {
      const result = await save.mutateAsync({
        signatureName: value.signatureName.trim() || null,
        professionalTitle: value.professionalTitle.trim(),
        registrationBody: value.registrationBody.trim(),
        registrationNumber: value.registrationNumber.trim() || null,
        specialtyRegistration: value.specialtyRegistration.trim() || null,
      })
      await queryClient.invalidateQueries({ queryKey: ["professional-profile"] })
      await queryClient.invalidateQueries({ queryKey: ["professional-profiles"] })
      await queryClient.invalidateQueries({ queryKey: ["encounter-closing"] })
      onSaved?.(result.data)
      onClose()
    },
  })
  // El país de la clínica puede llegar después de abrir: lo que sigue vacío
  // toma su propuesta, sin contarlo como un cambio de quien edita.
  useEffect(() => {
    if (!suggested) return
    if (!form.getFieldValue("professionalTitle"))
      form.setFieldValue("professionalTitle", suggested.title, { dontUpdateMeta: true })
    if (!form.getFieldValue("registrationBody"))
      form.setFieldValue("registrationBody", suggested.registrationBody, { dontUpdateMeta: true })
  }, [suggested, form])
  const surface = useFormSurface(form)

  return (
    <FormDrawer
      {...surface}
      open={open}
      title="Perfil profesional"
      description="Con estos datos firmas atenciones, recetas, consentimientos y documentos clínicos."
      onClose={onClose}
      submitLabel="Guardar perfil"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <form.AppField name="signatureName">
          {(field) => (
            <field.TextField
              id={`${uid}-name`}
              className="sm:col-span-2"
              label="Nombre de firma"
              description="Si lo dejas vacío se usa el nombre de tu cuenta."
              maxLength={200}
              placeholder={profile?.accountName ?? ""}
            />
          )}
        </form.AppField>
        <form.AppField name="professionalTitle">
          {(field) => (
            <field.TextField
              id={`${uid}-title`}
              className="sm:col-span-2"
              label="Título profesional"
              description="Como figura en tu título; aparece junto a tu firma."
              maxLength={120}
            />
          )}
        </form.AppField>
        <form.AppField name="registrationBody">
          {(field) => (
            <field.TextField
              id={`${uid}-body`}
              label="Colegio profesional"
              description="El colegio u organismo que emite tu registro, con el nombre o las siglas con que firmas."
              maxLength={40}
            />
          )}
        </form.AppField>
        <form.AppField name="registrationNumber">
          {(field) => (
            <field.TextField
              id={`${uid}-number`}
              label="Número de colegiatura"
              description="Obligatorio para firmar el cierre de una atención."
              maxLength={20}
              inputMode="text"
            />
          )}
        </form.AppField>
        <form.AppField name="specialtyRegistration">
          {(field) => (
            <field.TextField
              id={`${uid}-rne`}
              className="sm:col-span-2"
              label="Registro de especialista (opcional)"
              maxLength={40}
            />
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}
