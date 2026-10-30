import {
  composeDisplayName,
  DOC_TYPE_LABELS,
  documentText,
  type IdentityDocType,
  isMinor,
  isRealDate,
  type RegistrationAnswers,
  type RegistrationContactInput,
  validateRegistrationAnswers,
} from "@odentia/clinical"
import {
  Button,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  Skeleton,
  Spinner,
  toast,
} from "@odentia/ui"
import {
  BirthDateInput,
  FormDrawer,
  INCOMPLETE_PHONE,
  internationalText,
  normalizeCountry,
  PersonAvatar,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Check } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { brandedQrDataUrl } from "../../lib/branded-qr"
import { useCan } from "../../lib/crm"
import { useClinicalProfile, useOrgProfile } from "../../lib/org"
import { fetchRegistrationConfig } from "../../lib/patient-registration"
import { hcLabel } from "../../lib/patients"
import { fetchPerson, type PersonListItem, type PersonPage, personQueryKey } from "../../lib/people"
import { asksDocumentCountry, countryChoices } from "../../lib/person-data"
import { ChoiceButtons } from "../choice-buttons"
import { SearchSelect } from "../settings/search-select"
import { DocTypeChoice } from "./doc-type-choice"
import { placeErrors } from "./form-errors"
import { SendPersonalLinkButton } from "./send-personal-link"

/**
 * A quién se registra: alguien nuevo (se busca primero, para no duplicarlo),
 * una persona que ya existe como su propia ficha, o alguien a su cargo.
 */
export type NewPatientTarget =
  /** `name`: lo que se buscó y no estaba («Crear paciente «Zoila Torres»» del buscador rápido). */
  | { kind: "new"; name?: string }
  | { kind: "person"; person: PersonPage }
  | { kind: "dependent"; person: PersonPage }

type Stage = "form" | "done"
type WhoCompletes = "paciente" | "equipo"
type Relation = "MTH" | "FTH" | "tutor" | "otro"

const RELATIONS: ReadonlyArray<{ value: Relation; label: string }> = [
  { value: "MTH", label: "Madre" },
  { value: "FTH", label: "Padre" },
  { value: "tutor", label: "Tutor o tutora" },
  { value: "otro", label: "Otro familiar" },
]
const RELATION_WORDS: Record<Relation, string> = {
  MTH: "Madre",
  FTH: "Padre",
  tutor: "Tutor",
  otro: "Familiar",
}
const WHO_OPTIONS: ReadonlyArray<{ value: WhoCompletes; label: string }> = [
  { value: "paciente", label: "Él, en su celular" },
  { value: "equipo", label: "Yo, ahora" },
]

interface Draft {
  /** Qué es el responsable para quien se registra (solo a cargo de alguien). */
  relation: Relation | null
  givenNames: string
  /** Los apellidos juntos, en un solo campo (ADR 0058). */
  surnames: string
  phone: string | null
  birthDate: string
  who: WhoCompletes
  docType: IdentityDocType | ""
  docNumber: string
  docCountry: string
  /** Documento de quien queda como representante legal, si no lo tiene. */
  guardianDocType: IdentityDocType | ""
  guardianDocNumber: string
  guardianDocCountry: string
  privacy: boolean
}

const EMPTY: Draft = {
  relation: null,
  givenNames: "",
  surnames: "",
  phone: null,
  birthDate: "",
  who: "paciente",
  docType: "",
  docNumber: "",
  docCountry: "",
  guardianDocType: "",
  guardianDocNumber: "",
  guardianDocCountry: "",
  privacy: false,
}

/**
 * El campo de la pantalla que corresponde a cada dato de las respuestas del
 * registro (`validateRegistrationAnswers`) o del cuerpo que rechaza el
 * servidor (`answers.demographics.familyName`, `docNumber` del documento
 * repetido). El nombre completo se arma con nombres y apellidos: lo que diga
 * de él se dice en los apellidos.
 */
