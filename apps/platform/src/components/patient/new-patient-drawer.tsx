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
  Checkbox,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
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
  internationalText,
  normalizeCountry,
  PersonAvatar,
  PhoneInput,
} from "@odentia/ui-patterns"
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
  givenNames: string
  /** Los apellidos juntos, en un solo campo (ADR 0058). */
  surnames: string
  phone: string | null
  birthDate: string
  docType: IdentityDocType | ""
  docNumber: string
  docCountry: string
  /** Documento de quien queda como representante legal, si no lo tiene. */
  guardianDocType: IdentityDocType | ""
  guardianDocNumber: string
  privacy: boolean
}

const EMPTY: Draft = {
  givenNames: "",
  surnames: "",
  phone: null,
  birthDate: "",
  docType: "",
  docNumber: "",
  docCountry: "",
  guardianDocType: "",
  guardianDocNumber: "",
  privacy: false,
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

  const [stage, setStage] = useState<Stage>("form")
  const [picked, setPicked] = useState<PersonPage | null>(fromPerson)
  const [draft, setDraft] = useState<Draft>(initialDraft(target))
  const [who, setWho] = useState<WhoCompletes>("paciente")
  const [relation, setRelation] = useState<Relation | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [showNotice, setShowNotice] = useState(false)
  const [created, setCreated] = useState<Created | null>(null)
  const submission = useRef(crypto.randomUUID())

  // Cada vez que se abre empieza de cero, con lo que ya se sabe. Solo al
  // abrir: si la persona se vuelve a leer mientras se escribe, no se pierde nada.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia solo al abrir
  useEffect(() => {
    if (!open) return
    setStage("form")
    setPicked(target.kind === "person" ? target.person : null)
    setDraft(initialDraft(target))
    setWho("paciente")
    setRelation(null)
    setErrors({})
    setError(null)
    setShowNotice(false)
    setCreated(null)
    submission.current = crypto.randomUUID()
  }, [open])

  // Mientras se escribe se busca si ya existe: por el nombre, el celular y el
  // documento. Solo al registrar a alguien nuevo (no desde una persona).
  const lookup = target.kind === "new" && !picked
  const firstSurname = draft.surnames.trim().split(/\s+/)[0] ?? ""
  const nameProbe =
    draft.givenNames.trim().length >= 2 && firstSurname.length >= 2
      ? `${draft.givenNames.trim()} ${firstSurname}`
      : ""
  const phoneDigits = (draft.phone ?? "").replace(/\D/g, "")
  const phoneProbe = phoneDigits.length >= 8 ? phoneDigits.slice(-8) : ""
  const docProbe = draft.docNumber.trim().length >= 5 ? draft.docNumber.trim() : ""
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
  const config = useQuery({
    queryKey: ["patient-registration-config"],
    queryFn: fetchRegistrationConfig,
    enabled: open,
    retry: false,
  })
  const today = config.data?.meta.today ?? new Date().toISOString().slice(0, 10)
  const asksDocument = config.data ? config.data.data.fields.docType !== "hidden" : true

  const set = (patch: Partial<Draft>, ...cleared: string[]) => {
    setDraft((previous) => ({ ...previous, ...patch }))
    if (cleared.length)
      setErrors((previous) => {
        const next = { ...previous }
        for (const key of cleared) delete next[key]
        return next
      })
  }

  const docTypes = profile.documentTypes.map(({ code }) => ({
    value: code,
    label: DOC_TYPE_LABELS[code],
  }))
  const docType = draft.docType || docTypes[0]?.value || ""
  const minor = isRealDate(draft.birthDate) && isMinor(draft.birthDate, today)
  const needsGuardianDoc = dependent && minor && !guardian?.docNumber
  const showDetails = who === "equipo"

  function answersFrom(current: Draft): {
    answers: RegistrationAnswers
    contacts?: RegistrationContactInput[]
  } {
    const trimmed = (value: string) => value.trim()
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
      const isMinorNow = isRealDate(current.birthDate) && isMinor(current.birthDate, today)
      const word = relation ? RELATION_WORDS[relation] : "Familiar"
      const relationship =
        isMinorNow || relation === "tutor" ? "guardian" : relation === "otro" ? "other" : "family"
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
                docType: (current.guardianDocType || docTypes[0]?.value) as IdentityDocType,
                docNumber: current.guardianDocNumber.trim(),
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

  const register = useMutation({
    mutationFn: async () => {
      const { answers, contacts } = answersFrom(draft)
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
    onSuccess: async (result) => {
      setCreated(result.data)
      setStage("done")
      toast.success(`${result.data.displayName} ya es paciente`)
      await queryClient.invalidateQueries({ queryKey: ["people"] })
      await queryClient.invalidateQueries({ queryKey: ["patients"] })
      const context = guardian ?? picked
      if (context) await queryClient.invalidateQueries({ queryKey: personQueryKey(context.id) })
    },
    onError: (failure) => {
      setError(
        failure instanceof ApiError
          ? (failure.shape.message ?? "No se pudo registrar.")
          : "No se pudo registrar.",
      )
    },
  })

  function submit(): void {
    if (register.isPending) return
    setError(null)
    const found: Record<string, string> = {}
    if (!draft.givenNames.trim()) found.givenNames = "Escribe los nombres"
    if (!draft.surnames.trim()) found.surnames = "Escribe los apellidos"
    if (!dependent && !picked && !draft.phone)
      found.phone = "Escribe su celular: ahí le avisamos sus citas"
    if (dependent && !relation)
      found.relation = `Elige qué es ${guardian?.displayName.split(" ")[0] ?? "esta persona"} para él o ella`
    if (needsGuardianDoc && !draft.guardianDocNumber.trim())
      found.guardianDoc = "Hace falta el documento de quien lo representa"
    if (Object.keys(found).length === 0 && config.data) {
      // La misma regla que aplica el servidor, para decirlo junto al campo.
      const { answers } = answersFrom(draft)
      const server = validateRegistrationAnswers(config.data.data, answers, {
        mode: "internal",
        today,
        scope: "essentials",
        countryCode,
      })
      for (const [key, message] of Object.entries(server)) {
        const field = key
          .replace(/^demographics\./, "")
          .replace(/^familyName$/, "surnames")
          .replace(/^representative\.docNumber$/, "guardianDoc")
        found[field] ??= message
      }
    }
    setErrors(found)
    if (Object.keys(found).length > 0) return
    register.mutate()
  }

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
    setDraft((typed) => ({ ...draftFromPerson(page.data), phone: page.data.phone ?? typed.phone }))
    setStage("form")
  }

  const name = draft.givenNames.trim() || "esta persona"
  const title =
    stage === "done" && created
      ? `${created.displayName} ya es paciente`
      : guardian
        ? `Registrar a alguien a cargo de ${guardian.displayName.split(" ")[0]}`
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
        if (!register.isPending) onClose()
      }}
      title={title}
      description={description}
      onSubmit={(event) => {
        event.preventDefault()
        if (stage === "form") submit()
      }}
      isSubmitting={register.isPending}
      isDirty={
        stage === "form" && !created && Boolean(draft.givenNames || draft.surnames || draft.phone)
      }
      error={stage === "form" ? error : null}
      hideSubmit={stage !== "form"}
      cancelLabel={stage === "done" ? "Listo" : "Cancelar"}
      submitLabel={guardian ? `Registrar a ${name}` : "Registrar"}
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(32rem,calc(100vw-2rem))]"
    >
      {stage === "form" ? (
        <div className="flex min-w-0 flex-col gap-5">
          {guardian ? (
            <Field>
              <FieldLabel>¿Qué es {guardian.displayName.split(" ")[0]} para él o ella?</FieldLabel>
              <ChoiceButtons
                label={`Qué es ${guardian.displayName} para la persona que se registra`}
                value={relation}
                options={RELATIONS}
                onChange={(next) => {
                  setRelation(next)
                  set({}, "relation")
                }}
              />
              {errors.relation ? <FieldError>{errors.relation}</FieldError> : null}
            </Field>
          ) : null}

          <Field data-invalid={errors.givenNames ? true : undefined}>
            <FieldLabel htmlFor="np-given">Nombres</FieldLabel>
            <Input
              id="np-given"
              autoFocus
              maxLength={100}
              value={draft.givenNames}
              aria-invalid={errors.givenNames ? true : undefined}
              onChange={(event) => set({ givenNames: event.target.value }, "givenNames")}
            />
            {errors.givenNames ? <FieldError>{errors.givenNames}</FieldError> : null}
          </Field>
          <Field data-invalid={errors.surnames ? true : undefined}>
            <FieldLabel htmlFor="np-surnames">Apellidos</FieldLabel>
            <Input
              id="np-surnames"
              maxLength={200}
              value={draft.surnames}
              aria-invalid={errors.surnames ? true : undefined}
              onChange={(event) => set({ surnames: event.target.value }, "surnames")}
            />
            {errors.surnames ? <FieldError>{errors.surnames}</FieldError> : null}
          </Field>

          {dependent ? (
            <Field>
              <FieldLabel htmlFor="np-birth">Fecha de nacimiento</FieldLabel>
              <BirthDateInput
                id="np-birth"
                value={draft.birthDate}
                today={today}
                country={countryCode ?? undefined}
                onChange={(value) => set({ birthDate: value ?? "" }, "birthDate")}
              />
              <FieldDescription>
                {minor
                  ? `Es menor de edad: ${guardian?.displayName} decide por él o ella y recibe sus avisos.`
                  : "Con su edad sabemos si alguien decide por él o ella."}
              </FieldDescription>
            </Field>
          ) : null}

          <Field data-invalid={errors.phone ? true : undefined}>
            <FieldLabel htmlFor="np-phone">Celular</FieldLabel>
            <PhoneInput
              id="np-phone"
              value={draft.phone}
              defaultCountry={defaultCountry}
              invalid={Boolean(errors.phone)}
              onChange={(value) => set({ phone: value }, "phone")}
            />
            {errors.phone ? (
              <FieldError>{errors.phone}</FieldError>
            ) : (
              <FieldDescription>
                {guardian && !draft.phone
                  ? `Si no tiene celular propio, sus avisos le llegan a ${guardian.displayName}.`
                  : "Aquí le avisamos sus citas por WhatsApp."}
              </FieldDescription>
            )}
          </Field>

          {lookup ? (
            <MatchesNote
              searching={probes.length > 0 && matches.isFetching && !matches.data}
              asked={probes.length > 0 && (matches.isSuccess || matches.isPlaceholderData)}
              rows={probes.length > 0 ? (matches.data ?? []) : []}
              onPick={(row) => void startFrom(row)}
            />
          ) : null}

          {needsGuardianDoc ? (
            <Field data-invalid={errors.guardianDoc ? true : undefined}>
              <FieldLabel htmlFor="np-guardian-doc">
                Documento de {guardian?.displayName}
              </FieldLabel>
              <div className="flex min-w-0 flex-col gap-2">
                <DocTypeChoice
                  label={`Tipo de documento de ${guardian?.displayName}`}
                  value={(draft.guardianDocType || docTypes[0]?.value) as IdentityDocType}
                  options={docTypes}
                  onChange={(next) => set({ guardianDocType: next }, "guardianDoc")}
                />
                <Input
                  id="np-guardian-doc"
                  inputMode="numeric"
                  maxLength={20}
                  value={draft.guardianDocNumber}
                  aria-invalid={errors.guardianDoc ? true : undefined}
                  onChange={(event) =>
                    set({ guardianDocNumber: event.target.value }, "guardianDoc")
                  }
                />
              </div>
              {errors.guardianDoc ? (
                <FieldError>{errors.guardianDoc}</FieldError>
              ) : (
                <FieldDescription>
                  Al ser menor, queda como su representante legal.
                </FieldDescription>
              )}
            </Field>
          ) : null}

          <div className="flex min-w-0 flex-col gap-3 rounded-3xl border p-4">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">¿Quién completa sus datos y su salud?</span>
              <span className="text-sm text-muted-foreground">
                {asksDocument
                  ? "Fecha de nacimiento, documento y alergias, antes de atenderlo."
                  : "Fecha de nacimiento y alergias, antes de atenderlo."}
              </span>
            </div>
            <ChoiceButtons
              label="Quién completa sus datos y su salud"
              tone="primary"
              columns={2}
              value={who}
              options={WHO_OPTIONS}
              onChange={setWho}
            />
            {who === "paciente" ? (
              <p className="text-sm text-muted-foreground">
                Al registrar te mostramos un código para que lo escanee con su celular y los
                complete mientras espera.
              </p>
            ) : (
              <div className="flex min-w-0 flex-col gap-4 pt-1">
                {!dependent ? (
                  <Field data-invalid={errors.birthDate ? true : undefined}>
                    <FieldLabel htmlFor="np-birth">Fecha de nacimiento</FieldLabel>
                    <BirthDateInput
                      id="np-birth"
                      value={draft.birthDate}
                      today={today}
                      country={countryCode ?? undefined}
                      invalid={Boolean(errors.birthDate)}
                      onChange={(value) => set({ birthDate: value ?? "" }, "birthDate")}
                    />
                    {errors.birthDate ? <FieldError>{errors.birthDate}</FieldError> : null}
                  </Field>
                ) : null}
                {asksDocument ? (
                  <Field data-invalid={errors.docNumber ? true : undefined}>
                    <FieldLabel htmlFor="np-doc">Documento</FieldLabel>
                    <div className="flex min-w-0 flex-col gap-2">
                      <DocTypeChoice
                        label="Tipo de documento"
                        value={docType as IdentityDocType}
                        options={docTypes}
                        onChange={(next) =>
                          set({ docType: next, docCountry: "" }, "docNumber", "docCountry")
                        }
                      />
                      <Input
                        id="np-doc"
                        maxLength={20}
                        value={draft.docNumber}
                        aria-invalid={errors.docNumber ? true : undefined}
                        onChange={(event) => set({ docNumber: event.target.value }, "docNumber")}
                      />
                    </div>
                    {errors.docNumber ? <FieldError>{errors.docNumber}</FieldError> : null}
                  </Field>
                ) : null}
                {asksDocument && asksDocumentCountry(profile, docType) ? (
                  <Field data-invalid={errors.docCountry ? true : undefined}>
                    <FieldLabel htmlFor="np-doc-country">País que emitió el documento</FieldLabel>
                    <SearchSelect
                      id="np-doc-country"
                      label="País que emitió el documento"
                      placeholder="Buscar país…"
                      value={draft.docCountry}
                      options={countryChoices(profile.country)}
                      invalid={Boolean(errors.docCountry)}
                      onChange={(value) => set({ docCountry: value }, "docCountry")}
                    />
                    {errors.docCountry ? <FieldError>{errors.docCountry}</FieldError> : null}
                  </Field>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  Su salud la pregunta quien lo atiende, en Antecedentes.
                </p>
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="np-privacy" className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox
                id="np-privacy"
                checked={draft.privacy}
                onCheckedChange={(checked) => set({ privacy: checked === true })}
              />
              <span>Le informé cómo usamos sus datos.</span>
            </label>
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
          who={who}
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
 * El tipo de documento: los tres más usados del país a la vista y «Otro», que
 * abre la lista con los demás (pocos y raros: no merecen un botón cada uno).
 */

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
            <PersonAvatar name={row.displayName} className="size-9" fallbackClassName="text-xs" decorative />
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
