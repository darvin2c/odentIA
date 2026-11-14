import {
  type BOTTLE_ANSWERS,
  type BRUSHER_ANSWERS,
  CIGARETTE_BAND_LABELS,
  CIGARETTE_BANDS,
  type CigaretteBand,
  clinicalProfileFor,
  composeDisplayName,
  DECLARED_CHILD_CONDITION_OPTIONS,
  DECLARED_CONDITION_OPTIONS,
  DOC_TYPE_LABELS,
  EDUCATION_LEVEL_LABELS,
  EDUCATION_LEVELS,
  type IdentityDocType,
  identityDocumentError,
  INSURANCE_TYPE_LABELS,
  type InsuranceType,
  isChildAge,
  isMinor,
  isRealDate,
  KINSHIP,
  KINSHIP_LABELS,
  MARITAL_STATUS_LABELS,
  type PACIFIER_ANSWERS,
  REFERRAL_KIND_LABELS,
  REFERRAL_KINDS,
  type RegistrationAnswers,
  type RegistrationConfig,
  REGISTRATION_FIELDS,
  type RegistrationFieldKey,
  registrationFieldApplies,
  registrationFieldAsked,
  registrationHealthSection,
  SEX_LABELS,
  type SWEETS_ANSWERS,
  validateDemographics,
  validateRegistrationAnswers,
  type VisitAnswerInput,
  type VisitQuestions,
} from "@odentia/clinical"
import {
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import {
  BirthDateInput,
  type FieldControl,
  normalizeCountry,
  PhoneInput,
  setSubmitErrors,
  submitForm,
  useAppForm,
  useFieldControl,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import type { AnyFormApi } from "@tanstack/react-form"
import { useStore } from "@tanstack/react-form"
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react"
import type { AddressSource } from "../../lib/address-suggestions"
import {
  clearDeviceDraft,
  DEVICE_DRAFT_PROMISE,
  type DeviceDraft,
  type DeviceDraftStep,
  deviceDraftPlace,
  deviceDraftsWork,
  draftResumeWords,
  draftUntilWords,
  readDeviceDraft,
  sweepDeviceDrafts,
  writeDeviceDraft,
} from "../../lib/device-draft"
import { activeOrgLocale } from "../../lib/locale"
import { asksDocumentCountry, countryChoices } from "../../lib/person-data"
import { productUi } from "../../product/product-ui"
import { AddressStreetField } from "../address/address-street-field"
import { ChoiceButtons, MultiChoiceButtons } from "../choice-buttons"
import { SearchSelect } from "../settings/search-select"
import { DocTypeChoice } from "./doc-type-choice"
import { placeErrors } from "./form-errors"
import { BLOOD_GROUP_LABELS } from "./patient-health-fields"

/**
 * El registro que llena el paciente (código QR, enlace de la clínica) y su
 * vista previa en Configuración: el Questionnaire de shadcn con una pantalla
 * por tema («Tus datos», «Tu documento», «¿Cómo te contactamos?», «Tu
 * salud»…), cada una con sus campos juntos, «(opcional)» en lo que puede
 * quedar en blanco y «Saltar» cuando todo el tema es opcional. Solo aparece lo
 * que la clínica pide. Al enviar valida con la misma regla del servidor
 * (`validateRegistrationAnswers`) y lo que falla lleva a su pantalla y su campo.
 *
 * «Nombres» y «Apellidos» son dos campos (ADR 0058).
 */
type Respondent = "patient" | "representative"
type Declared = "" | "none" | "recorded" | "unknown"
type Relation = "" | "guardian" | "family" | "other"
type YesNo = "" | "si" | "no"
type YesNoUnknown = "" | "si" | "no" | "nose"
type BottleAnswer = (typeof BOTTLE_ANSWERS)[number]
type PacifierAnswer = (typeof PACIFIER_ANSWERS)[number]
type SweetsAnswer = (typeof SWEETS_ANSWERS)[number]
type BrusherAnswer = (typeof BRUSHER_ANSWERS)[number]

interface Draft {
  respondent: Respondent
  givenNames: string
  surnames: string
  birthDate: string
  sex: string
  nationality: string
  birthPlace: string
  repName: string
  repRelation: Relation
  repPhone: string
  repPhoneDigits: number
  repDoc: string
  docType: IdentityDocType | null
  docCountry: string
  docNumber: string
  phone: string
  phoneDigits: number
  email: string
  address: string
  addressCity: string
  addressReference: string
  emergencyName: string
  emergencyPhone: string
  emergencyPhoneDigits: number
  emergencyRelationship: string
  insurance: string
  insurerName: string
  affiliationNumber: string
  allergies: Declared
  allergiesText: string
  /** «¿Qué te pasó?»: la reacción, para cada alergia que dijo. */
  allergiesReaction: string
  conditions: Declared
  /** Las enfermedades que marcó de la lista; `conditionsText` es «Otra». */
  conditionsPicked: string[]
  conditionsText: string
  /** «Tus medicinas»: anticoagulantes, medicinas para los huesos y «algún otro». */
  anticoagulants: Declared
  anticoagulantsText: string
  boneMedicines: Declared
  boneMedicinesText: string
  medications: Declared
  medicationsText: string
  /** odentIA: el corazón (antibiótico antes de atender) y la anestesia. */
  heartRisk: YesNoUnknown
  heartAntibiotic: YesNoUnknown
  anesthesia: YesNoUnknown
  bloodGroup: string
  pregnant: YesNoUnknown
  pregnancyWeeks: string
  surgeries: YesNo
  surgeriesText: string
  hospitalized: YesNo
  hospitalizedText: string
  transfusion: YesNo
  transfusionText: string
  dentalLast: string
  dentalExperience: string
  dentalAnxiety: string
  brushing: string
  floss: YesNo
  bruxism: YesNoUnknown
  habits: string[]
  /** «De pequeño» de un menor de 12, lo que cuenta quien lo cuida (odentIA). */
  bottle: "" | BottleAnswer
  pacifier: "" | PacifierAnswer
  sweets: "" | SweetsAnswer
  fluoride: YesNoUnknown
  brusher: "" | BrusherAnswer
  /** latidIA (issue 229): lactancia, tabaco y alcohol. */
  breastfeeding: YesNo
  tobacco: "" | "nunca" | "fuma" | "dejo"
  /** Cuántos al día, solo de quien fuma. */
  cigarettes: "" | CigaretteBand
  alcohol: "" | "no" | "ocasional" | "frecuente"
  maritalStatus: string
  educationLevel: string
  occupation: string
  origin: string
  /** «Cómo nos conoció» de la lista (decisión 3 de Reportes v2); `referralSource` es lo que dijo si eligió «Otro». */
  referralKind: string
  referralSource: string
  messages: "" | "si" | "no"
  privacy: boolean
  /** «Tu visita», antes de su cita: a qué viene, si le duele y cuánto, algo más. Todo opcional. */
  visitReason: string
  visitPain: YesNo
  visitPainLevel: string
  visitMore: string
}

const EMPTY: Draft = {
  respondent: "patient",
  givenNames: "",
  surnames: "",
  birthDate: "",
  sex: "",
  nationality: "",
  birthPlace: "",
  repName: "",
  repRelation: "",
  repPhone: "",
  repPhoneDigits: 0,
  repDoc: "",
  docType: null,
  docCountry: "",
  docNumber: "",
  phone: "",
  phoneDigits: 0,
  email: "",
  address: "",
  addressCity: "",
  addressReference: "",
  emergencyName: "",
  emergencyPhone: "",
  emergencyPhoneDigits: 0,
  emergencyRelationship: "",
  insurance: "",
  insurerName: "",
  affiliationNumber: "",
  allergies: "",
  allergiesText: "",
  allergiesReaction: "",
  conditions: "",
  conditionsPicked: [],
  conditionsText: "",
  anticoagulants: "",
  anticoagulantsText: "",
  boneMedicines: "",
  boneMedicinesText: "",
  medications: "",
  medicationsText: "",
  heartRisk: "",
  heartAntibiotic: "",
  anesthesia: "",
  bloodGroup: "",
  pregnant: "",
  pregnancyWeeks: "",
  surgeries: "",
  surgeriesText: "",
  hospitalized: "",
  hospitalizedText: "",
  transfusion: "",
  transfusionText: "",
  dentalLast: "",
  dentalExperience: "",
  dentalAnxiety: "",
  brushing: "",
  floss: "",
  bruxism: "",
  habits: [],
  bottle: "",
  pacifier: "",
  sweets: "",
  fluoride: "",
  brusher: "",
  breastfeeding: "",
  tobacco: "",
  cigarettes: "",
  alcohol: "",
  maritalStatus: "",
  educationLevel: "",
  occupation: "",
  origin: "",
  referralKind: "",
  referralSource: "",
  messages: "",
  privacy: false,
  visitReason: "",
  visitPain: "",
  visitPainLevel: "",
  visitMore: "",
}
/** La escala del dolor, de 0 (sin dolor) a 10 (el peor): un grupo que se recorre con flechas. */
const PAIN_LEVELS = Array.from({ length: 11 }, (_, level) => ({ value: String(level), label: String(level) }))

const DECLARED: ReadonlyArray<{ value: Exclude<Declared, "">; label: string }> = [
  { value: "none", label: "No" },
  { value: "recorded", label: "Sí" },
  { value: "unknown", label: "No sé" },
]
const YES_NO: ReadonlyArray<{ value: Exclude<YesNo, "">; label: string }> = [
  { value: "no", label: "No" },
  { value: "si", label: "Sí" },
]
const YES_NO_UNKNOWN: ReadonlyArray<{ value: Exclude<YesNoUnknown, "">; label: string }> = [
  { value: "no", label: "No" },
  { value: "si", label: "Sí" },
  { value: "nose", label: "No sé" },
]
const RELATIONS: ReadonlyArray<{ value: Exclude<Relation, "">; label: string; detail: string }> = [
  { value: "guardian", label: "Madre, padre o tutor", detail: "Madre, padre o tutor" },
  { value: "family", label: "Familiar", detail: "Familiar" },
  { value: "other", label: "Otra relación", detail: "Otra relación" },
]
const EXPERIENCES = [
  { value: "positiva", label: "Bien" },
  { value: "regular", label: "Regular" },
  { value: "traumatica", label: "Mal" },
] as const
const TOBACCO_OPTIONS: ReadonlyArray<{ value: Exclude<Draft["tobacco"], "">; label: string }> = [
  { value: "nunca", label: "Nunca fumé" },
  { value: "fuma", label: "Fumo" },
  { value: "dejo", label: "Lo dejé" },
]
const CIGARETTE_OPTIONS = CIGARETTE_BANDS.map((value) => ({
  value,
  label: CIGARETTE_BAND_LABELS[value].replace(/^./, (letter) => letter.toLocaleUpperCase("es")),
}))
const CONDITION_OPTIONS = DECLARED_CONDITION_OPTIONS.map((value) => ({ value, label: value }))
/** Las de un niño, para quien lo cuida: sin «presión alta» ni radioterapia. */
const CHILD_CONDITION_OPTIONS = DECLARED_CHILD_CONDITION_OPTIONS.map((value) => ({ value, label: value }))
/** «De pequeño», con las palabras del dibujo de la mesa (entrega 7). */
const BOTTLE_OPTIONS: ReadonlyArray<{ value: BottleAnswer; label: string }> = [
  { value: "no", label: "No" },
  { value: "si", label: "Sí" },
  { value: "ya_no", label: "Ya no" },
]
const PACIFIER_OPTIONS: ReadonlyArray<{ value: PacifierAnswer; label: string }> = [
  { value: "no", label: "No" },
  { value: "chupon", label: "Chupón" },
  { value: "dedo", label: "Dedo" },
]
const SWEETS_OPTIONS: ReadonlyArray<{ value: SweetsAnswer; label: string }> = [
  { value: "casi_nunca", label: "Casi nunca" },
  { value: "1_a_3", label: "1 a 3" },
  { value: "4_o_mas", label: "4 o más" },
]
const FLUORIDE_OPTIONS: ReadonlyArray<{ value: Exclude<YesNoUnknown, "">; label: string }> = [
  { value: "si", label: "Sí" },
  { value: "no", label: "No" },
  { value: "nose", label: "No sé" },
]
/** «Él solo» o «Ella sola» según su sexo; sin él, «Sin ayuda». */
const brusherOptions = (sex: string): ReadonlyArray<{ value: BrusherAnswer; label: string }> => [
  { value: "solo", label: sex === "F" ? "Ella sola" : sex === "M" ? "Él solo" : "Sin ayuda" },
  { value: "adulto", label: "Un adulto" },
  { value: "ambos", label: "Los dos" },
]
/** Sí, No o No sé de la entrevista, como lo guarda la ficha. */
const INTERVIEW_OF: Record<Exclude<YesNoUnknown, "">, "si" | "no" | "no_sabe"> = { si: "si", no: "no", nose: "no_sabe" }
const ALCOHOL_OPTIONS: ReadonlyArray<{ value: Exclude<Draft["alcohol"], "">; label: string }> = [
  { value: "no", label: "No" },
  { value: "ocasional", label: "A veces" },
  { value: "frecuente", label: "Seguido" },
]
const ANXIETY = [
  { value: "ninguna", label: "No" },
  { value: "leve", label: "Un poco" },
  { value: "moderada", label: "Bastante" },
  { value: "alta", label: "Mucho" },
] as const
const BRUSHING = [
  { value: "0", label: "Ninguna" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3 o más" },
] as const
/** Los hábitos que más pesan en la boca, en palabras del paciente. */
const HABITS = [
  "Fumar",
  "Morderse las uñas",
  "Morder lápices u objetos",
  "Respirar por la boca",
  "Chuparse el dedo",
].map((habit) => ({ value: habit, label: habit }))
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_PROBLEM = "Revisa el número: está incompleto o no es un celular."

/**
 * La pantalla y el campo donde se corrige cada dato que rechaza la validación
 * o el servidor (el primer prefijo que coincide). Sin campo, se dice en
 * «Antes de enviar».
 */
const WHERE: ReadonlyArray<readonly [string, string, (keyof Draft)?]> = [
  ["respondent", "respondent", "respondent"],
  ["demographics.givenNames", "person", "givenNames"],
  ["demographics.familyName", "person", "surnames"],
  ["demographics.displayName", "person", "surnames"],
  ["demographics.birthDate", "person", "birthDate"],
  ["demographics.sex", "person", "sex"],
  ["demographics.nationality", "person", "nationality"],
  ["demographics.birthPlace", "person", "birthPlace"],
  ["demographics.docType", "document", "docType"],
  ["demographics.docCountry", "document", "docCountry"],
  ["demographics.docNumber", "document", "docNumber"],
  ["demographics.phone", "contact", "phone"],
  ["demographics.email", "contact", "email"],
  ["demographics.addressCity", "contact", "addressCity"],
  ["demographics.addressReference", "contact", "addressReference"],
  ["demographics.address", "contact", "address"],
  ["demographics.emergencyContactName", "emergency", "emergencyName"],
  ["demographics.emergencyContactPhone", "emergency", "emergencyPhone"],
  ["demographics.emergencyContact", "emergency", "emergencyRelationship"],
  ["demographics.insurerName", "insurance", "insurerName"],
  ["demographics.affiliationNumber", "insurance", "affiliationNumber"],
  ["demographics.insurance", "insurance", "insurance"],
  ["demographics.maritalStatus", "census", "maritalStatus"],
  ["demographics.educationLevel", "census", "educationLevel"],
  ["demographics.occupation", "census", "occupation"],
  ["demographics.origin", "census", "origin"],
  ["demographics.referralKind", "census", "referralKind"],
  ["demographics.referralSource", "census", "referralSource"],
  ["representative.relationship", "rep", "repRelation"],
  ["representative.phone", "rep", "repPhone"],
  ["representative.doc", "rep", "repDoc"],
  ["representative", "rep", "repName"],
  ["health.allergies", "health", "allergies"],
  ["health.conditions", "health", "conditions"],
  ["health.anticoagulants", "medicines", "anticoagulants"],
  ["health.boneMedicines", "medicines", "boneMedicines"],
  ["health.medications", "medicines", "medications"],
  ["health.bloodGroup", "health", "bloodGroup"],
  ["health.dental.corazon", "health", "heartRisk"],
  ["health.dental.problemaAnestesia", "health", "anesthesia"],
  ["health.personal.embarazo", "history", "pregnant"],
  ["health.personal.semanasEmbarazo", "history", "pregnant"],
  ["health.personal.cirugias", "history", "surgeries"],
  ["health.personal.hospitalizaciones", "history", "hospitalized"],
  ["health.personal.transfusiones", "history", "transfusion"],
  ["health.personal", "history"],
  ["health.dental.ultimaVisita", "dental", "dentalLast"],
  ["health.dental.experienciaPrevia", "dental", "dentalExperience"],
  ["health.dental.ansiedadDental", "dental", "dentalAnxiety"],
  ["health.dental.cepilladosAlDia", "dental", "brushing"],
  ["health.dental.hiloDental", "dental", "floss"],
  ["health.dental.bruxismo", "dental", "bruxism"],
  ["health.dental.habitos", "dental", "habits"],
  ["health.dental.biberon", "childhood", "bottle"],
  ["health.dental.chupon", "childhood", "pacifier"],
  ["health.dental.dulcesEntreComidas", "childhood", "sweets"],
  ["health.dental.pastaConFluor", "childhood", "fluoride"],
  ["health.dental.quienCepilla", "childhood", "brusher"],
  ["health.dental", "dental"],
  ["health.medical.lactancia", "history", "breastfeeding"],
  ["health.medical.tabaco", "habits", "tobacco"],
  ["health.medical.cigarrillos", "habits", "cigarettes"],
  ["health.medical.alcohol", "habits", "alcohol"],
  ["health.medical", "habits"],
  ["acceptsMessages", "send", "messages"],
  ["privacyAccepted", "send", "privacy"],
  ["visit.reason", "visit", "visitReason"],
  ["visit.painLevel", "visit", "visitPainLevel"],
  ["visit.pain", "visit", "visitPain"],
  ["visit.more", "visit", "visitMore"],
]

/**
 * El campo de un dato, por su ruta en las respuestas (`demographics.phone`),
 * en el cuerpo que rechazó el servidor (`answers.demographics.phone`) o como
 * lo nombra la ficha en «Su enlace» (`phone`).
 */
function whereOf(key: string): (typeof WHERE)[number] | undefined {
  const bare = key.replace(/^answers\./, "")
  const path = /^(demographics|representative|health|respondent|privacyAccepted|acceptsMessages|visit)\b/.test(bare)
    ? bare
    : `demographics.${bare}`
  return WHERE.find(([prefix]) => path.startsWith(prefix))
}

function fieldOf(key: string): string | undefined {
  return whereOf(key)?.[2]
}

/** La pantalla de cada campo, para llevar a quien envía a lo que tiene que corregir. */
const ITEM_OF_FIELD = new Map<string, string>(
  WHERE.flatMap(([, item, field]) => (field ? [[field, item] as const] : [])),
)

type Found = { field: keyof Draft; message: string } | null
/** En una pantalla donde todo es opcional, los campos no repiten «(opcional)»: lo dice la pantalla. */
const AllOptionalContext = createContext(false)

/**
 * Lo que no se guarda en el celular aunque esté escrito (entrega 9): aceptar el aviso de
 * privacidad y lo de novedades son decisiones de quien envía, y se toman de nuevo al
 * volver. Quien siga en un celular compartido no las encuentra marcadas por otro.
 */
const NOT_KEPT_ON_DEVICE: ReadonlySet<keyof Draft> = new Set<keyof Draft>(["privacy", "messages"])

/** El mismo tipo que en el formulario vacío: texto, número, sí/no, una lista de textos o el documento sin elegir. */
function sameShape(empty: Draft[keyof Draft], value: unknown): boolean {
  if (Array.isArray(empty)) return Array.isArray(value) && value.every((item) => typeof item === "string")
  if (empty === null) return value === null || typeof value === "string"
  return typeof value === typeof empty
}

/**
 * Lo escrito que va al celular, o lo que se repone desde él: solo los campos del
 * formulario, con su tipo, y nunca lo de `NOT_KEPT_ON_DEVICE`. Lo que no cuadra (otra
 * versión, un valor tocado a mano) se descarta y ese campo queda en blanco.
 */
export function draftKeptOnDevice(values: object): Partial<Draft> {
  const source = values as Partial<Record<keyof Draft, unknown>>
  const kept: Partial<Record<keyof Draft, unknown>> = {}
  for (const key of Object.keys(EMPTY) as Array<keyof Draft>) {
    if (NOT_KEPT_ON_DEVICE.has(key) || !(key in source)) continue
    const value = source[key]
    if (sameShape(EMPTY[key], value)) kept[key] = value
  }
  return kept as Partial<Draft>
}

/** Si lo guardado tiene algo escrito de verdad (no solo «Para mí», que viene elegido). */
function draftHasWriting(values: Partial<Draft>): boolean {
  return (Object.keys(values) as Array<keyof Draft>).some((key) => {
    if (key === "respondent") return false
    const value = values[key]
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === "string") return value.trim().length > 0
    if (typeof value === "number") return value > 0
    return value === true
  })
}

/** Informa en qué paso va el cuestionario (lo que pinta «Paso 3 de 6»), para guardarlo con lo escrito. */
function StepSeen({ current, total, onSeen }: { current: number; total: number; onSeen: (current: number, total: number) => void }) {
  useEffect(() => onSeen(current, total), [current, total, onSeen])
  return null
}

/**
 * «Vas en el paso 3 de 6»: lo escrito sigue en este celular y aún no se envió. «Seguir
 * donde ibas» lo repone con su paso; «Empezar de nuevo» lo borra del celular.
 */
export function DraftResumeNotice({
  step,
  until,
  onResume,
  onRestart,
}: {
  step: DeviceDraftStep | null
  until: string
  onResume: () => void
  onRestart: () => void
}) {
  const words = draftResumeWords(step, until)
  return (
    <section aria-label={words.title} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl leading-snug font-semibold">{words.title}</h2>
        <p className="text-sm text-pretty text-muted-foreground">{words.text}</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" className="min-h-11" onClick={onResume}>
          Seguir donde ibas
        </Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={onRestart}>
          Empezar de nuevo
        </Button>
      </div>
    </section>
  )
}

function useRegistrationForm(
  defaultValues: Draft,
  validate: (value: Draft, formApi: AnyFormApi) => ReturnType<typeof placeErrors>,
  submit: (value: Draft) => Promise<void>,
) {
  return useAppForm({
    defaultValues,
    validators: { onSubmit: ({ value, formApi }) => validate(value, formApi) },
    onSubmit: ({ value }) => submit(value),
  })
}
type RegistrationForm = ReturnType<typeof useRegistrationForm>
const FormContext = createContext<RegistrationForm | null>(null)

function useRegistrationFormContext(): RegistrationForm {
  const form = useContext(FormContext)
  if (!form) throw new Error("Falta el formulario del registro")
  return form
}

/**
 * Lo que falta en una pantalla, dicho junto a su campo como al enviar: sigue a
 * la vista hasta que se corrige.
 */
function showFound(form: RegistrationForm, found: NonNullable<Found>): void {
  setSubmitErrors(form, { fields: { [found.field]: found.message } })
}
/**
 * «Su enlace»: cada pantalla deja aquí su `check`, para revisar al enviar la
 * pantalla desde la que se envía. Sin nada que aceptar al final, `label` es el
 * de «Enviar», que va en la última pantalla con contenido (cada pantalla lo
 * lleva; el cuestionario muestra solo el de la última).
 */
const FinishContext = createContext<{ label: string | null; sending: boolean; checks: Map<string, () => Found> } | null>(null)

/**
 * «Su enlace»: quien ya es paciente completa solo lo que le falta y, si nadie
 * la registró aún, su salud. Lo guardado no se muestra.
 */
export interface RegistrationFill {
  /** Las claves de lo que falta (`missingData` del servidor). */
  missing: ReadonlySet<string>
  /** Si se le pregunta su salud. */
  health: boolean
  /**
   * De su salud, solo esto: lo demás ya se sabe y no se le muestra (mesa del 13 nov). Sin él, todo lo
   * que la clínica pregunta.
   */
  healthKeys?: ReadonlySet<RegistrationFieldKey>
  /** Si ya tiene representante legal: un menor sin él lo deja aquí mismo. */
  hasRepresentative: boolean
  /** Su nombre, para saludarla. */
  firstName?: string | null
  /** Sus años cumplidos: de un menor de 12 se le pregunta lo de un niño a quien lo cuida. */
  age?: number | null
  /** Quien abre el enlace, si no es la persona (su madre, su tutor): «Lo respondes tú, Carla». */
  respondentFirstName?: string | null
  /** Aún no aceptó el aviso de privacidad (registrada por teléfono, por ejemplo): se pide al final. */
  privacy?: boolean
  /** Nunca respondió lo de novedades y promociones: se pregunta al final. */
  promotions?: boolean
  /** El nombre de la clínica, para decir a quién llegan sus datos. */
  clinicName?: string
  /**
   * «Tu visita», el último paso de «Antes de tu cita» (entrega 8): lo que se le pregunta de esa cita.
   * `purpose`: a qué viene, si la cita lo dice; `reader`: quien lo lee («el Dr. Luis Prado»).
   */
  visit?: { purpose: string | null; questions: VisitQuestions; reader: string } | null
}

const HEALTH_KEYS = new Set<string>(
  REGISTRATION_FIELDS.filter((field) => field.group === "health").map((field) => field.key),
)
/** La pantalla de cada paso de salud del registro (`step` de `REGISTRATION_FIELDS`). */
const HEALTH_ITEM_OF_STEP: Record<string, string> = {
  salud: "health",
  medicinas: "medicines",
  personales: "history",
  odontologicos: "dental",
  ninez: "childhood",
  habitos: "habits",
}
/** El sexo en lo que llena la persona. */
const PERSON_SEX_CODES = ["F", "M"] as const
const PERSON_KEYS = ["givenNames", "familyName", "birthDate", "sex", "nationality", "birthPlace"] as const

/** De lo que falta, lo que se escribe para completarlo (la misma regla del servidor). */
function fillWants(fill: RegistrationFill, key: string): boolean {
  const has = (name: string) => fill.missing.has(name)
  if (key === "docType" || key === "docNumber" || key === "docCountry") return has("docType") || has("docNumber")
  if (key === "email") return has("email") || has("phone")
  return has(key)
}

function ageOn(birthDate: string, today: string): number | null {
  if (!isRealDate(birthDate)) return null
  const [by = 0, bm = 0, bd = 0] = birthDate.split("-").map(Number)
  const [ty = 0, tm = 0, td = 0] = today.split("-").map(Number)
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0)
}

export function RegistrationQuestionnaire({
  config,
  today,
  countryCode,
  ownRecord = false,
  fill,
  submitLabel = "Enviar registro",
  shortcuts = true,
  addressSource,
  draftKey,
  resume = false,
  onSubmit,
}: {
  config: RegistrationConfig
  today: string
  countryCode: string | null
  /** Quien abrió su enlace ya tiene su ficha: registra a otra persona. */
  ownRecord?: boolean
  /** «Su enlace»: solo lo que falta (y su salud), sin registrar a nadie. */
  fill?: RegistrationFill
  submitLabel?: string
  /** Letras de atajo para el teclado; la vista previa imita un celular y no las lleva. */
  shortcuts?: boolean
  /**
   * Con una clave (`deviceDraftKey`), lo escrito y el paso quedan en este celular hasta
   * enviarlo o por un día (entrega 9), y al volver se ofrece «Seguir donde ibas». Si el
   * navegador no deja guardar, salir con algo escrito pide confirmar, como antes.
   */
  draftKey?: string
  /** Viene de «Seguir donde ibas» de su tarjeta: repone lo escrito y su paso sin volver a preguntar. */
  resume?: boolean
  /** Sugerencias para «Calle y número» (Geoapify, issue 36); sin ellas, el campo de siempre. */
  addressSource?: AddressSource
  /**
   * Recibe las respuestas ya validadas. Si lanza, lo que el servidor señala por
   * dato (`fields`, el `ApiError` tal cual) va a su campo y su pantalla; el
   * resto se dice en la última pantalla. En «Su enlace» con «Tu visita», lo de
   * su visita llega aparte (`visit`), en el mismo envío.
   */
  onSubmit: (answers: RegistrationAnswers, extra: { visit: VisitAnswerInput | null }) => Promise<void>
}) {
  const profile = clinicalProfileFor(countryCode)
  const phoneCountry = normalizeCountry(countryCode)
  const [item, setItem] = useState(() => {
    if (!fill) return ownRecord ? "person" : "respondent"
    const wants = (key: string) => fillWants(fill, key)
    if (PERSON_KEYS.some(wants)) return "person"
    if (wants("docType")) return "document"
    if (wants("phone") || wants("email") || wants("address")) return "contact"
    if (wants("emergencyContactName")) return "emergency"
    if (wants("insuranceType")) return "insurance"
    // Sin nada de sus datos ni de su salud, «Antes de tu cita» es solo «Tu visita».
    if (!fill.health) return fill.visit ? "visit" : "send"
    // La primera pantalla de su salud con algo que preguntarle.
    const first = fill.healthKeys
      ? REGISTRATION_FIELDS.find((field) => field.group === "health" && fill.healthKeys?.has(field.key))
      : null
    return (first && HEALTH_ITEM_OF_STEP[first.step]) || "health"
  })
  // Lo escrito en este celular (entrega 9): se lee ya montada la página (el servidor no
  // lo conoce, y pintarlo distinto rompería la hidratación).
  const [restored, setRestored] = useState(false)
  // Lo guardado que se le ofrece retomar: mientras decide, no se escribe encima.
  const [offered, setOffered] = useState<DeviceDraft<Draft> | null>(null)
  // Si este navegador guarda: solo entonces la pantalla lo promete.
  const [keeps, setKeeps] = useState(false)
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null)
  const seeStep = useCallback(
    (current: number, total: number) =>
      setProgress((now) => (now?.current === current && now.total === total ? now : { current, total })),
    [],
  )
  const sentRef = useRef(false)
  const form = useRegistrationForm(
    { ...EMPTY, respondent: ownRecord ? "representative" : "patient" },
    (_value, formApi) => placeErrors(formApi, finalErrors()),
    async () => {
      await onSubmit(buildAnswers(), { visit: buildVisit() })
      // Enviado: lo escrito se borra del celular ya, antes de que la pantalla cambie.
      sentRef.current = true
      if (draftKey) clearDeviceDraft(draftKey)
    },
  )
  const draft = useStore(form.store, (state) => state.values)
  const submitted = useStore(form.store, (state) => state.isSubmitSuccessful)
  const touched = useStore(form.store, (state) => state.isDirty) || restored
  /** Pone lo guardado en el formulario y vuelve a su paso. */
  const takeBack = (saved: DeviceDraft<Draft>) => {
    form.reset({ ...form.state.values, ...draftKeptOnDevice(saved.values) }, { keepDefaultValues: true })
    setRestored(true)
    if (saved.step) setItem(saved.step.item)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: se lee una vez, al montar
  useEffect(() => {
    if (!draftKey) return
    // Lo vencido de cualquier enlace se borra al abrir; lo de este, si venció, también.
    sweepDeviceDrafts()
    // El registro sin enlace (QR o web) puede ser la tablet de la clínica: lo suyo vive en la
    // pestaña, no se promete un día en el celular y, al recargar, vuelve solo, sin ofrecérselo a nadie.
    const inTab = deviceDraftPlace(draftKey) === "pestaña"
    setKeeps(!inTab && deviceDraftsWork())
    const saved = readDeviceDraft<Draft>(draftKey)
    if (!saved || !draftHasWriting(draftKeptOnDevice(saved.values))) return
    if (resume || inTab) takeBack(saved)
    else setOffered(saved)
  }, [])
  useEffect(() => {
    if (!draftKey || offered) return
    if (submitted) {
      clearDeviceDraft(draftKey)
      return
    }
    if (!touched || sentRef.current) return
    const step: DeviceDraftStep | null = progress ? { item, ...progress } : null
    writeDeviceDraft(draftKey, draftKeptOnDevice(draft), step)
  }, [draftKey, draft, submitted, touched, offered, item, progress])
  // Sin dónde guardar, salir con algo escrito pide confirmar al navegador: se avisa antes de perderlo.
  useEffect(() => {
    if (!draftKey || keeps || submitted || !touched || sentRef.current) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [draftKey, keeps, submitted, touched])
  const sending = useStore(form.store, (state) => state.isSubmitting)

  const set = (patch: Partial<Draft>) => {
    for (const [key, value] of Object.entries(patch) as Array<[keyof Draft, Draft[keyof Draft]]>)
      form.setFieldValue(key, value as never)
  }
  // En «Su enlace» se pregunta solo lo que falta; la salud, si nadie la registró, como la pide la clínica.
  const wants = (key: string) => !fill || fillWants(fill, key)
  // Lo de un producto (`dental.*`, `medical.*`) solo en las clínicas de ese producto.
  const product = productUi().product
  // Sus años: los de la fecha que se escribe o, en «Su enlace», los de su ficha.
  const ageNow = fill && !isRealDate(draft.birthDate) ? (fill.age ?? null) : ageOn(draft.birthDate, today)
  // Un niño (menor de 12): su salud se le pregunta a quien lo cuida, con ejemplos de niño (mesa del 13 nov, entrega 7).
  const child = isChildAge(ageNow)
  // A quién se le pregunta cada dato de salud: la misma regla del servidor (`registrationFieldApplies`).
  const applies = (key: RegistrationFieldKey) =>
    !HEALTH_KEYS.has(key) || registrationFieldApplies(key, { sex: draft.sex || null, age: ageNow })
  const asked = (key: RegistrationFieldKey) =>
    !fill
      ? registrationFieldAsked(config, key, countryCode, product) && applies(key)
      : HEALTH_KEYS.has(key) || registrationHealthSection(key) !== null
        ? fill.health &&
          (!fill.healthKeys || fill.healthKeys.has(key)) &&
          registrationFieldAsked(config, key, countryCode, product) &&
          applies(key)
        : fillWants(fill, key)
  const required = (key: RegistrationFieldKey) => config.fields[key] === "required"
  // Menor sin representante legal: en «Su enlace» deja los datos de su madre, padre o tutor.
  const repInFill = !!fill && !fill.hasRepresentative
  // «Su enlace»: al final, solo lo que aún no aceptó o respondió; sin nada de eso, se envía desde la última
  // pantalla con contenido, sin una pantalla vacía de «Antes de enviar».
  const sendInFill = !!fill && (!!fill.privacy || !!fill.promotions)
  const fillHasContent =
    !!fill &&
    (fill.health ||
      !!fill.visit ||
      [...PERSON_KEYS, "docType", "phone", "email", "address", "emergencyContactName", "insuranceType"].some((key) => fillWants(fill, key)))
  const visitAsks = fill?.visit?.questions ?? null
  const finishEarly = !!fill && !sendInFill && fillHasContent
  const [checks] = useState(() => new Map<string, () => Found>())
  const forOther = draft.respondent === "representative"
  const minor = isRealDate(draft.birthDate) && isMinor(draft.birthDate, today)
  const docTypes = profile.documentTypes.map(({ code }) => ({
    value: code,
    label: DOC_TYPE_LABELS[code],
  }))
  const repDocType = (docTypes[0]?.value ?? "DNI") as IdentityDocType
  const countries = countryChoices(profile.country)
  // «¿Cuándo nació Mateo?»: con su nombre en cuanto se sabe (en «Su enlace», el de su ficha).
  const first = draft.givenNames.trim().split(/\s+/)[0] || (fill?.firstName?.trim().split(/\s+/)[0] ?? "")
  const name = first || "la persona"
  // A quien cuida a un niño se le habla a él, también en «Su enlace»: «¿Thiago tiene…?».
  const aboutOther = forOther || (!!fill && child)
  const you = (self: string, other: string) => (aboutOther ? other : self)
  // Quien responde por el niño: «Lo respondes tú, Carla».
  const caregiver = fill ? (fill.respondentFirstName?.trim() ?? "") : (draft.repName.trim().split(/\s+/)[0] ?? "")
  const answeredBy = child ? (caregiver ? `Lo respondes tú, ${caregiver}.` : "Lo respondes tú, que lo cuidas.") : ""
  // Con el correo en el registro, basta el celular o el correo.
  const phoneRequired = !forOther && !asked("email") && wants("phone")

  // El seguro se elige por su nombre del país (SIS, EsSalud, EPS) o por su tipo general.
  const insuranceOptions: Array<{
    value: string
    label: string
    type: InsuranceType
    scheme?: string
  }> = [
    ...profile.insuranceSchemes.map((scheme) => ({
      value: `scheme:${scheme.code}`,
      label: scheme.label,
      type: scheme.type,
      scheme: scheme.code,
    })),
    ...(profile.insuranceSchemes.length === 0
      ? [{ value: "type:PUBLICO", label: INSURANCE_TYPE_LABELS.PUBLICO, type: "PUBLICO" as const }]
      : []),
    {
      value: "type:PRIVADO",
      label: profile.insuranceSchemes.some((scheme) => scheme.type === "PRIVADO")
        ? "Otro seguro privado"
        : "Privado",
      type: "PRIVADO",
    },
    { value: "type:PARTICULAR", label: "No tengo seguro", type: "PARTICULAR" },
    { value: "type:OTRO", label: "Otro", type: "OTRO" },
  ]
  const insurance = insuranceOptions.find((option) => option.value === draft.insurance)
  const privateInsurance = insurance?.type === "PRIVADO" || insurance?.type === "OTRO"

  const healthKeys = ["allergies", "conditions", "bloodGroup", "dental.corazon", "dental.problemaAnestesia"] as const
  const healthAsked = healthKeys.some(asked)
  const healthRequired = healthKeys.some((key) => asked(key) && required(key))
  // «Tus medicinas», en un paso aparte y una sola vez: primero las dos que cambian lo que se hace en la cita.
  const medicineKeys = ["anticoagulants", "boneMedicines", "medications"] as const
  const medicinesAsked = medicineKeys.some(asked)
  const medicinesRequired = medicineKeys.some((key) => asked(key) && required(key))
  // A mujeres de 12 a 55 años, y nunca a un niño: lo dice `applies`.
  const pregnancyAsked = asked("personal.embarazo")
  const breastfeedingAsked = asked("medical.lactancia")
  // «Thiago de pequeño»: biberón y chupón hasta los 6 años; dulces, flúor y quién le cepilla, a todo menor de 12.
  const childhoodKeys = [
    "dental.biberon",
    "dental.chupon",
    "dental.dulcesEntreComidas",
    "dental.pastaConFluor",
    "dental.quienCepilla",
  ] as const
  const historyAsked =
    pregnancyAsked ||
    breastfeedingAsked ||
    (["personal.cirugias", "personal.hospitalizaciones", "personal.transfusiones"] as const).some(
      asked,
    )
  const dentalKeys = [
    "dental.ultimaVisita",
    "dental.experienciaPrevia",
    "dental.ansiedadDental",
    "dental.cepilladosAlDia",
    "dental.hiloDental",
    "dental.bruxismo",
    "dental.habitos",
  ] as const
  const censusKeys = [
    "maritalStatus",
    "educationLevel",
    "occupation",
    "origin",
    "referralSource",
  ] as const
  // A un menor no se le pregunta su estado civil ni su ocupación.
  const censusAsked = (key: (typeof censusKeys)[number]) =>
    asked(key) && !(minor && (key === "maritalStatus" || key === "occupation"))

  function buildAnswers(): RegistrationAnswers {
    const d = draft
    const familyName = d.surnames.trim()
    const demographics: Record<string, string> = {
      displayName: composeDisplayName({
        givenNames: d.givenNames.trim(),
        familyName,
      }),
      givenNames: d.givenNames.trim(),
      familyName,
      birthDate: d.birthDate,
      phone: d.phone,
    }
    const put = (key: string, value: string) => {
      if (value.trim()) demographics[key] = value.trim()
    }
    if (asked("sex")) put("sex", d.sex)
    if (asked("nationality")) put("nationality", d.nationality)
    if (asked("birthPlace")) put("birthPlace", d.birthPlace)
    if (asked("docType") && d.docType) {
      put("docType", d.docType)
      put("docNumber", d.docNumber)
      if (asksDocumentCountry(profile, d.docType)) put("docCountry", d.docCountry)
    }
    if (asked("email")) put("email", d.email)
    if (asked("address")) {
      put("address", d.address)
      put("addressCity", d.addressCity)
      if (profile.address.reference) put("addressReference", d.addressReference)
    }
    if (asked("emergencyContactName")) {
      put("emergencyContactName", d.emergencyName)
      put("emergencyContactPhone", d.emergencyPhone)
      put("emergencyContactRelationship", d.emergencyRelationship)
    }
    if (asked("insuranceType") && insurance) {
      put("insuranceType", insurance.type)
      if (insurance.scheme) put("insuranceScheme", insurance.scheme)
      if (privateInsurance) {
        put("insurerName", d.insurerName)
        put("affiliationNumber", d.affiliationNumber)
      }
    }
    for (const key of censusKeys) if (censusAsked(key) && key !== "referralSource") put(key, d[key])
    // «Cómo nos conoció»: la opción de la lista y, solo con «Otro», lo que dijo.
    if (censusAsked("referralSource")) {
      put("referralKind", d.referralKind)
      if (d.referralKind === "otro") put("referralSource", d.referralSource)
    }
    for (const key of Object.keys(demographics))
      if (demographics[key] === "") delete demographics[key]

    const answers: RegistrationAnswers = {
      demographics: demographics as RegistrationAnswers["demographics"],
      respondent: d.respondent,
      privacyAccepted: d.privacy,
    }
    if (forOther || (repInFill && minor && d.repName.trim())) {
      const relation = RELATIONS.find((option) => option.value === d.repRelation) ?? RELATIONS[0]
      answers.representative = {
        displayName: d.repName.trim(),
        relationship: relation.value,
        relationshipDetail: relation.detail,
        ...(d.repPhone ? { phone: d.repPhone } : {}),
        ...(minor && d.repDoc.trim() ? { docType: repDocType, docNumber: d.repDoc.trim() } : {}),
      }
    }

    type Health = NonNullable<RegistrationAnswers["health"]>
    const health: Health = {}
    const listed = (state: Declared, text: string) =>
      state === "recorded"
        ? text
            .split(/[,;\n]/)
            .map((value) => value.trim())
            .filter(Boolean)
        : []
    const stateOf = (state: Declared) => state || "unanswered"
    const reaction = d.allergiesReaction.trim()
    if (asked("allergies"))
      health.allergies = {
        state: stateOf(d.allergies),
        items: listed(d.allergies, d.allergiesText).map((substance) => ({
          substance,
          severity: "desconocida",
          ...(reaction ? { reaction } : {}),
        })),
      }
    if (asked("conditions"))
      health.conditions = {
        state: stateOf(d.conditions),
        items: [
          ...(d.conditions === "recorded" ? d.conditionsPicked : []),
          ...listed(d.conditions, d.conditionsText),
        ].map((value) => ({ name: value })),
      }
    // «¿Cuál?» va solo con el Sí: la marca de la ficha sale de la respuesta, no del nombre.
    const directed = (state: Declared, text: string): NonNullable<Health["anticoagulants"]> => ({
      state: stateOf(state),
      ...(state === "recorded" && text.trim() ? { detail: text.trim() } : {}),
    })
    if (asked("anticoagulants")) health.anticoagulants = directed(d.anticoagulants, d.anticoagulantsText)
    if (asked("boneMedicines")) health.boneMedicines = directed(d.boneMedicines, d.boneMedicinesText)
    if (asked("medications"))
      health.medications = {
        state: stateOf(d.medications),
        items: listed(d.medications, d.medicationsText).map((value) => ({ name: value })),
      }
    if (asked("bloodGroup") && d.bloodGroup)
      health.bloodGroup = d.bloodGroup as NonNullable<Health["bloodGroup"]>

    // Lo de la entrevista de salud, con las mismas claves de la ficha.
    const personal: NonNullable<Health["personal"]> = {}
    if (pregnancyAsked && (d.pregnant === "si" || d.pregnant === "no")) {
      personal.embarazo = d.pregnant === "si"
      const weeks = Number(d.pregnancyWeeks)
      if (
        d.pregnant === "si" &&
        d.pregnancyWeeks.trim() &&
        Number.isInteger(weeks) &&
        weeks >= 0 &&
        weeks <= 42
      )
        personal.semanasEmbarazo = weeks
    }
    const yesNoText = (answer: YesNo, text: string) =>
      answer === "si" ? text.trim() || "Sí" : answer === "no" ? "No" : undefined
    const surgeries = asked("personal.cirugias")
      ? yesNoText(d.surgeries, d.surgeriesText)
      : undefined
    if (surgeries) personal.cirugias = surgeries
    const hospitalized = asked("personal.hospitalizaciones")
      ? yesNoText(d.hospitalized, d.hospitalizedText)
      : undefined
    if (hospitalized) personal.hospitalizaciones = hospitalized
    const transfusion = asked("personal.transfusiones")
      ? yesNoText(d.transfusion, d.transfusionText)
      : undefined
    if (transfusion) personal.transfusiones = transfusion
    if (Object.keys(personal).length) health.personal = personal

    type Dental = NonNullable<Health["dental"]>
    const dental: Dental = {}
    if (asked("dental.ultimaVisita") && d.dentalLast.trim())
      dental.ultimaVisita = d.dentalLast.trim()
    if (asked("dental.experienciaPrevia") && d.dentalExperience)
      dental.experienciaPrevia = d.dentalExperience as Dental["experienciaPrevia"]
    if (asked("dental.ansiedadDental") && d.dentalAnxiety)
      dental.ansiedadDental = d.dentalAnxiety as Dental["ansiedadDental"]
    if (asked("dental.cepilladosAlDia") && d.brushing) dental.cepilladosAlDia = Number(d.brushing)
    if (asked("dental.hiloDental") && d.floss) dental.hiloDental = d.floss === "si"
    if (asked("dental.bruxismo") && (d.bruxism === "si" || d.bruxism === "no"))
      dental.bruxismo = d.bruxism === "si"
    if (asked("dental.habitos") && d.habits.length) dental.habitos = d.habits
    if (asked("dental.corazon") && (d.heartRisk || d.heartAntibiotic))
      dental.corazon = {
        ...(d.heartRisk ? { riesgoEndocarditis: INTERVIEW_OF[d.heartRisk] } : {}),
        ...(d.heartAntibiotic ? { antibioticoPrevio: INTERVIEW_OF[d.heartAntibiotic] } : {}),
      }
    if (asked("dental.problemaAnestesia") && d.anesthesia) dental.problemaAnestesia = INTERVIEW_OF[d.anesthesia]
    // «De pequeño», con las claves de la entrevista de odentIA.
    if (asked("dental.biberon") && d.bottle) dental.biberon = d.bottle
    if (asked("dental.chupon") && d.pacifier) dental.chupon = d.pacifier
    if (asked("dental.dulcesEntreComidas") && d.sweets) dental.dulcesEntreComidas = d.sweets
    if (asked("dental.pastaConFluor") && d.fluoride) dental.pastaConFluor = INTERVIEW_OF[d.fluoride]
    if (asked("dental.quienCepilla") && d.brusher) dental.quienCepilla = d.brusher
    if (Object.keys(dental).length) health.dental = dental
    type Medical = NonNullable<Health["medical"]>
    const medical: Medical = {}
    if (breastfeedingAsked && d.breastfeeding) medical.lactancia = d.breastfeeding === "si"
    if (asked("medical.tabaco") && d.tobacco) medical.tabaco = d.tobacco
    if (asked("medical.tabaco") && d.tobacco === "fuma" && d.cigarettes) medical.cigarrillos = d.cigarettes
    if (asked("medical.alcohol") && d.alcohol) medical.alcohol = d.alcohol
    if (Object.keys(medical).length) health.medical = medical
    if (Object.keys(health).length) answers.health = health
    if (fill ? fill.promotions && d.messages : config.askMessages && d.privacy && d.messages) answers.acceptsMessages = d.messages === "si"
    // Se le dijo que le escribiremos por WhatsApp a ese número sobre sus citas: va con lo que
    // envía para que quede guardado. En «Su enlace», quien responde por un menor aún no tiene
    // ficha en la que guardarlo.
    if (forOther ? !fill && !!d.repPhone : wants("phone") && !!d.phone) answers.acceptsReminders = true
    return answers
  }

  /** «Tu visita» como la guarda el servidor: solo lo que se le preguntó y respondió; cuánto, solo con dolor. */
  function buildVisit(): VisitAnswerInput | null {
    if (!visitAsks) return null
    const d = draft
    const level = d.visitPain === "si" && d.visitPainLevel !== "" ? Number(d.visitPainLevel) : undefined
    return {
      ...(visitAsks.reason && d.visitReason.trim() ? { reason: d.visitReason.trim() } : {}),
      ...(visitAsks.pain && d.visitPain ? { pain: d.visitPain } : {}),
      ...(level !== undefined ? { painLevel: level } : {}),
      ...(visitAsks.more && d.visitMore.trim() ? { more: d.visitMore.trim() } : {}),
    }
  }

  /**
   * Al enviar, la misma regla del servidor (con el producto de la clínica: lo
   * de «Tu boca» o los hábitos solo se pide en el suyo). En «Su enlace» no se
   * registra a nadie: se juzga lo que se escribió con la regla de la ficha.
   */
  function finalErrors(): Record<string, string> {
    const answers = buildAnswers()
    let errors: Record<string, string>
    if (fill) {
      const { displayName, ...rest } = answers.demographics
      const found = validateDemographics(
        { ...rest, displayName: displayName || fill.firstName || "—" },
        today,
        countryCode,
      )
      // Solo lo que se preguntó: lo guardado no se muestra ni se juzga aquí.
      errors = Object.fromEntries(Object.entries(found).filter(([key]) => fillWants(fill, key)))
    } else {
      errors = validateRegistrationAnswers(config, answers, {
        mode: "public",
        today,
        countryCode,
        product,
      })
    }
    const placed: Record<string, string> = {}
    for (const [key, message] of Object.entries(errors)) placed[fieldOf(key) ?? key] ??= message
    return placed
  }

  /** La pantalla del primer campo con error, con el foco en él. */
  function goToFirstInvalid(root: HTMLElement | null): void {
    const field = WHERE.map(([, , name]) => name).find(
      (name) => name && (form.getFieldMeta(name)?.errors.length ?? 0) > 0,
    )
    if (!field) {
      setItem("send")
      return
    }
    setItem(ITEM_OF_FIELD.get(field) ?? "send")
    // Después de mostrar la pantalla: antes está oculta y no recibe el foco.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        root
          ?.querySelector<HTMLElement>(
            `[data-field="${field}"] :is(input:not([hidden]), button, [role=combobox])`,
          )
          ?.focus()
      }),
    )
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Solo se envía desde «Antes de enviar», con su botón: nunca con un Enter en otra pantalla. En «Su
    // enlace» sin nada que aceptar, desde la última pantalla con contenido: sus pantallas son todas de
    // varios campos y el cuestionario solo envía desde la última.
    if (sending || (item !== "send" && !finishEarly)) return
    const root = event.currentTarget
    // Lo que falta en la pantalla desde la que se envía, junto a su campo.
    const pending = fill ? (checks.get(item)?.() ?? null) : null
    if (pending) {
      showFound(form, pending)
      requestAnimationFrame(() => {
        root
          .querySelector<HTMLElement>(`[data-field="${pending.field}"] :is(input:not([hidden]):not([aria-hidden=true]), button, [role=combobox], [role=checkbox])`)
          ?.focus()
      })
      return
    }
    const ok = await submitForm(form, { fieldMap: fieldOf, root })
    if (!ok) goToFirstInvalid(root)
  }

  const phoneFound = (
    field: keyof Draft,
    value: string,
    digits: number,
    needed: boolean,
    empty: string,
  ): Found =>
    digits > 0 && !value
      ? { field, message: PHONE_PROBLEM }
      : needed && !value
        ? { field, message: empty }
        : null
  const needs = (condition: boolean, field: keyof Draft, message: string): Found =>
    condition ? { field, message } : null
  /** Lo que la regla de la ficha dice de lo escrito en un campo, con sus mismas palabras. */
  const says = (field: keyof Draft, problem: string | null): Found => (problem ? { field, message: problem } : null)

  if (offered && draftKey) {
    // Volvió con algo escrito en este celular: un toque y sigue donde iba (C8).
    return (
      <DraftResumeNotice
        step={offered.step}
        until={draftUntilWords(offered.expiresAt, Date.now(), activeOrgLocale())}
        onResume={() => {
          takeBack(offered)
          setOffered(null)
        }}
        onRestart={() => {
          clearDeviceDraft(draftKey)
          setOffered(null)
        }}
      />
    )
  }

  return (
    <FormContext.Provider value={form}>
      <FinishContext.Provider value={fill ? { label: finishEarly ? (sending ? "Enviando…" : submitLabel) : null, sending, checks } : null}>
      <Questionnaire
        item={item}
        onItemChange={setItem}
        onSubmit={handleSubmit}
        shortcuts={shortcuts ? "letters" : undefined}
        // Las letras de atajo son del teclado: en el celular sobran.
        className="gap-8 max-sm:[&_[data-slot=questionnaire-choice-shortcut]]:hidden!"
      >
        <QuestionnaireProgress
          render={(props, state) => (
            <div {...props} className="flex w-full flex-col gap-2">
              <span className="text-xs font-medium text-muted-foreground tabular-nums">
                Paso {state.current} de {state.total}
              </span>
              <span
                className="block h-1.5 w-full overflow-hidden rounded-full bg-muted"
                aria-hidden
              >
                <span
                  className="block h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
                  style={{
                    width: `${Math.round((state.current / Math.max(state.total, 1)) * 100)}%`,
                  }}
                />
              </span>
              {draftKey ? <StepSeen current={state.current} total={state.total} onSeen={seeStep} /> : null}
            </div>
          )}
        />
        {draftKey && keeps ? (
          // Solo si de verdad se guarda: en una ventana privada que lo bloquea, no se promete.
          <p className="-mt-5 text-xs text-pretty text-muted-foreground">{DEVICE_DRAFT_PROMISE}</p>
        ) : null}

        <Question
          name="respondent"
          required
          disabled={ownRecord || !!fill}
          title="¿Para quién es el registro?"
        >
          <QuestionnaireChoices>
            <QuestionnaireChoice
              value="patient"
              checked={draft.respondent === "patient"}
              onChange={() => set({ respondent: "patient" })}
            >
              Para mí
            </QuestionnaireChoice>
            <QuestionnaireChoice
              value="representative"
              checked={draft.respondent === "representative"}
              onChange={() => set({ respondent: "representative" })}
            >
              Para otra persona
              <QuestionnaireChoiceDescription>
                Un hijo, un familiar o alguien a tu cargo
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
          </QuestionnaireChoices>
          <FieldMessage name="respondent" />
        </Question>

        <Question
          name="person"
          grouped
          required
          disabled={!!fill && !PERSON_KEYS.some(wants)}
          title={you("Tus datos", "Datos de quien se atenderá")}
          description={
            fill
              ? "Lo que ya tenemos no se muestra."
              : you("Como figuran en tu documento.", "Como figuran en su documento.")
          }
          check={() =>
            needs(wants("givenNames") && !draft.givenNames.trim(), "givenNames", "Escribe los nombres.") ??
            needs(wants("familyName") && !draft.surnames.trim(), "surnames", "Escribe los apellidos.") ??
            needs(wants("birthDate") && !draft.birthDate, "birthDate", "Escribe la fecha de nacimiento.") ??
            needs(
              wants("birthDate") && !isRealDate(draft.birthDate),
              "birthDate",
              "Revisa la fecha: escribe día, mes y año.",
            ) ??
            needs(
              !fill && !forOther && minor,
              "birthDate",
              "Eres menor de edad: te registra tu madre, padre o tutor.",
            ) ??
            needs(asked("sex") && required("sex") && !draft.sex, "sex", "Elige una opción.") ??
            needs(
              required("nationality") && !draft.nationality,
              "nationality",
              "Elige la nacionalidad.",
            ) ??
            needs(
              required("birthPlace") && !draft.birthPlace.trim(),
              "birthPlace",
              "Escribe dónde nació.",
            )
          }
        >
          {wants("givenNames") ? (
          <Labeled name="givenNames" label="Nombres">
            {(control) => (
              <Input
                {...control.props}
                autoComplete={forOther ? "off" : "given-name"}
                maxLength={100}
                value={draft.givenNames}
                onChange={(event) => set({ givenNames: event.target.value })}
              />
            )}
          </Labeled>
          ) : null}
          {wants("familyName") ? (
          <Labeled
            name="surnames"
            label="Apellidos"
            hint={you("Los dos, si tienes dos.", "Los dos, si tiene dos.")}
          >
            {(control) => (
              <Input
                {...control.props}
                autoComplete={forOther ? "off" : "family-name"}
                maxLength={200}
                value={draft.surnames}
                onChange={(event) => set({ surnames: event.target.value })}
              />
            )}
          </Labeled>
          ) : null}
          {wants("birthDate") ? (
          <Labeled name="birthDate" label="Fecha de nacimiento">
            {(control) => (
              <BirthDateInput
                id={control.id}
                name={control.name}
                value={draft.birthDate}
                onChange={(value) => set({ birthDate: value })}
                today={today}
                country={countryCode}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
              />
            )}
          </Labeled>
          ) : null}
          {!fill && !forOther && !ownRecord && minor ? (
            <div className="flex flex-col items-start gap-2 rounded-2xl bg-muted/60 p-4 text-sm">
              <p>Eres menor de edad: tu registro lo hace tu madre, padre o tutor.</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => set({ respondent: "representative" })}
              >
                Lo registra mi madre, padre o tutor
              </Button>
            </div>
          ) : null}
          {asked("sex") ? (
            <Labeled name="sex" group label="Sexo" optional={!required("sex")}>
              {(control) => (
              <ChoiceButtons
                id={control.id}
                aria-labelledby={control.labelId}
                aria-describedby={control.describedBy}
                invalid={control.invalid}
                onBlur={control.onBlur}
                value={draft.sex || null}
                // Quien llena su registro elige «Femenino» o «Masculino». «Indeterminado» es un dato clínico
                // (un recién nacido, por ejemplo) y «Desconocido», de quien registra a otro sin saberlo: los
                // registra el equipo en la ficha.
                options={PERSON_SEX_CODES.map((code) => ({
                  value: code,
                  label: SEX_LABELS[code],
                }))}
                onChange={(value) => set({ sex: value })}
                columns={2}
                />
              )}
            </Labeled>
          ) : null}
          {asked("nationality") ? (
            <Labeled name="nationality" label="Nacionalidad" optional={!required("nationality")}>
              {(control) => (
                <SearchSelect
                  id={control.id}
                  label="Nacionalidad"
                  placeholder="Buscar país…"
                  value={draft.nationality}
                  options={countries}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onChange={(value) => set({ nationality: value })}
                />
              )}
            </Labeled>
          ) : null}
          {asked("birthPlace") ? (
            <Labeled
              name="birthPlace"
              label="Lugar de nacimiento"
              optional={!required("birthPlace")}
            >
              {(control) => (
                <Input
                  {...control.props}
                  placeholder="Ciudad y país"
                  maxLength={200}
                  value={draft.birthPlace}
                  onChange={(event) => set({ birthPlace: event.target.value })}
                />
              )}
            </Labeled>
          ) : null}
        </Question>

        <Question
          name="rep"
          grouped
          required
          disabled={fill ? !(repInFill && minor) : !forOther}
          // En «Su enlace» de un niño lo llena quien lo cuida: se le habla a ella, con el nombre del niño. Quién
          // queda como representante no cambia: lo registra la clínica con su documento.
          title={fill ? (child ? "Ahora tus datos" : "Tu madre, padre o tutor") : "Ahora tus datos"}
          description={
            fill
              ? child
                ? `${name} es menor de edad: déjanos tus datos, que respondes por ${name}. La clínica te registra con tu documento cuando vengan.`
                : "Eres menor de edad: déjanos los datos de quien responde por ti. La clínica lo registra con su documento cuando vengan."
              : `Quedas como quien habla por ${name} con la clínica.`
          }
          check={() =>
            needs(!draft.repName.trim(), "repName", "Escribe tu nombre y apellidos.") ??
            needs(!draft.repRelation, "repRelation", `Elige qué eres de ${name}.`) ??
            needs(
              minor && draft.repRelation !== "guardian",
              "repRelation",
              `${first || "La persona"} es menor de edad: lo registra su madre, padre o tutor.`,
            ) ??
            phoneFound(
              "repPhone",
              draft.repPhone,
              draft.repPhoneDigits,
              true,
              "Escribe tu celular.",
            ) ??
            needs(minor && !draft.repDoc.trim(), "repDoc", "Escribe tu número de documento.") ??
            says("repDoc", minor ? identityDocumentError(repDocType, draft.repDoc) : null)
          }
        >
          <Labeled name="repName" label="Tu nombre y apellidos">
            {(control) => (
              <Input
                {...control.props}
                autoComplete="name"
                maxLength={200}
                value={draft.repName}
                onChange={(event) => set({ repName: event.target.value })}
              />
            )}
          </Labeled>
          <Labeled name="repRelation" group label={`¿Qué eres de ${name}?`}>
            {(control) => (
              <ChoiceButtons
                id={control.id}
                aria-labelledby={control.labelId}
                aria-describedby={control.describedBy}
                invalid={control.invalid}
                onBlur={control.onBlur}
                value={draft.repRelation || null}
                options={RELATIONS}
                onChange={(value) => set({ repRelation: value })}
                columns={3}
              />
            )}
          </Labeled>
          <Labeled
            name="repPhone"
            label="Tu celular"
            hint={`Te escribiremos por WhatsApp a este número sobre las citas de ${name}: la confirmación, los recordatorios y los cambios.`}
          >
            {(control) => (
              <PhoneInput
                id={control.id}
                name={control.name}
                value={draft.repPhone || null}
                onChange={(value, meta) =>
                  set({ repPhone: value ?? "", repPhoneDigits: meta.digits.length })
                }
                defaultCountry={phoneCountry}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
              />
            )}
          </Labeled>
          {minor ? (
            <Labeled
              name="repDoc"
              label={`Tu ${DOC_TYPE_LABELS[repDocType]}`}
              hint={`${first || "La persona"} es menor de edad: quedas como su representante.`}
            >
              {(control) => (
                <Input
                  {...control.props}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={20}
                  value={draft.repDoc}
                  onChange={(event) => set({ repDoc: event.target.value })}
                />
              )}
            </Labeled>
          ) : null}
        </Question>

        <Question
          name="document"
          grouped
          required={required("docType")}
          disabled={!asked("docType")}
          title={you("Tu documento", `El documento de ${name}`)}
          onSkip={() => set({ docType: null, docNumber: "", docCountry: "" })}
          check={() =>
            needs(
              required("docType") && !draft.docType,
              "docType",
              "Elige el tipo de documento.",
            ) ??
            needs(
              (required("docNumber") || Boolean(draft.docType)) && !draft.docNumber.trim(),
              "docNumber",
              "Escribe el número.",
            ) ??
            // El formato se revisa aquí, no recién al enviar: un DNI de 7 números se corrige en su pantalla.
            says("docNumber", identityDocumentError(draft.docType, draft.docNumber)) ??
            needs(
              Boolean(draft.docType) &&
                asksDocumentCountry(profile, draft.docType) &&
                !draft.docCountry,
              "docCountry",
              "Elige el país que lo emitió.",
            )
          }
        >
          <Labeled name="docType" group label="Tipo de documento" optional={!required("docType")}>
            {(control) => (
              <DocTypeChoice
                id={control.id}
                aria-labelledby={control.labelId}
                aria-describedby={control.describedBy}
                invalid={control.invalid}
                onBlur={control.onBlur}
                value={draft.docType}
                options={docTypes}
                onChange={(value) => set({ docType: value, docCountry: "" })}
              />
            )}
          </Labeled>
          {draft.docType ? (
            <Labeled
              name="docNumber"
              label={`Número de ${DOC_TYPE_LABELS[draft.docType]}`}
            >
              {(control) => (
                <Input
                  {...control.props}
                  autoComplete="off"
                  maxLength={20}
                  value={draft.docNumber}
                  onChange={(event) => set({ docNumber: event.target.value })}
                />
              )}
            </Labeled>
          ) : null}
          {draft.docType && asksDocumentCountry(profile, draft.docType) ? (
            <Labeled name="docCountry" label="País que lo emitió">
              {(control) => (
                <SearchSelect
                  id={control.id}
                  label="País que emitió el documento"
                  placeholder="Buscar país…"
                  value={draft.docCountry}
                  options={countries}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onChange={(value) => set({ docCountry: value })}
                />
              )}
            </Labeled>
          ) : null}
        </Question>

        <Question
          name="contact"
          grouped
          // Para uno mismo hace falta el celular o el correo: no se salta.
          required={fill ? wants("phone") || wants("email") || wants("address") : !forOther || required("email") || required("address")}
          disabled={!!fill && !wants("phone") && !wants("email") && !wants("address")}
          title={you("¿Cómo te contactamos?", `¿Cómo contactamos a ${name}?`)}
          onSkip={() =>
            set({
              phone: "",
              phoneDigits: 0,
              email: "",
              address: "",
              addressCity: "",
              addressReference: "",
            })
          }
          check={() =>
            phoneFound(
              "phone",
              draft.phone,
              draft.phoneDigits,
              phoneRequired,
              "Escribe tu celular.",
            ) ??
            needs(
              !forOther && wants("phone") && !draft.phone && asked("email") && !draft.email.trim(),
              "phone",
              "Escribe tu celular o tu correo: uno de los dos.",
            ) ??
            needs(
              Boolean(draft.email.trim()) && !EMAIL.test(draft.email.trim()),
              "email",
              "Escribe el correo completo, como nombre@correo.com.",
            ) ??
            needs(
              required("email") && !forOther && !draft.email.trim(),
              "email",
              "Escribe tu correo.",
            ) ??
            needs(
              required("address") && !draft.address.trim(),
              "address",
              "Escribe la dirección.",
            ) ??
            needs(
              required("address") && !draft.addressCity.trim(),
              "addressCity",
              `Escribe el ${profile.address.cityLabel.toLowerCase()}.`,
            )
          }
        >
          {wants("phone") ? (
          <Labeled
            name="phone"
            label={you("Tu celular", "Su celular")}
            optional={!phoneRequired}
            hint={
              forOther
                ? "Si no tiene, sus avisos te llegan a ti."
                : "Te escribiremos por WhatsApp a este número sobre tus citas: la confirmación, los recordatorios y los cambios."
            }
          >
            {(control) => (
              <PhoneInput
                id={control.id}
                name={control.name}
                value={draft.phone || null}
                onChange={(value, meta) =>
                  set({ phone: value ?? "", phoneDigits: meta.digits.length })
                }
                defaultCountry={phoneCountry}
                autoComplete={forOther ? "off" : "tel"}
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
              />
            )}
          </Labeled>
          ) : null}
          {asked("email") ? (
            <Labeled
              name="email"
              label={you("Tu correo", "Su correo")}
              optional={!required("email") || forOther}
              hint="Para enviarte comprobantes y recetas."
            >
              {(control) => (
                <Input
                  {...control.props}
                  type="email"
                  placeholder="nombre@correo.com"
                  autoComplete={forOther ? "off" : "email"}
                  maxLength={200}
                  value={draft.email}
                  onChange={(event) => set({ email: event.target.value })}
                />
              )}
            </Labeled>
          ) : null}
          {asked("address") ? (
            <>
              <Labeled
                name="address"
                label="Dirección"
                optional={!required("address")}
              >
                {(control) =>
                  addressSource ? (
                    <AddressStreetField
                      id={control.id}
                      value={draft.address}
                      source={addressSource}
                      placeholder="Calle y número"
                      autoComplete={forOther ? "off" : "street-address"}
                      maxLength={500}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      pickedHint="Lo llenó la sugerencia; puedes corregirlo. Agrega el dpto. o interior en la calle."
                      onChange={(next) => set({ address: next })}
                      onPick={(pick) => {
                        if (pick.city) set({ addressCity: pick.city })
                      }}
                    />
                  ) : (
                    <Input
                      {...control.props}
                      placeholder="Calle y número"
                      autoComplete={forOther ? "off" : "street-address"}
                      maxLength={500}
                      value={draft.address}
                      onChange={(event) => set({ address: event.target.value })}
                    />
                  )
                }
              </Labeled>
              <Labeled
                name="addressCity"
                label={profile.address.cityLabel}
                optional={!required("address")}
              >
                {(control) => (
                  <Input
                    {...control.props}
                    autoComplete={forOther ? "off" : "address-level2"}
                    maxLength={100}
                    value={draft.addressCity}
                    onChange={(event) => set({ addressCity: event.target.value })}
                  />
                )}
              </Labeled>
              {profile.address.reference ? (
                <Labeled
                  name="addressReference"
                  label="Referencia"
                  optional
                >
                  {(control) => (
                    <Input
                      {...control.props}
                      placeholder="Por ejemplo, frente al parque"
                      autoComplete="off"
                      maxLength={300}
                      value={draft.addressReference}
                      onChange={(event) => set({ addressReference: event.target.value })}
                    />
                  )}
                </Labeled>
              ) : null}
            </>
          ) : null}
        </Question>

        <Question
          name="emergency"
          grouped
          required={required("emergencyContactName")}
          disabled={!asked("emergencyContactName")}
          title="¿A quién llamamos en una emergencia?"
          onSkip={() =>
            set({
              emergencyName: "",
              emergencyPhone: "",
              emergencyPhoneDigits: 0,
              emergencyRelationship: "",
            })
          }
          check={() => {
            const needed = required("emergencyContactName") || Boolean(draft.emergencyName.trim())
            return (
              needs(needed && !draft.emergencyName.trim(), "emergencyName", "Escribe su nombre.") ??
              phoneFound(
                "emergencyPhone",
                draft.emergencyPhone,
                draft.emergencyPhoneDigits,
                needed,
                "Escribe su teléfono.",
              )
            )
          }}
        >
          <Labeled name="emergencyName" label="Nombre">
            {(control) => (
              <Input
                {...control.props}
                autoComplete="off"
                maxLength={200}
                value={draft.emergencyName}
                onChange={(event) => set({ emergencyName: event.target.value })}
              />
            )}
          </Labeled>
          <Labeled name="emergencyPhone" label="Teléfono">
            {(control) => (
              <PhoneInput
                id={control.id}
                name={control.name}
                value={draft.emergencyPhone || null}
                onChange={(value, meta) =>
                  set({ emergencyPhone: value ?? "", emergencyPhoneDigits: meta.digits.length })
                }
                defaultCountry={phoneCountry}
                autoComplete="off"
                invalid={control.invalid}
                aria-describedby={control.describedBy}
                onBlur={control.onBlur}
              />
            )}
          </Labeled>
          <Labeled
            name="emergencyRelationship"
            group
            label={you("¿Qué es tuyo?", `¿Qué es de ${name}?`)}
            optional
          >
            {(control) => (
              <Pick
                control={control}
                label="Parentesco del contacto de emergencia"
                value={draft.emergencyRelationship}
                options={KINSHIP.map((code) => ({ value: code, label: KINSHIP_LABELS[code] }))}
                onChange={(value) => set({ emergencyRelationship: value })}
              />
            )}
          </Labeled>
        </Question>

        <Question
          name="insurance"
          grouped
          required={required("insuranceType")}
          disabled={!asked("insuranceType")}
          title={you(
            "¿Tienes seguro de salud?",
            `¿${first || "La persona"} tiene seguro de salud?`,
          )}
          onSkip={() => set({ insurance: "", insurerName: "", affiliationNumber: "" })}
          check={() =>
            needs(required("insuranceType") && !insurance, "insurance", "Elige una opción.")
          }
        >
          <Labeled name="insurance" group label="¿Cuál?" optional={!required("insuranceType")}>
            {(control) => (
              <ChoiceButtons
                id={control.id}
                aria-label="Seguro de salud"
                aria-describedby={control.describedBy}
                invalid={control.invalid}
                onBlur={control.onBlur}
                value={draft.insurance || null}
                options={insuranceOptions}
                onChange={(value) => set({ insurance: value })}
                columns={2}
              />
            )}
          </Labeled>
          {privateInsurance ? (
            <>
              <Labeled name="insurerName" label="Aseguradora" optional>
                {(control) => (
                  <Input
                    {...control.props}
                    autoComplete="off"
                    maxLength={200}
                    value={draft.insurerName}
                    onChange={(event) => set({ insurerName: event.target.value })}
                  />
                )}
              </Labeled>
              <Labeled
                name="affiliationNumber"
                label="Número de afiliación o póliza"
                optional
              >
                {(control) => (
                  <Input
                    {...control.props}
                    autoComplete="off"
                    maxLength={50}
                    value={draft.affiliationNumber}
                    onChange={(event) => set({ affiliationNumber: event.target.value })}
                  />
                )}
              </Labeled>
            </>
          ) : null}
        </Question>

        <Question
          name="health"
          grouped
          required={healthRequired}
          disabled={!healthAsked}
          title={you("Tu salud", `La salud de ${name}`)}
          description={
            child
              ? fill
                ? `${answeredBy} ${healthRequired ? "" : "Es opcional; "}${healthRequired ? "Lo" : "lo"} revisan contigo en la cita.`
                : `${answeredBy} Así quien atiende a ${name} lo sabe antes de empezar.`
              : fill
                ? healthRequired
                  ? "Ayuda a quien te atiende; lo revisa contigo en la cita."
                  : "Es opcional. Ayuda a quien te atiende; lo revisa contigo en la cita."
                : "Así quien te atiende lo sabe antes de empezar."
          }
          saysOptional={!!fill}
          onSkip={() =>
            set({
              allergies: "",
              allergiesText: "",
              allergiesReaction: "",
              conditions: "",
              conditionsPicked: [],
              conditionsText: "",
              heartRisk: "",
              heartAntibiotic: "",
              anesthesia: "",
              bloodGroup: "",
            })
          }
          check={() =>
            declaredFound(
              "allergies",
              asked("allergies") && required("allergies"),
              draft.allergies,
              draft.allergiesText,
            ) ??
            declaredFound(
              "conditions",
              asked("conditions") && required("conditions"),
              draft.conditions,
              // Lo marcado de la lista ya dice cuál.
              draft.conditionsPicked.length ? "lista" : draft.conditionsText,
            ) ??
            needs(
              asked("dental.corazon") && required("dental.corazon") && !draft.heartRisk && !draft.heartAntibiotic,
              "heartRisk",
              "Elige una respuesta.",
            ) ??
            needs(
              asked("dental.problemaAnestesia") && required("dental.problemaAnestesia") && !draft.anesthesia,
              "anesthesia",
              "Elige una respuesta.",
            ) ??
            needs(
              asked("bloodGroup") && required("bloodGroup") && !draft.bloodGroup,
              "bloodGroup",
              "Elige una opción.",
            )
          }
        >
          {asked("allergies") ? (
            <DeclaredField
              name="allergies"
              optional={!required("allergies")}
              label={you(
                "¿Eres alérgico a algún medicamento o material?",
                `¿${first || "La persona"} es alérgico a algún medicamento o material?`,
              )}
              hint="Por ejemplo, penicilina, anestesia o látex."
              detailLabel="¿A qué? Si son varias cosas, sepáralas con comas."
              state={draft.allergies}
              text={draft.allergiesText}
              onState={(value) => set({ allergies: value })}
              onText={(value) => set({ allergiesText: value })}
            >
              <Input
                aria-label="¿Qué te pasó?"
                placeholder={you("¿Qué te pasó? Por ejemplo, me salieron ronchas", "¿Qué le pasó? Por ejemplo, le salieron ronchas")}
                autoComplete="off"
                maxLength={500}
                value={draft.allergiesReaction}
                onChange={(event) => set({ allergiesReaction: event.target.value })}
              />
            </DeclaredField>
          ) : null}
          {asked("conditions") ? (
            <DeclaredField
              name="conditions"
              optional={!required("conditions")}
              label={you(
                "¿Tienes alguna de estas enfermedades?",
                `¿${first || "La persona"} tiene alguna de estas enfermedades?`,
              )}
              // A quien cuida a un niño, con ejemplos de niño: nunca «diabetes, presión alta».
              hint={
                child
                  ? "Por ejemplo, asma, convulsiones o problemas de sangrado."
                  : "Diabetes, presión alta, problemas de sangrado, radioterapia en cabeza o cuello…"
              }
              detailLabel="Otra: ¿cuál? Si son varias, sepáralas con comas."
              state={draft.conditions}
              text={draft.conditionsText}
              onState={(value) => set({ conditions: value })}
              onText={(value) => set({ conditionsText: value })}
              before={
                <MultiChoiceButtons
                  label="Enfermedades"
                  value={draft.conditionsPicked}
                  options={child ? CHILD_CONDITION_OPTIONS : CONDITION_OPTIONS}
                  onChange={(value) => set({ conditionsPicked: value })}
                  columns={2}
                />
              }
            />
          ) : null}
          {asked("dental.corazon") ? (
            <>
              <Labeled
                name="heartRisk"
                group
                label={you(
                  "¿Tienes una válvula del corazón operada, naciste con un problema del corazón o tuviste una infección en el corazón (endocarditis)?",
                  `¿${first || "La persona"} tiene una válvula del corazón operada, nació con un problema del corazón o tuvo una infección en el corazón (endocarditis)?`,
                )}
                optional={!required("dental.corazon")}
              >
                {(control) => (
                  <ChoiceButtons
                    id={control.id}
                    aria-labelledby={control.labelId}
                    aria-describedby={control.describedBy}
                    invalid={control.invalid}
                    onBlur={control.onBlur}
                    value={draft.heartRisk || null}
                    options={YES_NO_UNKNOWN}
                    onChange={(value) => set({ heartRisk: value })}
                    columns={3}
                  />
                )}
              </Labeled>
              <Labeled
                name="heartAntibiotic"
                group
                label={you(
                  "¿Algún médico te dijo que tomes antibiótico antes de ir al dentista?",
                  `¿Algún médico le dijo a ${name} que tome antibiótico antes de ir al dentista?`,
                )}
                optional
              >
                {(control) => (
                  <ChoiceButtons
                    id={control.id}
                    aria-labelledby={control.labelId}
                    aria-describedby={control.describedBy}
                    invalid={control.invalid}
                    onBlur={control.onBlur}
                    value={draft.heartAntibiotic || null}
                    options={YES_NO_UNKNOWN}
                    onChange={(value) => set({ heartAntibiotic: value })}
                    columns={3}
                  />
                )}
              </Labeled>
            </>
          ) : null}
          {asked("dental.problemaAnestesia") ? (
            <Labeled
              name="anesthesia"
              group
              label={you(
                "¿Tuviste algún problema con la anestesia del dentista, o sangraste mucho después de una extracción?",
                `¿${first || "La persona"} tuvo algún problema con la anestesia del dentista, o sangró mucho después de una extracción?`,
              )}
              optional={!required("dental.problemaAnestesia")}
            >
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.anesthesia || null}
                  options={YES_NO_UNKNOWN}
                  onChange={(value) => set({ anesthesia: value })}
                  columns={3}
                />
              )}
            </Labeled>
          ) : null}
          {asked("bloodGroup") ? (
            <Labeled name="bloodGroup" group label="Grupo sanguíneo" optional={!required("bloodGroup")}>
              {(control) => (
                <Pick
                  control={control}
                  label="Grupo sanguíneo"
                  value={draft.bloodGroup}
                  options={Object.entries(BLOOD_GROUP_LABELS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={(value) => set({ bloodGroup: value })}
                />
              )}
            </Labeled>
          ) : null}
        </Question>

        <Question
          name="medicines"
          grouped
          required={medicinesRequired}
          disabled={!medicinesAsked}
          title={you("Tus medicinas", `Las medicinas de ${name}`)}
          description={
            medicinesRequired
              ? "Algunas medicinas cambian lo que se hace en la cita."
              : "Es opcional. Algunas medicinas cambian lo que se hace en la cita."
          }
          saysOptional
          onSkip={() =>
            set({
              anticoagulants: "",
              anticoagulantsText: "",
              boneMedicines: "",
              boneMedicinesText: "",
              medications: "",
              medicationsText: "",
            })
          }
          check={() =>
            declaredFound(
              "anticoagulants",
              asked("anticoagulants") && required("anticoagulants"),
              draft.anticoagulants,
              draft.anticoagulantsText,
              true,
            ) ??
            declaredFound(
              "boneMedicines",
              asked("boneMedicines") && required("boneMedicines"),
              draft.boneMedicines,
              draft.boneMedicinesText,
              true,
            ) ??
            declaredFound(
              "medications",
              asked("medications") && required("medications"),
              draft.medications,
              draft.medicationsText,
            )
          }
        >
          {asked("anticoagulants") ? (
            <DeclaredField
              name="anticoagulants"
              optional={!required("anticoagulants")}
              label={you(
                "¿Tomas algún medicamento para que la sangre no forme coágulos, o aspirina todos los días?",
                `¿${first || "La persona"} toma algún medicamento para que la sangre no forme coágulos, o aspirina todos los días?`,
              )}
              hint="Por ejemplo, warfarina, Sintrom, rivaroxabán, apixabán o clopidogrel."
              detailLabel="¿Cuál? (si lo sabes)"
              detailOptional
              state={draft.anticoagulants}
              text={draft.anticoagulantsText}
              onState={(value) => set({ anticoagulants: value })}
              onText={(value) => set({ anticoagulantsText: value })}
            />
          ) : null}
          {asked("boneMedicines") ? (
            <DeclaredField
              name="boneMedicines"
              optional={!required("boneMedicines")}
              label={you(
                "¿Tomas o tomaste alguna vez medicinas para los huesos, por osteoporosis o por un cáncer?",
                `¿${first || "La persona"} toma o tomó alguna vez medicinas para los huesos, por osteoporosis o por un cáncer?`,
              )}
              hint="Pastillas, como el alendronato, o una inyección."
              detailLabel="¿Cuál y desde cuándo? (si lo sabes)"
              detailOptional
              state={draft.boneMedicines}
              text={draft.boneMedicinesText}
              onState={(value) => set({ boneMedicines: value })}
              onText={(value) => set({ boneMedicinesText: value })}
            />
          ) : null}
          {asked("medications") ? (
            <DeclaredField
              name="medications"
              optional={!required("medications")}
              label={
                asked("anticoagulants") || asked("boneMedicines")
                  ? you("¿Tomas algún otro medicamento todos los días?", `¿${first || "La persona"} toma algún otro medicamento todos los días?`)
                  : you("¿Tomas algún medicamento todos los días?", `¿${first || "La persona"} toma algún medicamento todos los días?`)
              }
              detailLabel="¿Cuál? Si son varios, sepáralos con comas."
              state={draft.medications}
              text={draft.medicationsText}
              onState={(value) => set({ medications: value })}
              onText={(value) => set({ medicationsText: value })}
            />
          ) : null}
        </Question>

        <Question
          name="history"
          grouped
          disabled={!historyAsked}
          title={you("Algo más sobre tu salud", `Algo más sobre la salud de ${name}`)}
          check={() =>
            needs(
              pregnancyAsked && draft.pregnant === "si" && Number(draft.pregnancyWeeks) > 42,
              "pregnant",
              "Las semanas de embarazo van de 0 a 42.",
            )
          }
          onSkip={() =>
            set({
              pregnant: "",
              pregnancyWeeks: "",
              breastfeeding: "",
              surgeries: "",
              surgeriesText: "",
              hospitalized: "",
              hospitalizedText: "",
              transfusion: "",
              transfusionText: "",
            })
          }
        >
          {pregnancyAsked ? (
            <Labeled
              name="pregnant"
              group
              label={you("¿Estás embarazada?", `¿${first || "La persona"} está embarazada?`)}
              optional
            >
              {(control) => (
              <>
              <ChoiceButtons
                id={control.id}
                aria-labelledby={control.labelId}
                aria-describedby={control.describedBy}
                invalid={control.invalid}
                onBlur={control.onBlur}
                value={draft.pregnant || null}
                options={YES_NO_UNKNOWN}
                onChange={(value) => set({ pregnant: value })}
                columns={3}
              />
              {draft.pregnant === "si" ? (
                <div className="flex items-center gap-3">
                  <Input
                    aria-label="Semanas de embarazo"
                    className="w-24"
                    inputMode="numeric"
                    maxLength={2}
                    value={draft.pregnancyWeeks}
                    onChange={(event) =>
                      set({ pregnancyWeeks: event.target.value.replace(/\D/g, "") })
                    }
                  />
                  <span className="text-sm text-muted-foreground">semanas (si lo sabes)</span>
                </div>
              ) : null}
              </>
              )}
            </Labeled>
          ) : null}
          {breastfeedingAsked ? (
            <Labeled
              name="breastfeeding"
              group
              label={you("¿Estás dando de lactar?", `¿${first || "La persona"} está dando de lactar?`)}
              optional
            >
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.breastfeeding || null}
                  options={YES_NO}
                  onChange={(value) => set({ breastfeeding: value })}
                  columns={2}
                />
              )}
            </Labeled>
          ) : null}
          {asked("personal.cirugias") ? (
            <YesNoField
              name="surgeries"
              label={you("¿Te han operado alguna vez?", `¿A ${name} lo han operado alguna vez?`)}
              detail="¿De qué y cuándo?"
              answer={draft.surgeries}
              text={draft.surgeriesText}
              onAnswer={(value) => set({ surgeries: value })}
              onText={(value) => set({ surgeriesText: value })}
            />
          ) : null}
          {asked("personal.hospitalizaciones") ? (
            <YesNoField
              name="hospitalized"
              label={you(
                "¿Has estado internado en un hospital?",
                `¿${first || "La persona"} ha estado internada en un hospital?`,
              )}
              detail="¿Por qué y cuándo?"
              answer={draft.hospitalized}
              text={draft.hospitalizedText}
              onAnswer={(value) => set({ hospitalized: value })}
              onText={(value) => set({ hospitalizedText: value })}
            />
          ) : null}
          {asked("personal.transfusiones") ? (
            <YesNoField
              name="transfusion"
              label={you(
                "¿Te han hecho una transfusión de sangre?",
                `¿A ${name} le han hecho una transfusión de sangre?`,
              )}
              detail="¿Cuándo?"
              answer={draft.transfusion}
              text={draft.transfusionText}
              onAnswer={(value) => set({ transfusion: value })}
              onText={(value) => set({ transfusionText: value })}
            />
          ) : null}
        </Question>

        <Question
          name="childhood"
          grouped
          disabled={!childhoodKeys.some(asked)}
          title={first ? `${first} de pequeño` : "De pequeño"}
          description={`${answeredBy} Ayuda a cuidar sus dientes.`}
          onSkip={() => set({ bottle: "", pacifier: "", sweets: "", fluoride: "", brusher: "" })}
        >
          {asked("dental.biberon") ? (
            <Labeled name="bottle" group label={first ? `¿${first} toma biberón o pecho para dormir?` : "¿Toma biberón o pecho para dormir?"} optional>
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.bottle || null}
                  options={BOTTLE_OPTIONS}
                  onChange={(value) => set({ bottle: value })}
                  columns={3}
                />
              )}
            </Labeled>
          ) : null}
          {asked("dental.chupon") ? (
            <Labeled name="pacifier" group label="¿Usa chupón o se chupa el dedo?" optional>
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.pacifier || null}
                  options={PACIFIER_OPTIONS}
                  onChange={(value) => set({ pacifier: value })}
                  columns={3}
                />
              )}
            </Labeled>
          ) : null}
          {asked("dental.dulcesEntreComidas") ? (
            <Labeled
              name="sweets"
              group
              label="¿Cuántas veces al día come dulces o toma jugos entre comidas?"
              optional
            >
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.sweets || null}
                  options={SWEETS_OPTIONS}
                  onChange={(value) => set({ sweets: value })}
                  columns={3}
                />
              )}
            </Labeled>
          ) : null}
          {asked("dental.pastaConFluor") ? (
            <Labeled name="fluoride" group label="¿Su pasta de dientes tiene flúor?" optional>
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.fluoride || null}
                  options={FLUORIDE_OPTIONS}
                  onChange={(value) => set({ fluoride: value })}
                  columns={3}
                />
              )}
            </Labeled>
          ) : null}
          {asked("dental.quienCepilla") ? (
            <Labeled name="brusher" group label="¿Quién le cepilla los dientes?" optional>
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.brusher || null}
                  options={brusherOptions(draft.sex)}
                  onChange={(value) => set({ brusher: value })}
                  columns={3}
                />
              )}
            </Labeled>
          ) : null}
        </Question>

        <Question
          name="dental"
          grouped
          disabled={!dentalKeys.some(asked)}
          title={you("Tu boca", `La boca de ${name}`)}
          description="Nos ayuda a preparar la primera visita."
          onSkip={() =>
            set({
              dentalLast: "",
              dentalExperience: "",
              dentalAnxiety: "",
              brushing: "",
              floss: "",
              bruxism: "",
              habits: [],
            })
          }
        >
          {asked("dental.ultimaVisita") ? (
            <Labeled
              name="dentalLast"
              label="¿Cuándo fue la última visita al dentista?"
              optional
            >
              {(control) => (
                <Input
                  {...control.props}
                  placeholder="Por ejemplo, hace un año"
                  autoComplete="off"
                  maxLength={200}
                  value={draft.dentalLast}
                  onChange={(event) => set({ dentalLast: event.target.value })}
                />
              )}
            </Labeled>
          ) : null}
          {asked("dental.experienciaPrevia") ? (
            <Labeled name="dentalExperience" group label="¿Cómo le fue esa vez?" optional>
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.dentalExperience || null}
                  options={EXPERIENCES}
                  onChange={(value) => set({ dentalExperience: value })}
                  columns={3}
                />
              )}
            </Labeled>
          ) : null}
          {asked("dental.ansiedadDental") ? (
            <Labeled
              name="dentalAnxiety"
              group
              label={you("¿Te da miedo ir al dentista?", `¿A ${name} le da miedo ir al dentista?`)}
              optional
            >
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.dentalAnxiety || null}
                  options={ANXIETY}
                  onChange={(value) => set({ dentalAnxiety: value })}
                  columns={4}
                />
              )}
            </Labeled>
          ) : null}
          {asked("dental.cepilladosAlDia") ? (
            <Labeled name="brushing" group label="¿Cuántas veces al día se cepilla los dientes?" optional>
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.brushing || null}
                  options={BRUSHING}
                  onChange={(value) => set({ brushing: value })}
                  columns={4}
                />
              )}
            </Labeled>
          ) : null}
          {asked("dental.hiloDental") ? (
            <Labeled name="floss" group label="¿Usa hilo dental?" optional>
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.floss || null}
                  options={YES_NO}
                  onChange={(value) => set({ floss: value })}
                  columns={2}
                />
              )}
            </Labeled>
          ) : null}
          {asked("dental.bruxismo") ? (
            <Labeled
              name="bruxism"
              group
              label="¿Aprieta o rechina los dientes, por ejemplo al dormir?"
              optional
            >
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.bruxism || null}
                  options={YES_NO_UNKNOWN}
                  onChange={(value) => set({ bruxism: value })}
                  columns={3}
                />
              )}
            </Labeled>
          ) : null}
          {asked("dental.habitos") ? (
            <Labeled
              name="habits"
              group
              label="¿Tiene alguno de estos hábitos?"
              hint="Marca todos los que correspondan."
              optional
            >
              {() => (
                <MultiChoiceButtons
                  label="Hábitos"
                  value={draft.habits}
                  options={HABITS}
                  onChange={(value) => set({ habits: value })}
                  columns={2}
                />
              )}
            </Labeled>
          ) : null}
        </Question>

        <Question
          name="habits"
          grouped
          disabled={!(["medical.tabaco", "medical.alcohol"] as const).some(asked)}
          title={you("Tus hábitos", `Los hábitos de ${name}`)}
          description="Nos ayuda a cuidarte mejor."
          onSkip={() => set({ tobacco: "", cigarettes: "", alcohol: "" })}
        >
          {asked("medical.tabaco") ? (
            <Labeled name="tobacco" group label={you("¿Fumas?", `¿${first || "La persona"} fuma?`)} optional>
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.tobacco || null}
                  options={TOBACCO_OPTIONS}
                  onChange={(value) => set({ tobacco: value, ...(value === "fuma" ? {} : { cigarettes: "" }) })}
                  columns={3}
                />
              )}
            </Labeled>
          ) : null}
          {asked("medical.tabaco") && draft.tobacco === "fuma" ? (
            <Labeled name="cigarettes" group label="¿Cuántos cigarrillos al día?" optional>
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.cigarettes || null}
                  options={CIGARETTE_OPTIONS}
                  onChange={(value) => set({ cigarettes: value })}
                  columns={2}
                />
              )}
            </Labeled>
          ) : null}
          {asked("medical.alcohol") ? (
            <Labeled
              name="alcohol"
              group
              label={you("¿Tomas alcohol?", `¿${first || "La persona"} toma alcohol?`)}
              optional
            >
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.alcohol || null}
                  options={ALCOHOL_OPTIONS}
                  onChange={(value) => set({ alcohol: value })}
                  columns={3}
                />
              )}
            </Labeled>
          ) : null}
        </Question>

        <Question
          name="census"
          grouped
          disabled={!censusKeys.some(censusAsked)}
          title={you("Para conocerte mejor", `Para conocer mejor a ${name}`)}
          onSkip={() =>
            set({
              maritalStatus: "",
              educationLevel: "",
              occupation: "",
              origin: "",
              referralKind: "",
              referralSource: "",
            })
          }
        >
          {censusAsked("maritalStatus") ? (
            <Labeled name="maritalStatus" group label="Estado civil" optional>
              {(control) => (
                <Pick
                  control={control}
                  label="Estado civil"
                  value={draft.maritalStatus}
                  options={profile.maritalStatuses.map((status) => ({
                    value: status,
                    label: MARITAL_STATUS_LABELS[status],
                  }))}
                  onChange={(value) => set({ maritalStatus: value })}
                />
              )}
            </Labeled>
          ) : null}
          {asked("educationLevel") ? (
            <Labeled name="educationLevel" group label="Hasta qué nivel estudió" optional>
              {(control) => (
                <Pick
                  control={control}
                  label="Nivel educativo"
                  value={draft.educationLevel}
                  options={EDUCATION_LEVELS.map((level) => ({
                    value: level,
                    label: EDUCATION_LEVEL_LABELS[level],
                  }))}
                  onChange={(value) => set({ educationLevel: value })}
                />
              )}
            </Labeled>
          ) : null}
          {censusAsked("occupation") ? (
            <Labeled name="occupation" label="Ocupación" optional>
              {(control) => (
                <Input
                  {...control.props}
                  autoComplete="off"
                  maxLength={200}
                  value={draft.occupation}
                  onChange={(event) => set({ occupation: event.target.value })}
                />
              )}
            </Labeled>
          ) : null}
          {asked("origin") ? (
            <Labeled
              name="origin"
              label="Procedencia"
              hint="La ciudad o región de donde viene."
              optional
            >
              {(control) => (
                <Input
                  {...control.props}
                  autoComplete="off"
                  maxLength={200}
                  value={draft.origin}
                  onChange={(event) => set({ origin: event.target.value })}
                />
              )}
            </Labeled>
          ) : null}
          {asked("referralSource") ? (
            <Labeled name="referralKind" group label="¿Cómo nos conoció?" optional>
              {(control) => (
                <Pick
                  control={control}
                  label="Cómo nos conoció"
                  value={draft.referralKind}
                  options={REFERRAL_KINDS.map((kind) => ({ value: kind, label: REFERRAL_KIND_LABELS[kind] }))}
                  // Solo «Otro» lleva lo que dijo.
                  onChange={(value) => set({ referralKind: value, ...(value === "otro" ? {} : { referralSource: "" }) })}
                />
              )}
            </Labeled>
          ) : null}
          {asked("referralSource") && draft.referralKind === "otro" ? (
            <Labeled name="referralSource" label="¿Cuál?" optional>
              {(control) => (
                <Input
                  {...control.props}
                  placeholder="Por ejemplo, la radio"
                  autoComplete="off"
                  maxLength={200}
                  value={draft.referralSource}
                  onChange={(event) => set({ referralSource: event.target.value })}
                />
              )}
            </Labeled>
          ) : null}
        </Question>

        {fill && visitAsks ? (
          // «Tu visita», el último paso de «Antes de tu cita» (mesa del 13 nov, entrega 8): todo
          // opcional; en una sesión o un control se le dice a qué viene y solo se le pregunta si le duele.
          <Question
            name="visit"
            grouped
            saysOptional
            title={child ? `La visita de ${name}` : "Tu visita"}
            description={`Lo lee ${fill.visit?.reader ?? "quien te atiende"} antes de empezar. Todo es opcional.`}
            onSkip={() => set({ visitReason: "", visitPain: "", visitPainLevel: "", visitMore: "" })}
          >
            {fill.visit?.purpose ? (
              <p className="rounded-2xl bg-muted/60 px-4 py-3 text-sm">
                <span className="text-muted-foreground">{child ? "Viene a: " : "Vienes a: "}</span>
                <span className="font-medium">{fill.visit.purpose}</span>
              </p>
            ) : null}
            {visitAsks.reason ? (
              <Labeled
                name="visitReason"
                label={you(
                  "¿A qué vienes? Cuéntalo con tus palabras: qué te molesta o qué te gustaría cambiar.",
                  `¿A qué viene ${name}? Cuéntalo con tus palabras: qué le molesta o qué le gustaría cambiar.`,
                )}
                optional
              >
                {(control) => (
                  <Textarea
                    {...control.props}
                    rows={3}
                    maxLength={2000}
                    enterKeyHint="next"
                    value={draft.visitReason}
                    onChange={(event) => set({ visitReason: event.target.value })}
                  />
                )}
              </Labeled>
            ) : null}
            {visitAsks.pain ? (
              <Labeled name="visitPain" group label={you("¿Te duele ahora?", `¿A ${name} le duele ahora?`)} optional>
                {(control) => (
                  <ChoiceButtons
                    id={control.id}
                    aria-labelledby={control.labelId}
                    aria-describedby={control.describedBy}
                    invalid={control.invalid}
                    onBlur={control.onBlur}
                    value={draft.visitPain || null}
                    options={YES_NO}
                    // Sin dolor, no hay cuánto.
                    onChange={(value) => set({ visitPain: value, ...(value === "si" ? {} : { visitPainLevel: "" }) })}
                    columns={2}
                  />
                )}
              </Labeled>
            ) : null}
            {visitAsks.pain && draft.visitPain === "si" ? (
              <Labeled name="visitPainLevel" group label="¿Cuánto? 0 es sin dolor, 10 el peor." optional>
                {(control) => (
                  <ChoiceButtons
                    id={control.id}
                    aria-labelledby={control.labelId}
                    aria-describedby={control.describedBy}
                    invalid={control.invalid}
                    onBlur={control.onBlur}
                    value={draft.visitPainLevel || null}
                    options={PAIN_LEVELS}
                    onChange={(value) => set({ visitPainLevel: value })}
                    // Tocar otra vez el número lo desmarca: no hace falta decir cuánto.
                    onClear={() => set({ visitPainLevel: "" })}
                  />
                )}
              </Labeled>
            ) : null}
            {visitAsks.more ? (
              <Labeled name="visitMore" label="¿Algo más que quieras contarnos?" optional>
                {(control) => (
                  <Input
                    {...control.props}
                    autoComplete="off"
                    maxLength={2000}
                    value={draft.visitMore}
                    onChange={(event) => set({ visitMore: event.target.value })}
                  />
                )}
              </Labeled>
            ) : null}
          </Question>
        ) : null}

        {fill ? (
          <Question
            name="send"
            grouped
            required
            disabled={finishEarly}
            title="Antes de enviar"
            description={`Tus respuestas llegan a ${fill.clinicName ?? "quien te atiende"} al tocar «Enviar». Lo que ya tenemos no cambia.`}
            submit={sending ? "Enviando…" : submitLabel}
            sending={sending}
            // Novedades y promociones se pregunta y se puede dejar sin responder, como en el registro (mesa
            // del 13 nov, decisión 7): solo el aviso de privacidad, si falta, se pide para enviar.
            check={() =>
              needs(!!fill.privacy && !draft.privacy, "privacy", "Para enviar necesitamos que aceptes el aviso de privacidad.")
            }
          >
            {fill.promotions ? (
              <Labeled
                name="messages"
                group
                optional
                label={`¿Quieres recibir novedades y promociones de ${fill.clinicName ?? "quien te atiende"} por WhatsApp?`}
                hint={`Descuentos y campañas${fill.clinicName ? ` de ${fill.clinicName}` : ""}. Puedes darte de baja cuando quieras.`}
              >
                {(control) => (
                  <ChoiceButtons
                    id={control.id}
                    aria-labelledby={control.labelId}
                    aria-describedby={control.describedBy}
                    invalid={control.invalid}
                    onBlur={control.onBlur}
                    value={draft.messages || null}
                    options={[
                      { value: "si", label: "Sí, quiero" },
                      { value: "no", label: "No, gracias" },
                    ]}
                    onChange={(value) => set({ messages: value })}
                    columns={2}
                  />
                )}
              </Labeled>
            ) : null}
            {fill.privacy ? (
              <PrivacyAccept
                clinicName={fill.clinicName ?? null}
                notice={config.privacyNotice}
                checked={draft.privacy}
                onChange={(privacy) => set({ privacy })}
              />
            ) : null}
          </Question>
        ) : (
        <Question
          name="send"
          required
          multiple
          missing="Marca la casilla para enviar tu registro."
          title="Antes de enviar"
          submit={sending ? "Enviando…" : submitLabel}
          sending={sending}
        >
          {config.privacyNotice.trim() ? (
            <ScrollArea className="flex max-h-48 flex-col rounded-2xl bg-muted/60">
              <QuestionnaireDescription className="p-4 whitespace-pre-wrap">
                {config.privacyNotice}
              </QuestionnaireDescription>
            </ScrollArea>
          ) : null}
          <QuestionnaireChoices>
            <QuestionnaireChoice
              value="si"
              checked={draft.privacy}
              onChange={(event) => set({ privacy: event.target.checked })}
            >
              {/* Quien registra a otra persona da los datos de los dos: la casilla los nombra. Las palabras
                  legales del permiso son las de siempre (pendiente legal de la mesa del 13 nov). */}
              {forOther
                ? `Autorizo el tratamiento de los datos de ${first || "la persona"} y los míos para el registro en la clínica.`
                : "Autorizo el tratamiento de mis datos personales para el registro en la clínica."}
            </QuestionnaireChoice>
          </QuestionnaireChoices>
          <FieldMessage name="privacy" />
          {config.askMessages ? (
            <Labeled
              name="messages"
              group
              label="¿Te podemos escribir para enviarte novedades y promociones?"
              hint="Los avisos de tus citas te llegan igual. Puedes darte de baja cuando quieras."
              optional
            >
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  aria-labelledby={control.labelId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={draft.messages || null}
                  options={[
                    { value: "si", label: "Sí, acepto" },
                    { value: "no", label: "No, gracias" },
                  ]}
                  onChange={(value) => set({ messages: value })}
                  columns={2}
                />
              )}
            </Labeled>
          ) : null}
        </Question>
        )}
      </Questionnaire>
      </FinishContext.Provider>
    </FormContext.Provider>
  )
}