const FIELD_OF: Record<string, keyof Draft> = {
  givenNames: "givenNames",
  familyName: "surnames",
  displayName: "surnames",
  phone: "phone",
  birthDate: "birthDate",
  docType: "docNumber",
  docNumber: "docNumber",
  docCountry: "docCountry",
  "representative.relationship": "relation",
  "representative.docType": "guardianDocNumber",
  "representative.docNumber": "guardianDocNumber",
  "representative.docCountry": "guardianDocCountry",
}

function draftField(key: string): keyof Draft | undefined {
  return FIELD_OF[key.replace(/^answers\./, "").replace(/^demographics\./, "")]
}

interface Created {
  id: string
  patientNumber: number
  displayName: string
  personId?: string
}

/** Lo que ya se sabe de la persona. Si solo hay un nombre completo, la primera palabra son los nombres. */
function draftFromPerson(person: PersonPage): Draft {
  let givenNames = person.givenNames ?? ""
  let surnames = person.familyName ?? ""
  if (!givenNames && !surnames) {
    const [first = "", ...rest] = person.displayName.trim().split(/\s+/)
    givenNames = first
    surnames = rest.join(" ")
  }
  return {
    ...EMPTY,
    givenNames,
    surnames,
    phone: person.phone,
    birthDate: person.birthDate ?? "",
    docType: (person.docType as IdentityDocType | null) ?? "",
    docNumber: person.docNumber ?? "",
    docCountry: person.docCountry ?? "",
  }
}

/** El borrador con que abre: lo que ya se sabe de la persona, o el nombre que se buscó. */
function initialDraft(target: NewPatientTarget): Draft {
  if (target.kind === "person") return draftFromPerson(target.person)
  if (target.kind === "new" && target.name?.trim()) {
    const [givenNames = "", ...rest] = target.name.trim().split(/\s+/)
    return { ...EMPTY, givenNames, surnames: rest.join(" ") }
  }
  return EMPTY
}

function personLine(row: PersonListItem): string {
  const parts: string[] = []
  if (row.patient) parts.push(hcLabel(row.patient.patientNumber))
  if (row.docNumber) parts.push(documentText(row.docType, row.docNumber))
  if (row.phone) parts.push(internationalText(row.phone))
  if (!row.patient)
    parts.push(row.kind === "responsable" ? "familiar de un paciente" : "aún no es paciente")
  return parts.join(" · ")
}

/**
 * «Nuevo paciente»: una sola ventana, sin pasos. Primero se busca (para no
 * crear a quien ya existe), después nombres, apellidos y celular, y quién
 * completa lo demás: el paciente en su celular (por defecto) o recepción ahora.
 * Lo que la clínica pide y falta no bloquea: queda como «Faltan datos». Al
 * terminar dice qué sigue: el código para que complete su ficha, atender o
 * reservar.
 */
