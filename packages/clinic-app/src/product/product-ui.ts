import {
  type ClinicalProduct,
  CORE_VITAL_KEYS,
  DENTAL_IMAGING_TYPES,
  DENTAL_MEDICATION_CATALOG,
  type ImagingType,
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
import type { PatientAreaId } from "../lib/patient-areas"
import type { EncounterDetail, PatientFull, SiteFinding, TimelineItem } from "../lib/patients"
import type { ServiceToothAnatomy, ToothAnatomySibling } from "../lib/services"

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
  /**
   * El plan de tratamiento: sus fases, en orden (odentIA: de la urgencia al
   * mantenimiento), y si lo indicado espera un presupuesto. Sin él (latidIA,
   * decisión 15 del issue 229) queda aceptado al indicarlo y el presupuesto es
   * opcional; es el `budgetRequired` del servidor, que lo vuelve a decidir.
   */
  plan: {
    phases: readonly ProductPlanPhase[]
    defaultPhase: string
    budgetRequired: boolean
    /** Si un control puede repetirse cada 1, 3, 6 o 12 meses (latidIA, decisión 16). */
    repeatingControls: boolean
  }
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
  /**
   * Los pedidos al taller o al laboratorio (ADR 0171; vistIA: los lentes). Sin
   * ellos, la clínica no vende con pedido: «Pedidos» no está en el menú.
   */
  orders?: ProductOrdersUi
}

/** Lo que puede llevar un pedido: los mismos tipos que el servidor (`JOB_ORDER_LINE_KINDS`). */
export type OrderLineKind = "montura" | "lunas" | "contacto" | "otro"

/** Cómo vende el producto con pedido: sus palabras, lo que lleva y lo que se mide. */
export interface ProductOrdersUi {
  /** La acción de vender (vistIA: «Vender lentes»): el botón de la página y el título del cajón. */
  sellLabel: string
  /**
   * Lo que se agrega a una venta, en el orden en que se ofrece. `fromInventory`:
   * se busca entre lo que se vende y toma su nombre y su precio; si no, se
   * escribe qué es y su precio.
   */
  lineKinds: ReadonlyArray<{ kind: OrderLineKind; label: string; fromInventory: boolean }>
  /** Las medidas para montar (vistIA: la altura de cada ojo), opcionales, cada una en su unidad. */
  fitting: ReadonlyArray<{ key: string; label: string; unit: string }>
  /** Un ejemplo de qué es el pedido y de quién lo hace, para sus campos. */
  titlePlaceholder: string
  makerPlaceholder: string
  /** Cómo se llama lo que se copia en el pedido (vistIA: «Receta»). */
  referenceLabel: string
  /** La copia guardada en el pedido, en líneas para leerla (vistIA: un ojo por línea); sin él, no se muestra. */
  prescriptionLines?(snapshot: Record<string, unknown>): string[]
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
  /** Lo que impide emitir, lo que se avisa como una alergia (ADR 0143) y lo que solo se recuerda. */
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
  /**
   * La clasificación ASA (riesgo anestésico) se pide en la atención: odentIA
   * anestesia en el sillón; en latidIA la consulta no suele anestesiar y la ASA
   * solo se ve si alguien la clasificó.
   */
  showsAsa: boolean
  /** Sus secciones de la entrevista, después de «Familiares». */
  InterviewSections(props: InterviewSectionsProps): ReactNode
  /**
   * Lo suyo de la entrevista que no pasa, antes de guardar, con las mismas
   * reglas que el servidor: «grupo.clave» → qué corregir (las claves de
   * `InterviewSectionsProps.errors`). Vacío si todo está bien. `today`: el día
   * de la clínica (YYYY-MM-DD).
   */
  validate(answers: Record<string, unknown>, today: string): SubFieldErrors
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
  /**
   * El error de cada dato, junto a él: la clave es «grupo.clave» de la
   * entrevista («habitos.tabaco», «antecedentesOdontologicos.ultimaVisita»;
   * en una lista, con su lugar: «vacunas.0.vacuna»). Cada sección lo pinta bajo
   * su campo, con `aria-invalid` y `aria-describedby` en el control.
   */
  errors?: SubFieldErrors
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
  /** El borrador con una parte del examen que dictó Clío y se confirmó (latidIA: un sistema); sin él no se dicta. */
  withDictated?(draft: unknown, payload: Record<string, unknown>): unknown
}

