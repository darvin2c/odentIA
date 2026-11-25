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
  cn,
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
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Check } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { brandedQrDataUrl } from "../../lib/branded-qr"
import { useCan, useMyUserId } from "../../lib/crm"
import { useClinicalProfile, useOrgProfile } from "../../lib/org"
import { fetchRegistrationConfig } from "../../lib/patient-registration"
import { hcLabel } from "../../lib/patients"
import { fetchPerson, type PersonListItem, type PersonPage, personQueryKey } from "../../lib/people"
import { asksDocumentCountry, countryChoices } from "../../lib/person-data"
import { ChoiceButtons } from "../choice-buttons"
import { type PickedPerson, PersonPicker } from "../person-picker"
import { SearchSelect } from "../settings/search-select"
import { DocTypeChoice } from "./doc-type-choice"
import { placeErrors } from "./form-errors"
import { SendPersonalLinkButton } from "./send-personal-link"

/**
 * El campo de la fecha guarda desde el principio el renglón de la edad («38 años»): al
 * aparecer, empujaba el formulario y el clic en la casilla del aviso caía en el vacío
 * (repaso final de la ficha del 10 nov, B9). 2,25 rem del campo + 0,25 de espacio + 1,25 del renglón.
 */
const BIRTH_DATE_ROOM = "min-h-[3.75rem] content-start"

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
  { value: "paciente", label: "El paciente, en su celular" },
  { value: "equipo", label: "Yo, ahora" },
]
/** Lo que respondió de novedades y promociones, en persona: «Sí, aceptó» primero. */
const PROMOTION_OPTIONS: ReadonlyArray<{ value: "si" | "no"; label: string }> = [
  { value: "si", label: "Sí, aceptó" },
  { value: "no", label: "No aceptó" },
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
  /** Novedades y promociones: se le pregunta siempre; vacío mientras no responda. */
  promotions: "" | "si" | "no"
  /**
   * Su responsable no está registrado y se escribe aquí (mesa del 25 nov, entrega 1): nace con el
   * niño, en el mismo registro. Sus nombres, apellidos y celular.
   */
  guardianNew: boolean
  guardianGivenNames: string
  guardianSurnames: string
  guardianPhone: string | null
  /** Con «Otro familiar», qué es para él o ella («abuela»), si se dijo. */
  relationDetail: string
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
  promotions: "",
  guardianNew: false,
  guardianGivenNames: "",
  guardianSurnames: "",
  guardianPhone: null,
  relationDetail: "",
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
  // El responsable nuevo: cada error en su campo, no en los del niño (mesa del 25 nov).
  representative: "guardianGivenNames",
  "representative.givenNames": "guardianGivenNames",
  "representative.familyName": "guardianSurnames",
  "representative.displayName": "guardianSurnames",
  "representative.phone": "guardianPhone",
  "representative.relationshipDetail": "relationDetail",
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
  // Alguien a su cargo (un niño sin celular): lo completa el equipo ahora o su responsable en el suyo,
  // nunca «el paciente, en su celular» por omisión (QA de la ficha del 9 nov).
  if (target.kind === "dependent") return { ...EMPTY, who: "equipo" }
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
  const fromPerson = target.kind === "person" ? target.person : null
  // Un menor desde «Nuevo paciente»: se elige aquí a su responsable y el cajón sigue como «a su cargo».
  const [chosenGuardian, setChosenGuardian] = useState<PersonPage | null>(null)
  const [guardianPick, setGuardianPick] = useState<PickedPerson | null>(null)
  const guardian = target.kind === "dependent" ? target.person : chosenGuardian
  const dependent = guardian !== null
  // Al cerrar se olvida: la próxima vez empieza como «Nuevo paciente».
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (open) return
    setChosenGuardian(null)
    setGuardianPick(null)
  }, [open])
  /** Elegir (o cambiar) al responsable: lo que llega después de cerrar no reabre nada. */
  const pickGuardian = (person: PickedPerson | null) => {
    setGuardianPick(person)
    setChosenGuardian(null)
    if (!person) return
    void fetchPerson(person.id)
      .then((page) => {
        if (openRef.current) setChosenGuardian(page.data)
      })
      .catch(() => setGuardianPick(null))
  }
  const guardianFirst = guardian?.displayName.split(" ")[0] ?? "esta persona"

  const [stage, setStage] = useState<Stage>("form")
  const [picked, setPicked] = useState<PersonPage | null>(fromPerson)
  // Lo que se había escrito antes de tocar «Es esta persona»: «No es esta persona» lo devuelve.
  const [typedBeforePick, setTypedBeforePick] = useState<Draft | null>(null)
  const [showNotice, setShowNotice] = useState(false)
  const [created, setCreated] = useState<Created | null>(null)
  // No se pudo anotar lo que dijo de sus mensajes: se dice al terminar, sin deshacer el registro.
  const [permissionNote, setPermissionNote] = useState<string | null>(null)
  const submission = useRef<string>(crypto.randomUUID())
  const myUserId = useMyUserId()
  // De quién y para qué: «Nuevo paciente», o a cargo de una persona (otra pestaña o persona no lo ve).
  const draftKey = `odentia:nuevo-paciente:${myUserId}:${target.kind === "new" ? "nuevo" : `${target.kind}:${target.person.id}`}`
  const [resumed, setResumed] = useState<Partial<Draft> | null>(null)
  const clearSavedDraft = () => {
    try {
      window.sessionStorage.removeItem(draftKey)
    } catch {
      // Sin almacenamiento no había nada guardado.
    }
    setResumed(null)
  }


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
      // Lo que dijo de sus mensajes lo guarda el servidor a nombre de quien otorga: el responsable
      // de un menor, no el menor (mesa del 25 nov). Antes se anotaba después, en la persona del niño.
      ...(current.privacy ? { acceptsReminders: true } : {}),
      ...(current.privacy && current.promotions ? { acceptsMessages: current.promotions === "si" } : {}),
    }
    // Otro familiar (su abuela) lo acompaña y recibe sus avisos, sin representarlo (decisión 2).
    const relationshipOf = (relation: Relation | null) =>
      relation === "otro" ? "family" : minorOf(current) || relation === "tutor" ? "guardian" : "family"
    const detailOf = (relation: Relation | null) =>
      relation === "otro" ? trimmed(current.relationDetail) || "Familiar" : relation ? RELATION_WORDS[relation] : "Familiar"
    if (!guardian && current.guardianNew && minorOf(current)) {
      const givenNames = trimmed(current.guardianGivenNames)
      const surnames = trimmed(current.guardianSurnames)
      answers.representative = {
        displayName: composeDisplayName({ givenNames, familyName: surnames }),
        ...(givenNames ? { givenNames } : {}),
        ...(surnames ? { familyName: surnames } : {}),
        relationship: relationshipOf(current.relation),
        relationshipDetail: detailOf(current.relation),
        ...(current.guardianPhone ? { phone: current.guardianPhone } : {}),
      } as RegistrationAnswers["representative"]
      return { answers }
    }
    if (guardian) {
      const relation = current.relation
      const word = detailOf(relation)
      const relationship = relationshipOf(relation)
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
  function draftErrors(current: Draft): Record<string, string> {
    const found: Record<string, string> = {}
    if (!current.givenNames.trim()) found.givenNames = "Escribe los nombres"
    if (!current.surnames.trim()) found.surnames = "Escribe los apellidos"
    // Sin celular se registra igual (una urgencia, un turista, un adulto mayor): el campo
    // avisa que no le llegarán sus avisos, sin frenar. Un número a medias sí lo dice el
    // campo («le faltan dígitos»): ese no se guarda a medias.
    if (dependent && !current.relation) found.relation = `Elige qué es ${guardianFirst} para él o ella`
    // Un menor sin responsable: se elige o se escribe aquí mismo (mesa del 25 nov).
    if (!dependent && minorOf(current)) {
      if (!current.guardianNew) found.guardianGivenNames = "Busca a quien viene con él o ella, o regístrala aquí"
      else {
        const newFirst = current.guardianGivenNames.trim() || "esta persona"
        if (!current.guardianGivenNames.trim()) found.guardianGivenNames = "Escribe sus nombres"
        if (!current.guardianSurnames.trim()) found.guardianSurnames = "Escribe sus apellidos"
        if (!current.guardianPhone) found.guardianPhone = "Escribe su celular: ahí le avisamos las citas"
        if (!current.relation) found.relation = `Elige qué es ${newFirst} para él o ella`
      }
    }
    if (!current.promotions) found.promotions = "Pregúntale y elige una opción"
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
      onSubmit: ({ value, formApi }) => placeErrors(formApi, draftErrors(value)),
    },
    onSubmit: async ({ value }) => {
      const result = await register.mutateAsync(value)
      // Lo que dijo de sus mensajes ya quedó con el registro, a nombre de quien otorga.
      clearSavedDraft()
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
    setTypedBeforePick(null)
    setShowNotice(false)
    setCreated(null)
    setPermissionNote(null)
    // Lo que se había escrito y no se registró (sonó el teléfono): sigue ahí, con el mismo envío,
    // para que «Registrar» no cree a otro igual (mesa del 25 nov, C3 y D5).
    const saved = readSavedDraft(draftKey)
    setResumed(saved ? saved.values : null)
    form.reset(saved ? { ...initialDraft(target), ...saved.values } : initialDraft(target))
    submission.current = saved?.submissionId ?? crypto.randomUUID()
    // Si se archivó mientras tanto, `pickGuardian` lo deja sin elegir y vuelve el buscador.
    if (saved?.guardian && target.kind !== "dependent") pickGuardian(saved.guardian)
  }, [open])
  // Se guarda en la pestaña mientras se escribe: de esta clínica, de quien escribe y de este destino.
  useEffect(() => {
    if (!open || stage !== "form" || created) return
    const touched = values.givenNames || values.surnames || values.phone || values.guardianGivenNames
    if (touched) writeSavedDraft(draftKey, { values, submissionId: submission.current, guardian: guardianPick })
  }, [open, stage, created, values, draftKey, guardianPick])

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
  // Si la fecha deja de ser de un menor, el responsable elegido aquí ya no corresponde.
  useEffect(() => {
    if (minor || target.kind === "dependent" || (!chosenGuardian && !guardianPick)) return
    setChosenGuardian(null)
    setGuardianPick(null)
  }, [minor, target.kind, chosenGuardian, guardianPick])
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
    setTypedBeforePick(typed)
    form.reset({ ...draftFromPerson(page.data), phone: page.data.phone ?? typed.phone, who: typed.who })
    setStage("form")
  }

  /** Escribir aquí a su responsable, con lo que se buscó como sus nombres y apellidos. */
  const startNewGuardian = (query: string) => {
    const [first = "", ...rest] = query.trim().split(/\s+/)
    setGuardianPick(null)
    setChosenGuardian(null)
    form.setFieldValue("guardianNew", true)
    if (first) form.setFieldValue("guardianGivenNames", first)
    if (rest.length) form.setFieldValue("guardianSurnames", rest.join(" "))
  }
  // La persona nueva también se busca antes de crearla, por nombre y celular: el mismo celular de
  // un contacto de WhatsApp no la vuelve la misma persona, pero se pregunta (mesa del 25 nov, D3).
  const guardianFirstSurname = values.guardianSurnames.trim().split(/\s+/)[0] ?? ""
  const guardianNameProbe =
    values.guardianGivenNames.trim().length >= 2 && guardianFirstSurname.length >= 2
      ? `${values.guardianGivenNames.trim()} ${guardianFirstSurname}`
      : ""
  const guardianDigits = (values.guardianPhone ?? "").replace(/\D/g, "")
  const guardianPhoneProbe = guardianDigits.length >= 8 ? guardianDigits.slice(-8) : ""
  const [guardianProbes, setGuardianProbes] = useState<string[]>([])
  useEffect(() => {
    const next = values.guardianNew ? [guardianNameProbe, guardianPhoneProbe].filter(Boolean) : []
    const timer = setTimeout(() => setGuardianProbes(next), 350)
    return () => clearTimeout(timer)
  }, [values.guardianNew, guardianNameProbe, guardianPhoneProbe])
  const guardianMatches = useQuery({
    queryKey: ["people", "new-guardian-matches", guardianProbes],
    queryFn: async () => {
      const lists = await Promise.all(
        guardianProbes.map((probe) =>
          apiFetch<{ data: PersonListItem[] }>(`/api/people?ver=todos&limit=4&q=${encodeURIComponent(probe)}`).then((r) => r.data),
        ),
      )
      const unique = new Map<string, PersonListItem>()
      for (const row of lists.flat()) if (!unique.has(row.id)) unique.set(row.id, row)
      return [...unique.values()].slice(0, 4)
    },
    enabled: open && guardianProbes.length > 0,
    placeholderData: keepPreviousData,
  })

  const name = values.givenNames.trim() || "esta persona"
  const tradeName = orgProfile.data?.tradeName?.trim()
  /** Con «Otro familiar», qué es de él o ella: «abuela», «tía». Opcional. */
  const relationDetailField = (
    <form.AppField name="relationDetail">
      {(field) => (
        <field.TextField
          label={`¿Qué es de ${name}? (opcional)`}
          id="np-relation-detail"
          maxLength={60}
          placeholder="abuela, tía…"
        />
      )}
    </form.AppField>
  )
  // Con un menor, se le pregunta a quien lo trae y queda a su nombre (mesa del 25 nov).
  const responsibleName = minor
    ? (guardian?.displayName.split(" ")[0] ?? (values.guardianNew ? values.guardianGivenNames.trim().split(/\s+/)[0] || null : null))
    : null
  const promotionsQuestion = `¿${responsibleName ? `${responsibleName} acepta` : "Acepta"} recibir novedades y promociones${tradeName ? ` de ${tradeName}` : ""} por WhatsApp?`
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
      // Lo escrito queda en la pestaña: cerrar no pierde nada y ya no pregunta (mesa del 25 nov, decisión 3).
      isDirty={false}
      error={stage === "form" ? surface.error : null}
      hideSubmit={stage !== "form"}
      cancelLabel={stage === "done" ? "Listo" : "Cancelar"}
      submitLabel={guardian || (minor && values.guardianNew) ? `Registrar a ${name}` : "Registrar"}
      className="data-[swipe-axis=x]:sm:[--drawer-content-width:min(32rem,calc(100vw-2rem))]"
    >
      {stage === "form" ? (
        <div className="flex min-w-0 flex-col gap-5">
          {resumed && !picked ? (
            <p className="flex flex-wrap items-center gap-x-2 rounded-2xl bg-muted px-3 py-2 text-sm" role="status">
              <span>Seguías con {[resumed.givenNames, resumed.surnames].filter(Boolean).join(" ") || "lo que escribiste"}.</span>
              <Button
                type="button"
                variant="link"
                className="h-auto p-0"
                onClick={() => {
                  clearSavedDraft()
                  setChosenGuardian(null)
                  setGuardianPick(null)
                  form.reset(initialDraft(target))
                  submission.current = crypto.randomUUID()
                }}
              >
                Empezar de cero
              </Button>
            </p>
          ) : null}
          {picked && typedBeforePick ? (
            <p className="flex flex-wrap items-center gap-x-2 rounded-2xl bg-muted px-3 py-2 text-sm" role="status">
              <span>Registras a {picked.displayName}, que ya estaba en la clínica.</span>
              <Button
                type="button"
                variant="link"
                className="h-auto p-0"
                onClick={() => {
                  // Se equivocó de persona: vuelve lo que había escrito, como si no la hubiera elegido.
                  setPicked(null)
                  form.reset(typedBeforePick)
                  setTypedBeforePick(null)
                }}
              >
                No es esta persona: volver a lo que escribí
              </Button>
            </p>
          ) : null}
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
          {guardian && values.relation === "otro" ? relationDetailField : null}

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
                      className={BIRTH_DATE_ROOM}
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
                    : field.state.value
                      ? "Aquí le avisamos sus citas por WhatsApp."
                      : // Avisa sin frenar: sin celular también se registra.
                        "Aquí le avisamos sus citas por WhatsApp. Sin celular no le llegan los recordatorios; puedes agregarlo después."
                }
              />
            )}
          </form.AppField>

          {lookup ? (
            <MatchesNote
              searching={probes.length > 0 && matches.isFetching && !matches.data}
              refreshing={probes.length > 0 && matches.isFetching && !!matches.data}
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
                    label={`Documento de ${guardian?.displayName} (si lo tienes)`}
                    id="np-guardian-doc"
                    // No frena registrarlo: la firma de un consentimiento lo pide si falta (QA de la ficha del 9 nov).
                    description="Al ser menor, queda como su representante legal. Si no lo trae, regístralo igual: se le pide al firmar un consentimiento."
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
                  options={
                    dependent
                      ? [
                          { value: "paciente", label: `${guardianFirst}, en su celular` },
                          { value: "equipo", label: "Yo, ahora" },
                        ]
                      : WHO_OPTIONS
                  }
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
                            className={BIRTH_DATE_ROOM}
                          />
                        )}
                      </field.Control>
                    )}
                  </form.AppField>
                ) : null}
                {/* Un menor nuevo: se elige aquí a su responsable. Si ya se eligió a una persona que existe,
                    se registra desde la página de su responsable, para no crearle otra ficha. */}
                {!dependent && minor && picked ? (
                  <p className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
                    Es menor de edad: regístralo desde la página de su madre, padre o tutor, con «Registrar a alguien a su cargo».
                  </p>
                ) : target.kind !== "dependent" && minor ? (
                  <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
                    <p>Es menor de edad. ¿Quién viene con él o ella?</p>
                    {values.guardianNew ? (
                      <>
                        <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                          Persona nueva
                          <Button
                            type="button"
                            variant="link"
                            className="h-auto p-0"
                            onClick={() => form.setFieldValue("guardianNew", false)}
                          >
                            Mejor buscarla
                          </Button>
                        </p>
                        <form.AppField name="guardianGivenNames">
                          {(field) => <field.TextField label="Sus nombres" id="np-guardian-given" maxLength={100} />}
                        </form.AppField>
                        <form.AppField name="guardianSurnames">
                          {(field) => <field.TextField label="Sus apellidos" id="np-guardian-surnames" maxLength={200} />}
                        </form.AppField>
                        <form.AppField name="guardianPhone">
                          {(field) => (
                            <field.PhoneField
                              label="Su celular"
                              id="np-guardian-phone"
                              defaultCountry={defaultCountry}
                              description={`A este número le avisamos las citas de ${name}.`}
                            />
                          )}
                        </form.AppField>
                        {guardianProbes.length > 0 ? (
                          <MatchesNote
                            searching={guardianMatches.isFetching && !guardianMatches.data}
                            refreshing={guardianMatches.isFetching && !!guardianMatches.data}
                            asked={guardianMatches.isSuccess || guardianMatches.isPlaceholderData}
                            rows={guardianMatches.data ?? []}
                            alwaysPick
                            onPick={(row) => {
                              form.setFieldValue("guardianNew", false)
                              pickGuardian({ id: row.id, name: row.displayName, phone: row.phone })
                            }}
                          />
                        ) : null}
                        <form.AppField name="relation">
                          {(field) => (
                            <field.Group legend={`¿Qué es ${values.guardianGivenNames.trim().split(/\s+/)[0] || "esta persona"} para él o ella?`}>
                              {(control) => (
                                <ChoiceButtons
                                  id={control.id}
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
                        {values.relation === "otro" ? relationDetailField : null}
                        <p className="text-muted-foreground">
                          {values.relation === "otro"
                            ? "Lo acompaña y recibe sus avisos. Los consentimientos y presupuestos los firma su madre, padre o tutor."
                            : "Decide por él o ella y recibe sus avisos."}
                        </p>
                      </>
                    ) : (
                      <>
                        <form.AppField name="guardianGivenNames">
                          {(field) => (
                            <field.Control label="Su responsable" id="np-guardian">
                              {(control) => (
                                <PersonPicker
                                  id={control.id}
                                  invalid={control.invalid}
                                  onBlur={control.onBlur}
                                  value={guardianPick}
                                  onChange={pickGuardian}
                                  {...(can("patients.write")
                                    ? {
                                        onCreate: (query: string) => startNewGuardian(query),
                                        createLabel: (query: string) => `Registrar a «${query}» aquí`,
                                      }
                                    : {})}
                                />
                              )}
                            </field.Control>
                          )}
                        </form.AppField>
                        {can("patients.write") && !guardianPick ? (
                          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => startNewGuardian("")}>
                            No está: registrarla aquí
                          </Button>
                        ) : null}
                      </>
                    )}
                  </div>
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
              {(field) => (
                <field.CheckboxField
                  label={
                    responsibleName
                      ? `Le informé a ${responsibleName} cómo usamos los datos de ${name} y que le escribiremos por WhatsApp sobre sus citas.`
                      : "Le informé cómo usamos sus datos y que le escribiremos por WhatsApp sobre sus citas."
                  }
                  id="np-privacy"
                />
              )}
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

          <form.AppField name="promotions">
            {(field) => (
              <field.Group id="np-promotions" legend={promotionsQuestion}>
                {(control) => (
                  <ChoiceButtons
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    columns={2}
                    value={field.state.value || null}
                    options={PROMOTION_OPTIONS}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        </div>
      ) : null}

      {stage === "done" && permissionNote ? (
        <p role="status" className="mb-4 rounded-xl bg-warning-soft p-3 text-sm text-warning">
          {permissionNote}
        </p>
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
  refreshing = false,
  asked,
  rows,
  onPick,
  alwaysPick = false,
}: {
  searching: boolean
  /** Vuelve a buscar con lo nuevo que se escribió: lo anterior sigue a la vista, atenuado. */
  refreshing?: boolean
  asked: boolean
  rows: PersonListItem[]
  onPick: (row: PersonListItem) => void
  /** Elegirla siempre (el responsable de un menor), aunque ya sea paciente: no se abre su página. */
  alwaysPick?: boolean
}) {
  // Mientras se escribe, el recuadro no se achica: lo que viene debajo no salta y un clic
  // para salir del campo no cae en «Es esta persona» (QA del 8 nov: cambió el formulario por
  // otra persona sin querer). Vuelve a su alto cuando la búsqueda termina: con «es nuevo» quedaba
  // un hueco en blanco del alto de la lista anterior (QA de la ficha del 9 nov).
  const box = useRef<HTMLDivElement>(null)
  const [minHeight, setMinHeight] = useState(0)
  const active = searching || refreshing
  useLayoutEffect(() => {
    if (!active) {
      if (minHeight !== 0) setMinHeight(0)
      return
    }
    const height = box.current?.offsetHeight ?? 0
    if (height > minHeight) setMinHeight(height)
  })
  return (
    <div ref={box} style={active && minHeight ? { minHeight } : undefined} className="min-w-0">
      <MatchesNoteBody searching={searching} refreshing={refreshing} asked={asked} rows={rows} onPick={onPick} alwaysPick={alwaysPick} />
    </div>
  )
}

function MatchesNoteBody({
  searching,
  refreshing,
  asked,
  rows,
  onPick,
  alwaysPick,
}: {
  searching: boolean
  refreshing: boolean
  asked: boolean
  rows: PersonListItem[]
  onPick: (row: PersonListItem) => void
  alwaysPick: boolean
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
        {refreshing ? <Spinner className="size-4" aria-hidden /> : <Check aria-hidden className="size-4 shrink-0" />}
        No hay nadie con estos datos: es nuevo.
      </p>
    )
  }
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-2 rounded-3xl bg-warning-soft p-3", refreshing && "opacity-70")}
      aria-live="polite"
      aria-busy={refreshing || undefined}
    >
      <span className="flex items-center gap-2 px-1 text-sm font-medium text-warning">
        ¿Es alguna de estas personas?
        {refreshing ? <Spinner className="size-3.5" aria-hidden /> : null}
      </span>
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
            {/* Los dos iguales: el aviso no empuja a elegir a nadie. */}
            <Button type="button" size="sm" variant="secondary" onClick={() => onPick(row)}>
              {row.patient && !alwaysPick ? "Abrir" : "Es esta persona"}
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

/** Lo escrito en «Nuevo paciente» que no se registró: en la pestaña, con su envío (mesa del 25 nov). */
interface SavedDraft {
  values: Partial<Draft>
  submissionId: string
  /** La persona ya registrada que se eligió como su responsable: se vuelve a leer al recuperar. */
  guardian?: PickedPerson | null
}

function readSavedDraft(key: string): SavedDraft | null {
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SavedDraft
    return parsed && typeof parsed.submissionId === "string" && parsed.values ? parsed : null
  } catch {
    // Sin almacenamiento del navegador, empieza en blanco, como antes.
    return null
  }
}

function writeSavedDraft(key: string, draft: SavedDraft): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(draft))
  } catch {
    // Sin almacenamiento no se guarda: no traba el registro.
  }
}
