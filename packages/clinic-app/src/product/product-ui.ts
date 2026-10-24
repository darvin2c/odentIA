import {
  type ClinicalProduct,
  CORE_VITAL_KEYS,
  DENTAL_MEDICATION_CATALOG,
  type MedicationCatalog,
  type VitalSignKey,
  type Vitals,
} from "@odentia/clinical"
import type { UseQueryResult } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type {
  DictationKind,
  DictationSession,
  DictationSuggestion,
} from "../components/patient/dictation-session"
import type { ClosingCheck } from "../lib/encounters"
import type { EncounterDetail, PatientFull, SiteFinding, TimelineItem } from "../lib/patients"

/**
 * Lo que cada producto aporta a las pantallas comunes (ADR 0079): la ficha, la
 * atención, el «dónde», la historia, los documentos y los servicios. Es lo que
 * `services/src/products.ts` hace en el servidor, del lado de la pantalla.
 *
 * Cada app es de un producto y lo declara una sola vez al arrancar
 * (`declareProduct` en `router.tsx`); lo común le pide sus partes con
 * `productUi()`. Ninguna pantalla común importa lo de un producto: lo fija
 * `packages/dental/src/boundaries.test.ts`.
 */
export interface ProductUi {
  product: ClinicalProduct
  /** La página de la persona: las secciones que el producto agrega a Clínica. */
  record: ProductRecord
  /** El «dónde» de lo clínico; null si el producto no lo registra aparte (se escribe en el texto). */
  site: ProductSiteUi | null
  /**
   * Los hallazgos vigentes de la persona, cada uno en su lugar (odentIA: los del
   * odontograma, sin los anulados): lo que motiva una indicación. Es un hook;
   * sin «dónde», ninguno.
   */
  useFindings(patientId: string, enabled: boolean): SiteFinding[]
  /** Clío en la atención; null si el producto aún no dicta. */
  dictation: ProductDictationUi | null
  /** Lo que el país de la clínica pide del producto (odentIA: su odontograma, sus especialidades y el título). */
  country: ProductCountryUi
  /** El plan de tratamiento: sus fases, en orden (odentIA: de la urgencia al mantenimiento). */
  plan: { phases: readonly ProductPlanPhase[]; defaultPhase: string }
  /** Servicios: lo que el producto agrega al servicio y a su biblioteca. */
  services: ProductServicesUi
  /** La historia: los hechos propios del producto y lo que firmó con una atención. */
  history: ProductHistoryUi
  /** Documentos: los papeles propios del producto. */
  documents: ProductDocumentsUi
  /** La atención: sus bloques en borrador, lo que dice el cierre y lo que se ve al leerla. */
  encounter: ProductEncounterUi
  /** Antecedentes: lo del producto en la «Entrevista de salud». */
  health: ProductHealthUi
  /** El resumen de la persona: lo del producto junto a las alertas clínicas. */
  summary: ProductSummaryUi
  /** La receta: su lista y lo que revisa además de las alergias. */
  prescribing: ProductPrescribingUi
}

/**
 * La receta del producto (issue 229, decisión 12). Lo mismo que
 * `ProductPrescribing` en el servidor, que vuelve a revisarlo al emitir.
 */
export interface ProductPrescribingUi {
  /** Lo que receta, las alergias que se eligen y la medicación habitual que se sugiere. */
  catalog: MedicationCatalog
  /**
   * Sus reglas para esta persona (latidIA: controlados, embarazo y lactancia,
   * el peso de un niño). Es un hook: lee lo que necesita de la persona.
   */
  useRules(patientId: string, enabled: boolean): PrescribingRulesUi
}

export interface PrescribingRulesUi {
  /** Lo que impide emitir, lo que va con motivo (como una alergia) y lo que solo se recuerda. */
  check(
    items: ReadonlyArray<{ genericName: string }>,
    weightKg: number | null,
  ): { errors: string[]; warnings: string[]; reminders: string[] }
  /** Si la receta lleva el peso y el último que se registró, para proponerlo. */
  weight: { required: boolean; suggested: number | null }
}

/**
 * Lo del producto en Antecedentes (odentIA: «Odontológicos y hábitos»;
 * latidIA: embarazo y lactancia con fecha, gineco-obstétricos, hábitos y
 * vacunas, issue 229). Las claves son las de su entrevista (`ProductInterview`).
 */
export interface ProductHealthUi {
  /** «Personales» pregunta el embarazo (odentIA); latidIA lo pregunta en su sección, con fecha y lactancia. */
  asksPregnancy: boolean
  /** Sus secciones de la entrevista, después de «Familiares». */
  InterviewSections(props: InterviewSectionsProps): ReactNode
  /** Lo suyo, ya guardado, debajo del resumen de antecedentes; null si nada. */
  Summary(props: { answers: Record<string, unknown> }): ReactNode
}