export interface ExaminationFieldsProps {
  /** Prefijo único para los `id` de los campos. */
  idPrefix: string
  draft: unknown
  onChange(next: unknown): void
  disabled: boolean
  /**
   * El error de cada dato del examen, junto a él: la clave es su ruta en lo que
   * se guarda (`body`), como la señala el servidor («extraoral.atm»,
   * «higieneOral», «sistemas.respiratorio» para el estado de un sistema,
   * «sistemas.respiratorio.hallazgo»). Cada campo lo pinta
   * debajo, con `aria-invalid` y `aria-describedby` en su control.
   */
  errors?: SubFieldErrors
}

/** Los errores de un bloque con varios datos, por la ruta de cada uno. */
export type SubFieldErrors = Partial<Record<string, string>>

/**
 * Lo que necesita un dato de un bloque para mostrar su error: `invalid` y
 * `describedBy` para su control, `data-invalid` del `Field` y el `FieldError`
 * con `errorId` y `message`. Sin error, todo queda en `undefined`.
 */
export interface SubFieldError {
  message: string | undefined
  errorId: string
  invalid: true | undefined
  describedBy: string | undefined
}

export function subFieldError(errors: SubFieldErrors | undefined, key: string, controlId: string): SubFieldError {
  const message = errors?.[key]
  const errorId = `${controlId}-error`
  return {
    message,
    errorId,
    invalid: message ? true : undefined,
    describedBy: message ? errorId : undefined,
  }
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
  /**
   * Los tipos de imagen que se suben y, si cambia, cómo se nombra cada categoría (latidIA: «Imagen
   * diagnóstica»). `tomography`: con qué tipo de imagen guarda la tomografía como estudio (el mismo
   * que el servidor) y cómo la abre su visor: «cbct», la dental, con panorámica, arco y piezas y
   * los brillos de cada estudio; «ct», la médica, en cortes y con las ventanas en unidades
   * Hounsfield (ADR 0154). null: no la guarda.
   */
  imaging: {
    types: readonly ImagingType[]
    categoryLabels: Readonly<Record<string, string>>
    tomography: { imageType: string; kind: "cbct" | "ct" } | null
  }
  /** Si emite descansos médicos (latidIA, decisión 8 del issue 229): «Nuevo», su filtro y su fila. */
  medicalLeave: boolean
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
  /**
   * El aviso cuando un servicio es para otro grupo de piezas (odentIA: la
   * endodoncia anterior en la 46), con el hermano que encaja; null si el
   * producto no tiene anatomía.
   */
  toothFit: ProductToothFitUi | null
}

export interface ProductToothFitUi {
  /**
   * Avisa, sin frenar, si el servicio no es para ese lugar; si encaja o no
   * tiene anatomía no pinta nada. Con `onUse`, ofrece el hermano que encaja.
   */
  Notice(props: ToothFitNoticeProps): ReactNode
}

export interface ToothFitNoticeProps {
  service: { name: string; toothAnatomy?: ServiceToothAnatomy | null }
  place: number
  /** Cambiar al hermano que encaja; sin él solo se avisa. */
  onUse?: (sibling: ToothAnatomySibling) => void
  pending?: boolean
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
    /** El error de cada dato (el hallazgo y su variante), dicho junto a su selector. */
    errors?: { condition?: string | null; variant?: string | null }
    /** Al salir de cualquiera de los dos selectores. */
    onBlur?: () => void
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
  SuggestionChoices?(props: {
    session: DictationSession
    item: DictationSuggestion
    busy: boolean
  }): ReactNode
  /** Qué se puede dictar, con una frase de ejemplo por bloque (issue 109). */
  examples: ReadonlyArray<{ block: string; say: string }>
  /** Un trozo de dictado de ejemplo, para el cuadro donde se escribe o se pega. */
  placeholder: string
  /** Un dictado de ejemplo completo, para practicar en la página de Clío. */
  practice: string
  /** Cómo se corrige de viva voz: cambiar la última sugerencia y quitar una. */
  corrections: { change: string; remove: string }
}