/**
 * Lo que falta en una declaración de salud: la respuesta o, si es «Sí», cuál.
 * `detailOptional`: el Sí basta (anticoagulantes, huesos: la marca sale de la respuesta).
 */
function declaredFound(
  field: keyof Draft,
  needed: boolean,
  state: Declared,
  text: string,
  detailOptional = false,
): Found {
  if (needed && !state) return { field, message: "Elige una respuesta." }
  if (state === "recorded" && !detailOptional && !text.trim())
    return { field, message: "Escribe cuál, o elige «No sé»." }
  return null
}

/**
 * Una pantalla del registro: un tema con su título y sus campos, y «Anterior /
 * Saltar / Siguiente». `check` dice qué falta antes de seguir, con el botón o
 * con Enter. Las pantallas de varios campos (`grouped`) llevan una respuesta
 * oculta para que el cuestionario las dé por respondidas: lo que falta lo dice
 * `check`, junto al campo.
 */
function Question({
  name,
  title,
  description,
  saysOptional = false,
  required = false,
  multiple = false,
  disabled = false,
  grouped = false,
  check,
  onSkip,
  submit,
  sending = false,
  missing,
  children,
}: {
  name: string
  title: string
  description?: string
  /** La descripción ya dice si es opcional: no se le suma «Todo es opcional.». */
  saysOptional?: boolean
  required?: boolean
  multiple?: boolean
  disabled?: boolean
  grouped?: boolean
  check?: () => Found
  onSkip?: () => void
  /** Última pantalla: el texto del botón que envía. */
  submit?: string
  sending?: boolean
  /** Qué decir si se intenta seguir sin responder. */
  missing?: string
  children: React.ReactNode
}) {
  const form = useRegistrationFormContext()
  const fillContext = useContext(FinishContext)
  // Al enviar se revisa la pantalla desde la que se envía (en «Su enlace», también sin «Antes de enviar»).
  if (fillContext && check) fillContext.checks.set(name, check)
  const finish = fillContext?.label ? { label: fillContext.label, sending: fillContext.sending } : null
  const allOptional = grouped && !required
  // Lo que no es de ningún campo (lo rechazó el servidor) va al pie de la pantalla desde la que se envía.
  const submitError = useFormSubmitError(form)
  const loose = name === "send" || finish ? submitError : null

  function blocked(fieldset: HTMLElement): boolean {
    const found = check?.() ?? null
    // Lo que no se pregunta en esta pantalla no la detiene: no habría dónde decirlo.
    if (!found || !form.fieldInfo[found.field]?.instance) return false
    showFound(form, found)
    requestAnimationFrame(() => {
      fieldset
        .querySelector<HTMLElement>(
          `[data-field="${found.field}"] :is(input:not([hidden]):not([aria-hidden=true]), button, [role=combobox], [role=checkbox])`,
        )
        ?.focus()
    })
    return true
  }

  return (
    <QuestionnaireItem
      name={name}
      required={required}
      multiple={multiple}
      disabled={disabled}
      invalid={loose !== null}
      onStatusChange={(status) => {
        if (status === "skipped") onSkip?.()
      }}
      onKeyDown={(event) => {
        const target = event.target
        if (!grouped || !(target instanceof HTMLElement)) return
        const typing =
          target instanceof HTMLInputElement && !["radio", "checkbox"].includes(target.type)
        // En una pantalla de varios campos las flechas son de cada campo, no para cambiar de pantalla.
        if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !typing) {
          event.preventDefault()
          return
        }
        if (event.key !== "Enter" || event.nativeEvent.isComposing || !typing) return
        // En el buscador de país, Enter elige el país; nunca envía el formulario.
        if (target.getAttribute("role") === "combobox") {
          event.preventDefault()
          return
        }
        // Enter pasa al campo siguiente; en el último, sigue a la otra pantalla.
        event.preventDefault()
        const fields = [
          ...event.currentTarget.querySelectorAll<HTMLInputElement>(
            "input:not([hidden]):not([type=hidden]):not([type=radio]):not([type=checkbox]):not(:disabled)",
          ),
        ].filter((input) => input.tabIndex !== -1)
        const next = fields[fields.indexOf(target as HTMLInputElement) + 1]
        if (next) {
          next.focus()
          return
        }
        if (!blocked(event.currentTarget))
          event.currentTarget
            .querySelector<HTMLButtonElement>(
              "[data-slot=questionnaire-next]:not([hidden]), [data-slot=questionnaire-submit]:not([hidden])",
            )
            ?.click()
      }}
    >
      <QuestionnaireTitle className="text-xl leading-snug">{title}</QuestionnaireTitle>
      {description || allOptional ? (
        <QuestionnaireDescription>
          {[description, allOptional && !saysOptional ? "Todo es opcional." : null].filter(Boolean).join(" ")}
        </QuestionnaireDescription>
      ) : null}
      <AllOptionalContext.Provider value={allOptional}>
        {grouped ? <div className="flex min-w-0 flex-col gap-5">{children}</div> : children}
      </AllOptionalContext.Provider>
      {grouped ? <Carry /> : null}
      {loose ? (
        <p role="alert" className="text-sm text-destructive">
          {loose}
        </p>
      ) : grouped ? null : (
        <QuestionnaireError>
          {missing ?? (required ? "Responde para seguir." : "Responde o toca «Saltar».")}
        </QuestionnaireError>
      )}
      <QuestionnaireActions
        // Cuando se envía desde aquí, «Saltar» sobra: todo es opcional y «Enviar» ya lo deja en blanco.
        className={finish ? "has-[>[data-slot=questionnaire-submit]:not([hidden])]:[&>[data-slot=questionnaire-skip]]:hidden" : undefined}
      >
        <QuestionnairePrevious>Anterior</QuestionnairePrevious>
        {required ? null : <QuestionnaireSkip>Saltar</QuestionnaireSkip>}
        {submit ?? finish ? (
          <QuestionnaireSubmit
            disabled={submit ? sending : finish?.sending}
            onClick={(event) => {
              const fieldset = event.currentTarget.closest("fieldset")
              if (check && fieldset && blocked(fieldset)) event.preventDefault()
            }}
          >
            {submit ?? finish?.label}
          </QuestionnaireSubmit>
        ) : null}
        {submit ? null : (
          <QuestionnaireNext
            onClick={(event) => {
              const fieldset = event.currentTarget.closest("fieldset")
              if (fieldset && blocked(fieldset)) event.preventDefault()
            }}
          >
            Siguiente
          </QuestionnaireNext>
        )}
      </QuestionnaireActions>
    </QuestionnaireItem>
  )
}