export interface InterviewSectionsProps {
  /** La entrevista como se está editando. */
  answers: Record<string, unknown>
  /** Cambia un dato de un grupo; `undefined` lo quita (y el grupo, si queda vacío). */
  update(group: string, key: string, value: unknown): void
  /** Reemplaza un grupo entero (una lista, como las vacunas); `undefined` lo quita. */
  setGroup(key: string, value: unknown): void
  disabled: boolean
  /** Prefijo único para los `id` de los campos. */
  idPrefix: string
  /** El sexo de la ficha: lo gineco-obstétrico no se le pregunta a un hombre. */
  sex: string | null
}

export interface ProductSummaryUi {
  /** Sus tarjetas en el resumen clínico, junto a las alertas (latidIA: la lista de problemas). */
  ClinicalCards(props: { patientId: string; onSection: (section: string) => void }): ReactNode
}

export interface ProductEncounterUi {
  /** El examen físico: su bloque en el borrador y lo que se lee de él. */
  examination: ProductExaminationUi
  /**
   * Los bloques del producto en la atención en borrador, después del examen
   * (odentIA: Odontograma y Periodontograma). Es un hook: lo llama el editor.
   */
  useBlocks(ctx: EncounterBlockContext): ProductEncounterBlocks
  /** Lo que el cierre dice del producto (odentIA: el odontograma que se firma y el periodontograma). */
  Closing(props: {
    closing: ClosingCheck
    pending: boolean
    openBlock: (key: string) => void
  }): ReactNode
  /** El botón de firmar cuando el producto lo matiza (odentIA: «Firmar como parcial»); null: el de siempre. */
  signLabel(closing: ClosingCheck | null): string | null
  /**
   * Lo del producto al leer la atención (odentIA: el odontograma vinculado, con
   * lo registrado, y el periodontograma, al final).
   */
  Detail(props: { patientId: string; detail: EncounterDetail; slot: "recorded" | "end" }): ReactNode
}

/**
 * El examen físico de la atención (`encounter.examination`), con la forma del
 * producto (odentIA: la boca; latidIA: por sistemas, issue 229). Los signos
 * vitales son comunes: el producto dice cuáles registra y qué va debajo.
 */
export interface ProductExaminationUi {
  /** El nombre del bloque («Examen clínico», «Examen físico») y para qué es. */
  title: string
  description: string
  /** Los signos vitales que registra, en su orden. */
  vitals: readonly VitalSignKey[]
  /** Lo guardado → el borrador que se edita; null si no hay nada. */
  draft(saved: unknown): unknown
  /** El borrador → lo que se guarda; null si quedó vacío. */
  body(draft: unknown): Record<string, unknown> | null
  /** El resumen del bloque («Examen registrado»); vacío si no hay examen. */
  summary(draft: unknown): string
  /** Los campos del examen, debajo de los signos vitales. */
  Fields(props: ExaminationFieldsProps): ReactNode
  /** Debajo de los signos vitales (latidIA: el IMC y la medición anterior). */
  VitalsNote(props: { patientId: string; encounterId: string; vitals: Vitals | null }): ReactNode
  /** Lo guardado, al leer la atención: una línea por parte; vacío si no se muestra. */
  readLines(saved: unknown): string[]
}

export interface ExaminationFieldsProps {
  /** Prefijo único para los `id` de los campos. */
  idPrefix: string
  draft: unknown
  onChange(next: unknown): void
  disabled: boolean
}

/** Lo que el editor de la atención le da a los bloques del producto. */
export interface EncounterBlockContext {
  patientId: string
  encounterId: string
  detail: EncounterDetail
  birthDate: string | null | undefined
  canRead: boolean
  canWrite: boolean
  /** Otro bloque guarda, o la atención se firma o se anula: no se escribe. */
  locked: boolean
  /** Quien atiende puede escribir ahora, aunque otro bloque esté guardando. */
  writable: boolean
  /** Guarda lo pendiente de la atención antes de escribir en el bloque. */
  flush: () => Promise<void>
  /** El bloque cambió algo: la atención vuelve a pedir su detalle. */
  onChanged: () => Promise<void>
  /** El bloque está guardando (o terminó). */
  onPendingChange: (pending: boolean) => void
}

export interface ProductEncounterBlocks {
  blocks: ProductEncounterBlock[]
  /** Lo que el producto monta sobre la atención (odentIA: la captura del periodontograma a pantalla completa). */
  overlay: ReactNode
}