/** Una sección de la página que aporta el producto (odentIA: Odontograma y Periodontograma). */
export interface ProductRecordSection {
  id: string
  label: string
  /**
   * La pestaña donde va y quién la ve. Sin ellos es clínica: en Clínica, después
   * de Antecedentes, para quien lee la historia. Otra pestaña (vistIA: sus
   * pedidos, en Cobros) la pone al final de las suyas.
   */
  area?: PatientAreaId
  permission?: string | readonly string[]
  /** Va debajo de otra sección del producto: no suma una pestaña, se elige dentro de ella. */
  parent?: string
  /** Necesita la ficha cargada: la página la pide antes de mostrarla. */
  needsRecord?: boolean
  /** Su esqueleto de carga: se ve mientras llega la página o la ficha. Sin él, un bloque genérico. */
  skeleton?: ReactNode
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
  /** El lugar como lo lee quien firma un consentimiento («pieza 38 (tercer molar inferior izquierdo, muela del juicio)»). */
  placeForPatient(place: number): string
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

/**
 * Elegir lugares es un control compuesto: no pinta su etiqueta, su ayuda ni su
 * error; la pantalla lo nombra (`FieldSet` + `FieldLegend` o `field.Group`).
 */
export interface PlacesPickerProps {
  value: number[]
  onChange: (value: number[]) => void
  disabled?: boolean
  /** Uno solo. */
  single?: boolean
  /** Va al control que se escribe (el número del lugar), para `FieldLabel htmlFor`; los ids internos salen de él. */
  id?: string
  /** `aria-invalid` en el grupo y en el control que se escribe. */
  invalid?: boolean
  /** La ayuda y el error de la pantalla; se une a las pistas internas. */
  "aria-describedby"?: string
  /** Nombre del grupo cuando la pantalla no lo envuelve en un `FieldSet` con leyenda. */
  "aria-label"?: string
  "aria-labelledby"?: string
  /** Al salir del grupo (no al pasar de un botón a otro dentro). */
  onBlur?: () => void
}

/** Un lugar con sus partes, como lo pide la API. */
export interface PlaceWithParts {
  toothNumber: number | null
  surfaces: string[]
}

/** Un lugar y sus partes: control compuesto, sin etiqueta propia (como `PlacesPickerProps`). */
export interface SitePickerProps {
  value: PlaceWithParts
  onChange: (value: PlaceWithParts) => void
  withSurfaces?: boolean
  disabled?: boolean
  /** Las partes son obligatorias: lo dice la etiqueta interna de las partes. */
  surfacesRequired?: boolean
  /** Va al control que se escribe (el número del lugar); los ids internos salen de él. */
  id?: string
  /**
   * Un solo dato (el lugar con sus partes): `aria-invalid` en el grupo, en el
   * control que se escribe y en cada parte, si se muestran.
   */
  invalid?: boolean
  /** La ayuda y el error de la pantalla; se une a las pistas internas. */
  "aria-describedby"?: string
  /** Nombre del grupo cuando la pantalla no lo envuelve en un `FieldSet` con leyenda. */
  "aria-label"?: string
  "aria-labelledby"?: string
  /** Al salir del grupo (no al pasar de un botón a otro dentro). */
  onBlur?: () => void
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
      budgetRequired: true,
      repeatingControls: false,
    },
    services: { kinds: [], leaves: null, toothFit: null },
    history: { owns: () => false, Item: () => null, EncounterSigned: () => null },
    documents: {
      kind: null,
      usePapers: () => NO_PAPERS,
      imaging: { types: DENTAL_IMAGING_TYPES, categoryLabels: {}, tomography: { imageType: "tomografia", kind: "cbct" } },
      medicalLeave: false,
    },
    health: { asksPregnancy: true, showsAsa: true, InterviewSections: () => null, validate: () => ({}), Summary: () => null },
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