export function NewPatientDrawer({
  open,
  onClose,
  target,
}: {
  open: boolean
  onClose: () => void
  target: NewPatientTarget
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const can = useCan()
  const profile = useClinicalProfile()
  const orgProfile = useOrgProfile()
  const countryCode = orgProfile.data?.countryCode ?? null
  const defaultCountry = normalizeCountry(orgProfile.data?.countryCode)
  const dependent = target.kind === "dependent"
  const fromPerson = target.kind === "person" ? target.person : null
  const guardian = target.kind === "dependent" ? target.person : null
  const guardianFirst = guardian?.displayName.split(" ")[0] ?? "esta persona"

  const [stage, setStage] = useState<Stage>("form")
  const [picked, setPicked] = useState<PersonPage | null>(fromPerson)
  const [showNotice, setShowNotice] = useState(false)
  const [created, setCreated] = useState<Created | null>(null)
  const submission = useRef(crypto.randomUUID())

  const config = useQuery({
    queryKey: ["patient-registration-config"],
    queryFn: fetchRegistrationConfig,
    enabled: open,
    retry: false,
  })
  const today = config.data?.meta.today ?? new Date().toISOString().slice(0, 10)
  const asksDocument = config.data ? config.data.data.fields.docType !== "hidden" : true

  const docTypes = profile.documentTypes.map(({ code }) => ({
    value: code,
    label: DOC_TYPE_LABELS[code],
  }))
  const docTypeOf = (current: Draft) => current.docType || docTypes[0]?.value || ""
  const guardianDocTypeOf = (current: Draft) => current.guardianDocType || docTypes[0]?.value || ""
  const minorOf = (current: Draft) => isRealDate(current.birthDate) && isMinor(current.birthDate, today)
  const needsGuardianDocOf = (current: Draft) => dependent && minorOf(current) && !guardian?.docNumber

  function answersFrom(current: Draft): {
    answers: RegistrationAnswers
    contacts?: RegistrationContactInput[]
  } {
    const trimmed = (value: string) => value.trim()
    const showDetails = current.who === "equipo"
    const docType = docTypeOf(current)
    const familyName = trimmed(current.surnames)
    const displayName = composeDisplayName({
      givenNames: trimmed(current.givenNames),
      familyName,
    })
    const demographics: RegistrationAnswers["demographics"] = {
      displayName,
      givenNames: trimmed(current.givenNames),
      familyName,
      ...(current.phone ? { phone: current.phone } : {}),
      ...(current.birthDate && (showDetails || dependent) ? { birthDate: current.birthDate } : {}),
      ...(showDetails && asksDocument && trimmed(current.docNumber)
        ? {
            docType: docType as IdentityDocType,
            docNumber: trimmed(current.docNumber),
            ...(asksDocumentCountry(profile, docType) && current.docCountry
              ? { docCountry: current.docCountry }
              : {}),
          }
        : {}),
    } as RegistrationAnswers["demographics"]
    const answers: RegistrationAnswers = {
      demographics,
      respondent: "staff",
      privacyAccepted: current.privacy,
    }
    if (guardian) {
      const relation = current.relation
      const word = relation ? RELATION_WORDS[relation] : "Familiar"
      const relationship =
        minorOf(current) || relation === "tutor" ? "guardian" : relation === "otro" ? "other" : "family"
      const guardianDocType = guardianDocTypeOf(current)
      answers.representative = {
        displayName: guardian.displayName,
        relationship,
        relationshipDetail: word,
        ...(guardian.phone ? { phone: guardian.phone } : {}),
        ...(guardian.email ? { email: guardian.email } : {}),
        ...(guardian.docNumber
          ? {
              docType: guardian.docType as IdentityDocType,
              docNumber: guardian.docNumber,
              ...(guardian.docCountry ? { docCountry: guardian.docCountry } : {}),
            }
          : current.guardianDocNumber.trim()
            ? {
                docType: guardianDocType as IdentityDocType,
                docNumber: current.guardianDocNumber.trim(),
                ...(asksDocumentCountry(profile, guardianDocType) && current.guardianDocCountry
                  ? { docCountry: current.guardianDocCountry }
                  : {}),
              }
            : {}),
      } as RegistrationAnswers["representative"]
      return {
        answers,
        contacts: [
          {
            contactId: guardian.id,
            relationship,
            relationshipDetail: word,
            ...(relation === "MTH" || relation === "FTH" ? { kinship: relation } : {}),
            isPreferred: true,
          },
        ],
      }
    }
    if (picked)
      return {
        answers,
        contacts: [{ contactId: picked.id, relationship: "self", isPreferred: true }],
      }
    return { answers }
  }

  /**
   * Lo que falta o no vale, por campo: lo propio de esta pantalla y la misma
   * regla que aplica el servidor. Lo que no tiene campo aquí (el responsable
   * sin teléfono ni correo, su documento ya guardado) se dice junto a los botones.
   */
  function draftErrors(current: Draft, phoneHalfWritten: boolean): Record<string, string> {
    const found: Record<string, string> = {}
    if (!current.givenNames.trim()) found.givenNames = "Escribe los nombres"
    if (!current.surnames.trim()) found.surnames = "Escribe los apellidos"
    // Un número a medias ya lo dice el campo («le faltan dígitos»).
    if (!dependent && !picked && !current.phone && !phoneHalfWritten)
      found.phone = "Escribe su celular: ahí le avisamos sus citas"
    if (dependent && !current.relation) found.relation = `Elige qué es ${guardianFirst} para él o ella`
    if (needsGuardianDocOf(current) && !current.guardianDocNumber.trim())
      found.guardianDocNumber = "Hace falta el documento de quien lo representa"
    if (config.data) {
      const server = validateRegistrationAnswers(config.data.data, answersFrom(current).answers, {
        mode: "internal",
        today,
        scope: "essentials",
        countryCode,
      })
      for (const [key, message] of Object.entries(server)) found[draftField(key) ?? key] ??= message
    }
    return found
  }

  const register = useMutation({
    mutationFn: async (current: Draft) => {
      const { answers, contacts } = answersFrom(current)
      const context = guardian ?? picked
      return apiFetch<{ data: Created }>("/api/patients", {
        method: "POST",
        body: JSON.stringify({
          submissionId: submission.current,
          answers,
          scope: "essentials",
          ...(contacts ? { contacts } : {}),
          ...(context ? { contextContactId: context.id } : {}),
        }),
      })
    },
  })

  const form = useAppForm({
    defaultValues: initialDraft(target),
    validators: {
      onSubmit: ({ value, formApi }) =>
        placeErrors(
          formApi,
          draftErrors(value, formApi.getFieldMeta("phone")?.errorMap.onChange === INCOMPLETE_PHONE),
        ),
    },
    onSubmit: async ({ value }) => {
      const result = await register.mutateAsync(value)
      setCreated(result.data)
      setStage("done")
      toast.success(`${result.data.displayName} ya es paciente`)
      await queryClient.invalidateQueries({ queryKey: ["people"] })
      await queryClient.invalidateQueries({ queryKey: ["patients"] })
      const context = guardian ?? picked
      if (context) await queryClient.invalidateQueries({ queryKey: personQueryKey(context.id) })
    },
  })
  const surface = useFormSurface(form, { fieldMap: draftField })
  const values = useStore(form.store, (state) => state.values)

  // Cada vez que se abre empieza de cero, con lo que ya se sabe. Solo al
  // abrir: si la persona se vuelve a leer mientras se escribe, no se pierde nada.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia solo al abrir
  useEffect(() => {
    if (!open) return
    setStage("form")
    setPicked(target.kind === "person" ? target.person : null)
    form.reset(initialDraft(target))
    setShowNotice(false)
    setCreated(null)
    submission.current = crypto.randomUUID()
  }, [open])

  // Mientras se escribe se busca si ya existe: por el nombre, el celular y el
  // documento. Solo al registrar a alguien nuevo (no desde una persona).
  const lookup = target.kind === "new" && !picked
  const firstSurname = values.surnames.trim().split(/\s+/)[0] ?? ""
  const nameProbe =
    values.givenNames.trim().length >= 2 && firstSurname.length >= 2
      ? `${values.givenNames.trim()} ${firstSurname}`
      : ""
  const phoneDigits = (values.phone ?? "").replace(/\D/g, "")
  const phoneProbe = phoneDigits.length >= 8 ? phoneDigits.slice(-8) : ""
  const docProbe = values.docNumber.trim().length >= 5 ? values.docNumber.trim() : ""
  const [probes, setProbes] = useState<string[]>([])
  useEffect(() => {
    const next = lookup ? [nameProbe, phoneProbe, docProbe].filter(Boolean) : []
    const timer = setTimeout(() => setProbes(next), 350)
    return () => clearTimeout(timer)
  }, [lookup, nameProbe, phoneProbe, docProbe])
  const matches = useQuery({
    queryKey: ["people", "new-patient-matches", probes],
    queryFn: async () => {
      const lists = await Promise.all(
        probes.map((probe) =>
          apiFetch<{ data: PersonListItem[] }>(
            `/api/people?ver=todos&limit=4&q=${encodeURIComponent(probe)}`,
          ).then((r) => r.data),
        ),
      )
      const unique = new Map<string, PersonListItem>()
      for (const row of lists.flat()) if (!unique.has(row.id)) unique.set(row.id, row)
      return [...unique.values()].slice(0, 4)
    },
    enabled: open && probes.length > 0,
    placeholderData: keepPreviousData,
  })

  const docType = docTypeOf(values)
  const guardianDocType = guardianDocTypeOf(values)
  const minor = minorOf(values)
  const needsGuardianDoc = needsGuardianDocOf(values)

  async function startFrom(row: PersonListItem): Promise<void> {
    if (row.patient) {
      onClose()
      await navigate({ to: "/people/$personId", params: { personId: row.id } })
      return
    }
    const page = await queryClient.fetchQuery({
      queryKey: personQueryKey(row.id),
      queryFn: () => fetchPerson(row.id),
    })
    setPicked(page.data)
    // Lo que ya se sabía de ella, sin perder el celular que se acaba de escribir.
    const typed = form.state.values
    form.reset({ ...draftFromPerson(page.data), phone: page.data.phone ?? typed.phone, who: typed.who })
    setStage("form")
  }

  const name = values.givenNames.trim() || "esta persona"
  const title =
    stage === "done" && created
      ? `${created.displayName} ya es paciente`
      : guardian
        ? `Registrar a alguien a cargo de ${guardianFirst}`
        : picked
          ? `Registrar a ${picked.displayName}`
          : "Nuevo paciente"
  const description =
    stage === "done" && created
      ? hcLabel(created.patientNumber)
      : guardian
        ? `${guardian.displayName} queda como su responsable: no hace falta escribir sus datos.`
        : picked
          ? "Esto ya lo sabemos: revísalo y registra."
          : "Con esto ya se puede atender. Lo demás se completa después."

  return (
    <FormDrawer
      open={open}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
      title={title}
      description={description}
      onSubmit={
        stage === "form"
          ? surface.onSubmit
          : (event) => {
              event.preventDefault()
            }
      }
      isSubmitting={surface.isSubmitting}
      isDirty={
        stage === "form" &&
        !created &&
        (surface.isDirty || Boolean(values.givenNames || values.surnames || values.phone))
      }
      error={stage === "form" ? surface.error : null}
      hideSubmit={stage !== "form"}
      cancelLabel={stage === "done" ? "Listo" : "Cancelar"}
      submitLabel={guardian ? `Registrar a ${name}` : "Registrar"}
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(32rem,calc(100vw-2rem))]"
    >
      {stage === "form" ? (
        <div className="flex min-w-0 flex-col gap-5">
          {guardian ? (
            <form.AppField name="relation">
              {(field) => (
                <field.Group legend={`¿Qué es ${guardianFirst} para él o ella?`}>
                  {(control) => (
                    <ChoiceButtons
                      id={control.id}
                      aria-label={`Qué es ${guardianFirst} para él o ella`}
                      aria-describedby={control.describedBy}
                      invalid={control.invalid}
                      onBlur={control.onBlur}
                      value={field.state.value}
                      options={RELATIONS}
                      onChange={(next) => field.handleChange(next)}
                    />
                  )}
                </field.Group>
              )}
            </form.AppField>
          ) : null}

          <form.AppField name="givenNames">
            {(field) => <field.TextField label="Nombres" id="np-given" autoFocus maxLength={100} />}
          </form.AppField>
          <form.AppField name="surnames">
            {(field) => <field.TextField label="Apellidos" id="np-surnames" maxLength={200} />}
          </form.AppField>

          {dependent ? (
            <form.AppField name="birthDate">
              {(field) => (
                <field.Control
                  label="Fecha de nacimiento"
                  id="np-birth"
                  description={
                    minor
                      ? `Es menor de edad: ${guardian?.displayName} decide por él o ella y recibe sus avisos.`
                      : "Con su edad sabemos si alguien decide por él o ella."
                  }
                >
                  {(control) => (
                    <BirthDateInput
                      id={control.id}
                      name={control.name}
                      value={field.state.value}
                      today={today}
                      country={countryCode ?? undefined}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      onChange={(value) => field.handleChange(value ?? "")}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
          ) : null}

          <form.AppField name="phone">
            {(field) => (
              <field.PhoneField
                label="Celular"
                id="np-phone"
                defaultCountry={defaultCountry}
                description={
                  guardian && !field.state.value
                    ? `Si no tiene celular propio, sus avisos le llegan a ${guardian.displayName}.`
                    : "Aquí le avisamos sus citas por WhatsApp."
                }
              />
            )}
          </form.AppField>

          {lookup ? (
            <MatchesNote
              searching={probes.length > 0 && matches.isFetching && !matches.data}
              asked={probes.length > 0 && (matches.isSuccess || matches.isPlaceholderData)}
              rows={probes.length > 0 ? (matches.data ?? []) : []}
              onPick={(row) => void startFrom(row)}
            />
          ) : null}

          {needsGuardianDoc ? (
            <>
              <form.AppField name="guardianDocNumber">
                {(field) => (
                  <field.Control
                    label={`Documento de ${guardian?.displayName}`}
                    id="np-guardian-doc"
                    description="Al ser menor, queda como su representante legal."
                  >
                    {(control) => (
                      <div className="flex min-w-0 flex-col gap-2">
                        <DocTypeChoice
                          aria-label={`Tipo de documento de ${guardian?.displayName}`}
                          value={guardianDocType as IdentityDocType}
                          options={docTypes}
                          onChange={(next) => {
                            form.setFieldValue("guardianDocType", next)
                            form.setFieldValue("guardianDocCountry", "")
                          }}
                        />
                        <Input
                          {...control.props}
                          inputMode="numeric"
                          maxLength={20}
                          value={field.state.value}
                          onChange={(event) => field.handleChange(event.target.value)}
                        />
                      </div>
                    )}
                  </field.Control>
                )}
              </form.AppField>
              {asksDocumentCountry(profile, guardianDocType) ? (
                <form.AppField name="guardianDocCountry">
                  {(field) => (
                    <field.Control
                      label={`País que emitió el documento de ${guardian?.displayName}`}
                      id="np-guardian-doc-country"
                    >
                      {(control) => (
                        <SearchSelect
                          id={control.id}
                          label={`País que emitió el documento de ${guardian?.displayName}`}
                          placeholder="Buscar país…"
                          value={field.state.value}
                          options={countryChoices(profile.country)}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onChange={(value) => field.handleChange(value)}
                        />
                      )}
                    </field.Control>
                  )}
                </form.AppField>
              ) : null}
            </>
          ) : null}

          <div className="flex min-w-0 flex-col gap-3 rounded-3xl border p-4">
            <div className="flex flex-col gap-1">
              <span id="np-who" className="text-sm font-medium">¿Quién completa sus datos y su salud?</span>
              <span className="text-sm text-muted-foreground">
                {asksDocument
                  ? "Fecha de nacimiento, documento y alergias, antes de atenderlo."
                  : "Fecha de nacimiento y alergias, antes de atenderlo."}
              </span>
            </div>
            <form.AppField name="who">
              {(field) => (
                <ChoiceButtons
                  aria-labelledby="np-who"
                  tone="primary"
                  columns={2}
                  value={field.state.value}
                  options={WHO_OPTIONS}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </form.AppField>
            {values.who === "paciente" ? (
              <p className="text-sm text-muted-foreground">
                Al registrar te mostramos un código para que lo escanee con su celular y los
                complete mientras espera.
              </p>
            ) : (
              <div className="flex min-w-0 flex-col gap-4 pt-1">
                {!dependent ? (
                  <form.AppField name="birthDate">
                    {(field) => (
                      <field.Control label="Fecha de nacimiento" id="np-birth">
                        {(control) => (
                          <BirthDateInput
                            id={control.id}
                            name={control.name}
                            value={field.state.value}
                            today={today}
                            country={countryCode ?? undefined}
                            invalid={control.invalid}
                            aria-describedby={control.describedBy}
                            onBlur={control.onBlur}
                            onChange={(value) => field.handleChange(value ?? "")}
                          />
                        )}
                      </field.Control>
                    )}
                  </form.AppField>
                ) : null}
                {asksDocument ? (
                  <form.AppField name="docNumber">
                    {(field) => (
                      <field.Control label="Documento" id="np-doc">
                        {(control) => (
                          <div className="flex min-w-0 flex-col gap-2">
                            <DocTypeChoice
                              aria-label="Tipo de documento"
                              value={docType as IdentityDocType}
                              options={docTypes}
                              onChange={(next) => {
                                form.setFieldValue("docType", next)
                                form.setFieldValue("docCountry", "")
                              }}
                            />
                            <Input
                              {...control.props}
                              maxLength={20}
                              value={field.state.value}
                              onChange={(event) => field.handleChange(event.target.value)}
                            />
                          </div>
                        )}
                      </field.Control>
                    )}
                  </form.AppField>
                ) : null}
                {asksDocument && asksDocumentCountry(profile, docType) ? (
                  <form.AppField name="docCountry">
                    {(field) => (
                      <field.Control label="País que emitió el documento" id="np-doc-country">
                        {(control) => (
                          <SearchSelect
                            id={control.id}
                            label="País que emitió el documento"
                            placeholder="Buscar país…"
                            value={field.state.value}
                            options={countryChoices(profile.country)}
                            invalid={control.invalid}
                            aria-describedby={control.describedBy}
                            onChange={(value) => field.handleChange(value)}
                          />
                        )}
                      </field.Control>
                    )}
                  </form.AppField>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  Su salud la pregunta quien lo atiende, en Antecedentes.
                </p>
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <form.AppField name="privacy">
              {(field) => <field.CheckboxField label="Le informé cómo usamos sus datos." id="np-privacy" />}
            </form.AppField>
            {config.data?.data.privacyNotice.trim() ? (
              <div className="ps-6">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => setShowNotice((shown) => !shown)}
                >
                  {showNotice ? "Ocultar el aviso" : "Ver el aviso de privacidad"}
                </Button>
                {showNotice ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                    {config.data.data.privacyNotice}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {stage === "done" && created ? (
        <DoneStage
          created={created}
          who={values.who}
          personId={created.personId ?? picked?.id ?? null}
          canAttend={can("clinical.write")}
          canBook={can("appointments.write")}
          onGo={async (to, personId) => {
            onClose()
            if (to === "agenda")
              await navigate({ to: "/agenda", search: { contactId: personId } as never })
            else
              await navigate({
                to: "/people/$personId",
                params: { personId },
                search: (to === "attend" ? { atender: true } : {}) as never,
              })
          }}
        />
      ) : null}
    </FormDrawer>
  )
}

/**
 * ¿Ya está registrado? Mientras se escriben los datos se busca a quien
 * coincide por nombre, celular o documento, y se dice también cuando no hay
 * nadie: así no se crea dos veces a la misma persona.
 */
function MatchesNote({
  searching,
  asked,
  rows,
  onPick,
}: {
  searching: boolean
  asked: boolean
  rows: PersonListItem[]
  onPick: (row: PersonListItem) => void
}) {
  if (searching) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <Spinner className="size-4" aria-hidden /> Buscando si ya está registrado…
      </div>
    )
  }
  if (!asked) return null
  if (rows.length === 0) {
    return (
      <p
        className="flex items-center gap-2 rounded-2xl bg-success-soft px-3 py-2 text-sm text-success"
        aria-live="polite"
      >
        <Check aria-hidden className="size-4 shrink-0" />
        No hay nadie con estos datos: es nuevo.
      </p>
    )
  }
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-3xl bg-warning-soft p-3" aria-live="polite">
      <span className="px-1 text-sm font-medium text-warning">¿Es alguna de estas personas?</span>
      {rows.map((row) => (
        <Item key={row.id} variant="outline" className="rounded-2xl bg-background">
          <ItemMedia>
            <PersonAvatar
              name={row.displayName}
              className="size-9"
              fallbackClassName="text-xs"
              decorative
            />
          </ItemMedia>
          {/* Con poco ancho el botón baja a su propia fila en vez de apretar el nombre. */}
          <ItemContent className="min-w-0 basis-48">
            <ItemTitle>{row.displayName}</ItemTitle>
            <ItemDescription className="line-clamp-none">{personLine(row)}</ItemDescription>
          </ItemContent>
          <ItemActions className="ms-auto">
            <Button
              type="button"
              size="sm"
              variant={row.patient ? "secondary" : "default"}
              onClick={() => onPick(row)}
            >
              {row.patient ? "Abrir" : "Es esta persona"}
            </Button>
          </ItemActions>
        </Item>
      ))}
      <span className="px-1 text-xs text-muted-foreground">
        Si no es ninguna, sigue: se registra como nueva.
      </span>
    </div>
  )
}

function DoneStage({
  created,
  who,
  personId,
  canAttend,
  canBook,
  onGo,
}: {
  created: Created
  who: WhoCompletes
  personId: string | null
  canAttend: boolean
  canBook: boolean
  onGo: (to: "attend" | "agenda" | "page", personId: string) => Promise<void>
}) {
  const link = useMutation({
    mutationFn: () =>
      apiFetch<{ data: { url: string; recipientName: string } }>(
        `/api/patients/${created.id}/personal-link/show`,
        {
          method: "POST",
          body: "{}",
        },
      ),
  })
  const [qr, setQr] = useState<string | null>(null)
  const { mutate } = link
  useEffect(() => {
    if (who === "paciente") mutate()
  }, [who, mutate])
  useEffect(() => {
    const url = link.data?.data.url
    if (!url) return
    let alive = true
    void brandedQrDataUrl(url).then((data) => {
      if (alive) setQr(data)
    })
    return () => {
      alive = false
    }
  }, [link.data])

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex items-start gap-3 rounded-3xl bg-success-soft p-4 text-success">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success text-background">
          <Check aria-hidden className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">Ya es paciente · {hcLabel(created.patientNumber)}</span>
          <span className="text-sm">
            {who === "paciente"
              ? "Falta que complete sus datos y su salud."
              : "Lo que falte queda como «Faltan datos» en su página."}
          </span>
        </div>
      </div>

      {who === "paciente" ? (
        <div className="@container rounded-3xl border p-4">
          <div className="grid min-w-0 justify-items-center gap-4 text-center @sm:grid-cols-[auto_minmax(0,1fr)] @sm:items-center @sm:justify-items-start @sm:text-start">
            <div className="flex size-32 items-center justify-center overflow-hidden rounded-2xl border bg-white p-1.5">
              {qr ? (
                <img
                  src={qr}
                  alt={`Código para que ${created.displayName} complete su ficha`}
                  className="size-full"
                />
              ) : link.isError ? (
                <span className="text-center text-xs text-muted-foreground">Sin código</span>
              ) : (
                <Skeleton className="size-full rounded-xl" />
              )}
            </div>
            <div className="flex min-w-0 flex-col items-center gap-2 @sm:items-start">
              <span className="font-medium">Que escanee este código</span>
              <span className="text-sm text-muted-foreground">
                {link.isError
                  ? ((link.error instanceof ApiError ? link.error.shape.message : null) ??
                    "No se pudo preparar el código.")
                  : "Con la cámara de su celular abre su ficha y la completa mientras espera. No instala nada."}
              </span>
              <SendPersonalLinkButton patientId={created.id} />
            </div>
          </div>
        </div>
      ) : null}

      {personId ? (
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">Qué sigue</span>
          <div className="flex flex-wrap gap-2">
            {canAttend ? (
              <Button type="button" onClick={() => void onGo("attend", personId)}>
                Atender ahora
              </Button>
            ) : null}
            {canBook ? (
              <Button
                type="button"
                variant={canAttend ? "outline" : "default"}
                onClick={() => void onGo("agenda", personId)}
              >
                Reservar cita
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => void onGo("page", personId)}>
              Abrir su página
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