export interface ProductEncounterBlock {
  key: string
  title: string
  description: string
  summary: string
  /** No hay nada registrado: el bloque no se muestra salvo que se agregue. */
  empty: boolean
  content: ReactNode
  /** Las sugerencias del dictado que se revisan en el bloque, y su resumen si solo hay sugerencias. */
  dictation?: { kinds: DictationKind[]; onlySuggested?: string }
}

export interface ProductDocumentsUi {
  /** Su tipo de papel (odentIA: «Odontogramas»): el filtro y cómo se cuenta («1 odontograma»). */
  kind: { filter: string; label: string; nouns: readonly [one: string, many: string] } | null
  /** Sus papeles de la persona, ya armados (odentIA: los odontogramas firmados, solo en Perú). Es un hook. */
  usePapers(patientId: string): ProductPapers
}

export interface ProductPapers {
  /** Su consulta, o null si la clínica no tiene esta clase de papel: la lista dice si carga o falló. */
  query: UseQueryResult<unknown> | null
  /** Su clave, para volver a pedirla después de un cambio. */
  queryKey: readonly unknown[]
  papers: ProductPaper[]
}

export interface ProductPaper {
  key: string
  title: string
  /** La segunda línea: fecha y lo que dice del papel. */
  detail: string
  date: string
  /** Su única acción (odentIA: «Imprimir» su hoja). */
  action: ReactNode
}

export interface ProductHistoryUi {
  /** Si un hecho de la historia es del producto (odentIA: el odontograma firmado). */
  owns(type: string): boolean
  /** Un hecho propio del producto, en su tarjeta. */
  Item(props: { item: TimelineItem; patientId: string }): ReactNode
  /** Lo que el producto firmó con una atención (odentIA: su odontograma), donde se ve la atención. */
  EncounterSigned(props: { patientId: string; encounterId: string }): ReactNode
}

export interface ProductServicesUi {
  /** Los tipos de tratamiento de la biblioteca, para filtrarla (ADR 0069). */
  kinds: ReadonlyArray<{ key: string; name: string }>
  /** Lo que deja el servicio al completarse (odentIA: «Deja en la pieza»); null si el producto no lo registra. */
  leaves: ProductLeavesUi | null
}

export interface ProductLeavesUi {
  label: string
  /** Lo que se elige en el servicio; no aparece si el ámbito del servicio no deja nada. */
  Field(props: {
    idPrefix: string
    scope: string | null | undefined
    condition: string
    variant: string
    onChange: (condition: string, variant: string) => void
    disabled?: boolean
  }): ReactNode
  /** Lo que viaja al servidor: el hallazgo y su variante, o null. */
  body(condition: string, variant: string): { condition: string; variant?: string } | null
  /** Lo que deja, en palabras («Corona · Metal-cerámica»). */
  words(finding: { condition: string; variant?: string | null }): string
}

export interface ProductPlanPhase {
  key: string
  label: string
  /** Para qué es, en una frase corta («Dolor, infección, trauma»). */
  hint: string
}

export interface ProductCountryUi {
  /** De dónde salen las especialidades con que nace la clínica en ese país. */
  specialtiesNorm(country: string): string
  /** Las filas del producto en «Normas de tu país», después de los diagnósticos. */
  normRows(country: string): ReadonlyArray<readonly [label: string, value: string]>
  /** Título y colegio que se proponen al completar el perfil profesional; null si el país no los dice. */
  professional(
    country: string | null | undefined,
  ): { title: string; registrationBody: string } | null
}

export interface ProductDictationUi {
  /**
   * Debajo de una sugerencia que aún no se puede confirmar (odentIA: lo que la
   * norma del país pide de un hallazgo dictado y no se dijo, con un toque).
   */
  SuggestionChoices(props: {
    session: DictationSession
    item: DictationSuggestion
    busy: boolean
  }): ReactNode
}

/** Una sección de Clínica que aporta el producto (odentIA: Odontograma y Periodontograma). */
export interface ProductRecordSection {
  id: string
  label: string
  /** Va debajo de otra sección del producto: no suma una pestaña, se elige dentro de ella. */
  parent?: string
  /** Necesita la ficha cargada: la página la pide antes de mostrarla. */
  needsRecord?: boolean
  render(props: RecordSectionProps): ReactNode
}

export interface RecordSectionProps {
  patientId: string
  /** La ficha, ya cargada si la sección la necesita (`needsRecord`). */
  record: PatientFull | null
  /** El lugar elegido en la dirección (`?tooth=`), si lo hay. */
  place: number | undefined
  /** Lo que la dirección dice que hay que abrir dentro de la sección (`?periodontograma=`). */
  opened: string | undefined
  /** Abre otra sección de la página; con un lugar o un tratamiento si vienen al caso. */
  openSection(section: string, options?: { place?: number; itemId?: string }): void
}