/** Lo que recibe el control de un campo: su id, su error y, en un grupo, el id de su nombre. */
type LabeledControl = FieldControl & { labelId: string }

/**
 * Un campo con su nombre, «(opcional)» si puede quedar en blanco, su ayuda y su
 * aviso, unido al dato del formulario (`name`). Con `group`, varias opciones a
 * la vista: un `FieldSet` que se nombra con su leyenda (`labelId`).
 */
function Labeled({
  name,
  ...props
}: {
  name: keyof Draft
  label: string
  optional?: boolean
  hint?: string
  group?: boolean
  children: (control: LabeledControl) => React.ReactNode
}) {
  const form = useRegistrationFormContext()
  return <form.AppField name={name}>{() => <LabeledField name={name} {...props} />}</form.AppField>
}

function LabeledField({
  name,
  label,
  optional = false,
  hint,
  group = false,
  children,
}: {
  name: string
  label: string
  optional?: boolean
  hint?: string
  group?: boolean
  children: (control: LabeledControl) => React.ReactNode
}) {
  const { control, errors, descriptionId, errorId } = useFieldControl({ hasDescription: !!hint })
  const allOptional = useContext(AllOptionalContext)
  const labelId = `${control.id}-nombre`
  const text = (
    // Un solo bloque: en el celular «(opcional)» sigue al texto, no en otra columna.
    <span>
      {label}
      {optional && !allOptional ? (
        <span className="font-normal text-muted-foreground"> (opcional)</span>
      ) : null}
    </span>
  )
  const help = hint ? <FieldDescription id={descriptionId}>{hint}</FieldDescription> : null
  const error = control.invalid ? (
    <FieldError id={errorId} errors={errors.map((message) => ({ message }))} />
  ) : null
  if (group)
    return (
      <FieldSet data-field={name} data-invalid={control.invalid || undefined}>
        <FieldLegend id={labelId} variant="label">
          {text}
        </FieldLegend>
        {help}
        {children({ ...control, labelId })}
        {error}
      </FieldSet>
    )
  return (
    <Field data-field={name} data-invalid={control.invalid || undefined}>
      <FieldLabel id={labelId} htmlFor={control.id}>
        {text}
      </FieldLabel>
      {help}
      {children({ ...control, labelId })}
      {error}
    </Field>
  )
}

