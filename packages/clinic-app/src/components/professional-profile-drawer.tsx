import { Button } from "@odentia/ui"
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { z } from "zod"
import {
  fetchMyProfessionalProfile,
  type ProfessionalProfile,
  type ProfessionalProfileInput,
  saveProfessionalProfileApi,
} from "../lib/encounters"
import { useOrgProfile } from "../lib/org"
import { productUi } from "../product/product-ui"
import { FirmaPad, FirmaView } from "./patient/firma-pad"

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
  // Sin el dato no cambia; nulo es que la quita; con trazos, la nueva.
  signatureStrokes: z.custom<number[][][] | null | undefined>(),
})

/**
 * «Tu firma»: el dibujo que se ve en los papeles (ADR 0131), solo en el perfil
 * propio. Se dibuja una vez y sale sola; lo que ya está emitido no cambia.
 */
function SignatureField({
  saved,
  loading,
  failed,
  onRetry,
  value,
  onChange,
  id,
  invalid,
  describedBy,
}: {
  saved: number[][][] | null
  loading: boolean
  failed: boolean
  onRetry: () => void
  value: number[][][] | null | undefined
  onChange: (value: number[][][] | null | undefined) => void
  id: string
  invalid: boolean
  describedBy: string | undefined
}): React.JSX.Element {
  const [changing, setChanging] = useState(false)
  if (loading) return <p className="text-sm text-muted-foreground">Buscando tu firma…</p>
  if (failed)
    return (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-sm">
        No se pudo leer tu firma.
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          Reintentar
        </Button>
      </p>
    )
  if (value === null)
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm">
        Se quitará al guardar: tus papeles saldrán con una línea para firmar a mano.
        <Button type="button" size="sm" variant="outline" onClick={() => onChange(undefined)}>
          Deshacer
        </Button>
      </p>
    )
  if (saved && !changing)
    return (
      <div className="flex flex-col gap-2">
        <FirmaView strokes={saved} label="Tu firma guardada" />
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setChanging(true)}>
            Cambiar
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onChange(null)}>
            Quitar
          </Button>
        </div>
      </div>
    )
  return (
    <div className="flex flex-col gap-2">
      <FirmaPad
        id={id}
        invalid={invalid}
        describedBy={describedBy}
        label="Dibuja tu firma"
        onChange={(strokes) => onChange(strokes.length > 0 ? strokes : undefined)}
      />
      {saved ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => {
            setChanging(false)
            onChange(undefined)
          }}
        >
          Dejar la que tenía
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Perfil profesional: nombre de firma, título y colegiatura. Es la identidad
 * con la que se firman atenciones, recetas, consentimientos y, en clínicas de
 * Perú, el odontograma (nadie escribe su nombre a mano al firmar); cada
 * documento guarda su copia, así que cambiarlo no reescribe lo ya firmado.
 * Título y colegio no tienen valor por defecto: si están vacíos se proponen
 * los del país de la clínica cuando los hay (`dentalProfileFor().professional`,
 * «Cirujano dentista» y «COP» solo en Perú), a la vista y editables. La firma
 * dibujada solo la pone la propia persona: administración no la ve ni la cambia.
 */
export function ProfessionalProfileDrawer({
  open,
  profile,
  target,
  startAtSignature = false,
  onClose,
  onSaved,
}: {
  open: boolean
  profile: ProfessionalProfile | null
  /** «me» para el propio perfil; el id del usuario para administración. */
  target: string
  /** Se abrió para agregar o cambiar la firma: empieza mostrándola. */
  startAtSignature?: boolean
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
  const mine = target === "me"
  // La lista del equipo no trae firmas: la propia se pide aparte.
  const own = useQuery({
    queryKey: ["professional-profile", "me"],
    queryFn: fetchMyProfessionalProfile,
    enabled: mine,
  })
  const form = useAppForm({
    defaultValues: {
      signatureName: profile?.signatureName ?? "",
      professionalTitle: profile?.professionalTitle || suggested?.title || "",
      registrationBody: profile?.registrationBody || suggested?.registrationBody || "",
      registrationNumber: profile?.registrationNumber ?? "",
      specialtyRegistration: profile?.specialtyRegistration ?? "",
      signatureStrokes: undefined as number[][][] | null | undefined,
    },
    validators: { onSubmit: profileSchema },
    onSubmit: async ({ value }) => {
      const result = await save.mutateAsync({
        signatureName: value.signatureName.trim() || null,
        professionalTitle: value.professionalTitle.trim(),
        registrationBody: value.registrationBody.trim(),
        registrationNumber: value.registrationNumber.trim() || null,
        specialtyRegistration: value.specialtyRegistration.trim() || null,
        ...(value.signatureStrokes === undefined ? {} : { signatureStrokes: value.signatureStrokes }),
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
  const signatureField = mine ? (
    <form.AppField name="signatureStrokes">
      {(field) => (
        <div className="sm:col-span-2">
          <field.Group
            legend="Tu firma"
            description="Sale en los papeles que emites; lo ya emitido no cambia. Es solo el dibujo: el papel sigue diciendo «Firmado electrónicamente». Con el dedo, en el celular, suele quedar mejor."
          >
            {(control) => (
              <SignatureField
                saved={own.data?.data.signatureStrokes ?? null}
                loading={own.isPending}
                failed={own.isError}
                onRetry={() => void own.refetch()}
                value={field.state.value}
                onChange={(value) => {
                  field.handleChange(value)
                  field.handleBlur()
                }}
                id={control.id}
                invalid={control.invalid}
                describedBy={control.describedBy}
              />
            )}
          </field.Group>
        </div>
      )}
    </form.AppField>
  ) : null

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
        {/* Quien vino a poner su firma la encuentra primero, sin buscarla debajo de los demás datos. */}
        {startAtSignature ? signatureField : null}
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
        {startAtSignature ? null : signatureField}
      </div>
    </FormDrawer>
  )
}