export interface ProductRecord {
  /** Van en Clínica después de Antecedentes, en este orden. */
  sections: readonly ProductRecordSection[]
}

/**
 * El «dónde» de lo clínico en la pantalla (odentIA: la pieza en FDI y sus
 * caras). La API todavía lo dice como pieza y caras (`toothNumber`,
 * `surfaces`), así que los valores son esos.
 */
export interface ProductSiteUi {
  /** Cómo se llama un lugar («Pieza»), varios («Piezas») y todos («Todas las piezas»). */
  placeLabel: string
  placesLabel: string
  allPlacesLabel: string
  /** Los lugares que se eligen en un filtro, por grupo («Permanentes», «Temporales»). */
  placeGroups: ReadonlyArray<{ label: string; places: readonly number[] }>
  /** Si un número es un lugar válido (un enlace con `?tooth=`). */
  isPlace(value: number): boolean
  /** El nombre de un lugar en una lista («Pieza 16»). */
  placeName(place: number): string
  /** Elegir uno o varios lugares (documentos, imágenes, el plan). */
  PlacesPicker(props: PlacesPickerProps): ReactNode
  /** Elegir un lugar y sus partes (el diagnóstico y el procedimiento). */
  SitePicker(props: SitePickerProps): ReactNode
  /** Las partes que admite un lugar (odentIA: las caras de la pieza). */
  partsOf(place: number): readonly string[]
  /** El nombre de una parte («Oclusal»). */
  partName(part: string): string
  /** El nombre de un hallazgo registrado en un lugar («Caries»). */
  findingName(condition: string): string
}

export interface PlacesPickerProps {
  value: number[]
  onChange: (value: number[]) => void
  disabled?: boolean
  label?: string
  /** Uno solo. */
  single?: boolean
}

/** Un lugar con sus partes, como lo pide la API. */
export interface PlaceWithParts {
  toothNumber: number | null
  surfaces: string[]
}

export interface SitePickerProps {
  value: PlaceWithParts
  onChange: (value: PlaceWithParts) => void
  withSurfaces?: boolean
  disabled?: boolean
  label?: string
  optional?: boolean
  surfacesRequired?: boolean
}

const NO_FINDINGS: SiteFinding[] = []
const NO_PAPERS: ProductPapers = { query: null, queryKey: [], papers: [] }
const NO_BLOCKS: ProductEncounterBlocks = { blocks: [], overlay: null }
const NO_RULES: PrescribingRulesUi = {
  check: () => ({ errors: [], warnings: [], reminders: [] }),
  weight: { required: false, suggested: null },
}

/**
 * Un producto sin partes propias, como `NO_PRODUCT_HOOKS` en el servidor: sin
 * secciones ni «dónde», sin dictado y con una sola fase. Es el punto de
 * partida de una app nueva y lo que usan las pruebas de lo común.
 */
export function bareProduct(product: ClinicalProduct): ProductUi {
  return {
    product,
    record: { sections: [] },
    site: null,
    useFindings: () => NO_FINDINGS,
    dictation: null,
    country: {
      specialtiesNorm: () => "Lista general",
      normRows: () => [],
      professional: () => null,
    },
    plan: {
      phases: [{ key: "general", label: "General", hint: "Lo indicado" }],
      defaultPhase: "general",
    },
    services: { kinds: [], leaves: null },
    history: { owns: () => false, Item: () => null, EncounterSigned: () => null },
    documents: { kind: null, usePapers: () => NO_PAPERS },
    health: { asksPregnancy: true, InterviewSections: () => null, Summary: () => null },
    summary: { ClinicalCards: () => null },
    prescribing: { catalog: DENTAL_MEDICATION_CATALOG, useRules: () => NO_RULES },
    encounter: {
      examination: {
        title: "Examen clínico",
        description: "Signos vitales.",
        vitals: CORE_VITAL_KEYS,
        draft: () => null,
        body: () => null,
        summary: () => "",
        Fields: () => null,
        VitalsNote: () => null,
        readLines: () => [],
      },
      useBlocks: () => NO_BLOCKS,
      Closing: () => null,
      signLabel: () => null,
      Detail: () => null,
    },
  }
}

let declared: ProductUi | null = null

/** La app dice de qué producto es: una vez, al arrancar. */
export function declareProduct(ui: ProductUi): void {
  declared = ui
}

/** Las partes del producto de esta app. */
export function productUi(): ProductUi {
  if (!declared)
    throw new Error("La app no declaró su producto: falta declareProduct en router.tsx")
  return declared
}