/** Un aviso suelto bajo las opciones de una pantalla (quién se registra, el aviso de privacidad). */
function FieldMessage({ name }: { name: keyof Draft }) {
  const form = useRegistrationFormContext()
  return <form.AppField name={name}>{() => <FieldMessageText />}</form.AppField>
}

function FieldMessageText() {
  const { control, errors, errorId } = useFieldControl({ hasDescription: false })
  return control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null
}

/**
 * Pocas opciones cortas, como botones; si son muchas o largas, una lista. La
 * pregunta de arriba nombra el grupo; `label` es el nombre del dato que se
 * elige («Cómo nos conoció»), el mismo que lleva la lista en la ficha.
 */
function Pick({
  control,
  label,
  value,
  options,
  onChange,
}: {
  control: LabeledControl
  label: string
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  if (options.length <= 4 && options.every((option) => option.label.length <= 20))
    return (
      <ChoiceButtons
        id={control.id}
        aria-label={label}
        aria-describedby={control.describedBy}
        invalid={control.invalid}
        onBlur={control.onBlur}
        value={value || null}
        options={options}
        onChange={onChange}
        columns={options.length as 2 | 3 | 4}
      />
    )
  return (
    <Select
      value={value || null}
      items={Object.fromEntries(options.map((option) => [option.value, option.label]))}
      onValueChange={(next) => onChange(typeof next === "string" ? next : "")}
    >
      <SelectTrigger
        id={control.id}
        aria-label={label}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid || undefined}
        onBlur={control.onBlur}
        className="w-full"
      >
        <SelectValue placeholder="Elegir…" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * «No / Sí / No sé» y, si es «Sí», cuál, en el mismo lugar. Con el Sí, `before`
 * va antes de «cuál» (la lista de enfermedades) y `children` después (qué le
 * pasó con la alergia). `detailOptional`: el Sí basta.
 */
function DeclaredField({
  name,
  optional,
  label,
  hint,
  detailLabel,
  detailOptional = false,
  state,
  text,
  onState,
  onText,
  before,
  children,
}: {
  name: keyof Draft
  optional: boolean
  label: string
  hint?: string
  detailLabel: string
  detailOptional?: boolean
  state: Declared
  text: string
  onState: (value: Declared) => void
  onText: (value: string) => void
  before?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <Labeled name={name} group label={label} hint={hint} optional={optional}>
      {(control) => (
        <>
          <ChoiceButtons
            id={control.id}
            aria-labelledby={control.labelId}
            aria-describedby={control.describedBy}
            invalid={control.invalid && !state}
            onBlur={control.onBlur}
            value={state || null}
            options={DECLARED}
            onChange={onState}
            columns={3}
          />
          {state === "recorded" ? (
            <>
              {before}
              <Input
                aria-label={detailLabel}
                aria-describedby={control.describedBy}
                placeholder={detailLabel}
                autoComplete="off"
                maxLength={600}
                value={text}
                aria-invalid={control.invalid && !detailOptional && !text.trim() ? true : undefined}
                onChange={(event) => onText(event.target.value)}
              />
              {children}
            </>
          ) : null}
        </>
      )}
    </Labeled>
  )
}

/** «No / Sí» y, si es «Sí», el detalle; todo opcional. */
function YesNoField({
  name,
  label,
  detail,
  answer,
  text,
  onAnswer,
  onText,
}: {
  name: keyof Draft
  label: string
  detail: string
  answer: YesNo
  text: string
  onAnswer: (value: YesNo) => void
  onText: (value: string) => void
}) {
  return (
    <Labeled name={name} group label={label} optional>
      {(control) => (
        <>
          <ChoiceButtons
            id={control.id}
            aria-labelledby={control.labelId}
            aria-describedby={control.describedBy}
            invalid={control.invalid}
            onBlur={control.onBlur}
            value={answer || null}
            options={YES_NO}
            onChange={onAnswer}
            columns={2}
          />
          {answer === "si" ? (
            <Input
              aria-label={detail}
              placeholder={detail}
              autoComplete="off"
              maxLength={500}
              value={text}
              onChange={(event) => onText(event.target.value)}
            />
          ) : null}
        </>
      )}
    </Labeled>
  )
}

/**
 * Una pantalla de varios campos no es una respuesta del cuestionario: esta,
 * oculta, la da por respondida. Lo que falta lo dice la propia pantalla.
 */
function Carry() {
  return <QuestionnaireInput value="ok" readOnly hidden tabIndex={-1} aria-hidden="true" />
}

/**
 * «Acepto el aviso de privacidad de…» al final de «Tus datos», para quien aún
 * no lo aceptó (registrada por teléfono, por ejemplo), con el aviso a la vista
 * al abrirlo.
 */
function PrivacyAccept({
  clinicName,
  notice,
  checked,
  onChange,
}: {
  clinicName: string | null
  notice: string
  checked: boolean
  onChange: (accepted: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const noticeId = useId()
  return (
    <Labeled name="privacy" label="Aviso de privacidad">
      {(control) => (
        <>
          <div className="flex items-start gap-3">
            <Checkbox
              id={control.id}
              className="mt-3.5"
              checked={checked}
              aria-invalid={control.invalid || undefined}
              aria-describedby={control.describedBy}
              onBlur={control.onBlur}
              onCheckedChange={(next) => onChange(next === true)}
            />
            <div className="flex min-w-0 flex-col items-start">
              <label htmlFor={control.id} className="flex min-h-11 cursor-pointer items-center text-sm">
                {clinicName ? `Acepto el aviso de privacidad de ${clinicName}.` : "Acepto el aviso de privacidad."}
              </label>
              {notice.trim() ? (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto min-h-11 p-0 text-sm"
                  aria-expanded={open}
                  aria-controls={noticeId}
                  onClick={() => setOpen((shown) => !shown)}
                >
                  {open ? "Ocultar el aviso" : "Ver el aviso de privacidad"}
                </Button>
              ) : null}
            </div>
          </div>
          {open ? (
            <ScrollArea id={noticeId} className="flex max-h-48 flex-col rounded-2xl bg-muted/60">
              <QuestionnaireDescription className="p-4 whitespace-pre-wrap">{notice}</QuestionnaireDescription>
            </ScrollArea>
          ) : null}
        </>
      )}
    </Labeled>
  )
}
