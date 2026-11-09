/**
 * La anatomía de un tratamiento de la biblioteca: para qué piezas es (entrega 8
 * de la atención, punto 1). Es un dato explícito de cada tratamiento
 * (`catalog.dental_template_rule`, sembrado desde `seeds/biblioteca_piezas.csv`),
 * nunca deducido de su nombre: «posterior» son los molares en una endodoncia y
 * premolares y molares en una resina.
 *
 * Los grupos siguen el tipo de pieza de ISO 3950 (`toothTypeOf`): incisivos y
 * caninos son anteriores, x4–x5 permanentes son premolares y x6–x8 molares; en
 * la dentición temporal x4–x5 son molares temporales.
 *
 * Avisa, no frena: quien indica decide. Un servicio sin tratamiento de la
 * biblioteca (propio de la clínica) no tiene anatomía y nunca avisa.
 */
import { isPrimaryTooth, isValidTooth, toothTypeOf } from "./anatomy.js"

export const TOOTH_GROUPS = ["anterior", "premolar", "molar"] as const
export type ToothGroup = (typeof TOOTH_GROUPS)[number]

export const DENTITIONS = ["permanent", "deciduous"] as const
export type Dentition = (typeof DENTITIONS)[number]

export function isToothGroup(value: unknown): value is ToothGroup {
  return typeof value === "string" && (TOOTH_GROUPS as readonly string[]).includes(value)
}

export function isDentition(value: unknown): value is Dentition {
  return typeof value === "string" && (DENTITIONS as readonly string[]).includes(value)
}

/** Para qué piezas es un tratamiento: sus grupos, su dentición (null = las dos) y su familia de hermanos. */
export interface TreatmentAnatomy {
  groups: readonly ToothGroup[]
  dentition: Dentition | null
  family: string
}

/**
 * Familias que hacen lo mismo en la otra dentición: la endodoncia de una pieza
 * permanente, en una temporal, es la pulpectomía (guía de terapia pulpar de la
 * AAPD). Solo en ese sentido: una pulpectomía en una permanente no dice si la
 * pulpa está vital o necrótica, y elegir por la persona sería inventarlo.
 */
export const DENTITION_COUNTERPART_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  "endodoncia-vital": ["pulpectomia-deciduo"],
  "endodoncia-no-vital": ["pulpectomia-deciduo"],
}

/** El grupo de una pieza FDI válida. */
export function toothGroupOf(tooth: number): ToothGroup {
  const type = toothTypeOf(tooth)
  return type === "incisor" || type === "canine" ? "anterior" : type
}

export function dentitionOf(tooth: number): Dentition {
  return isPrimaryTooth(tooth) ? "deciduous" : "permanent"
}

/** Si el tratamiento es para esa pieza; una pieza que no es FDI no se juzga. */
export function anatomyFits(
  anatomy: Pick<TreatmentAnatomy, "groups" | "dentition">,
  tooth: number,
): boolean {
  if (!isValidTooth(tooth)) return true
  if (anatomy.dentition && anatomy.dentition !== dentitionOf(tooth)) return false
  return anatomy.groups.includes(toothGroupOf(tooth))
}

/**
 * El hermano que encaja en la pieza, entre los de la misma familia que la
 * clínica tiene: el más específico (con la dentición dicha y menos grupos). Si
 * ninguno encaja, ninguno: no se ofrece otro grupo (la bicúspide no sirve en
 * un molar).
 */
export function anatomySibling<T extends Pick<TreatmentAnatomy, "groups" | "dentition">>(
  tooth: number,
  siblings: readonly T[],
): T | null {
  const fitting = siblings.filter((sibling) => anatomyFits(sibling, tooth))
  if (fitting.length === 0) return null
  const rank = (sibling: T) => (sibling.dentition ? 0 : 10) + sibling.groups.length
  return fitting.reduce((best, sibling) => (rank(sibling) < rank(best) ? sibling : best))
}

/** Lo que se dice cuando un tratamiento no es para la pieza. */
export interface ToothFitNotice<T> {
  tooth: number
  /** «La 46 es un molar y «Endodoncia anterior vital» es para dientes anteriores.» */
  message: string
  /** El hermano que encaja, si la clínica lo tiene. */
  sibling: T | null
  /** Sin hermano: «Tu lista no tiene una para molares: el consentimiento dirá «anterior».» */
  missing: string | null
}

const GROUP_PLURAL: Record<ToothGroup, string> = {
  anterior: "dientes anteriores",
  premolar: "premolares",
  molar: "molares",
}

const GROUP_SINGULAR: Record<ToothGroup, string> = {
  anterior: "un diente anterior",
  premolar: "un premolar",
  molar: "un molar",
}

/** La palabra con que la biblioteca nombra a cada grupo en sus tratamientos. */
const GROUP_NAME_WORD: Record<string, string> = {
  anterior: "anterior",
  premolar: "bicúspide",
  molar: "posterior",
  "premolar,molar": "posterior",
}

/** «dientes anteriores», «premolares y molares», «molares temporales». */
export function anatomyGroupsWords(
  anatomy: Pick<TreatmentAnatomy, "groups" | "dentition">,
  /** «permanentes» solo se dice si importa (la pieza es temporal); si no, sobra. */
  sayPermanent = true,
): string {
  const ordered = TOOTH_GROUPS.filter((group) => anatomy.groups.includes(group))
  const words = ordered.map((group) => GROUP_PLURAL[group])
  const joined =
    words.length > 1
      ? `${words.slice(0, -1).join(", ")} y ${words[words.length - 1]}`
      : (words[0] ?? "")
  if (anatomy.dentition === "deciduous") return `${joined} temporales`
  if (anatomy.dentition === "permanent" && sayPermanent) return `${joined} permanentes`
  return joined
}

/** «molares», «molares temporales»: para qué piezas sería el que falta. */
function toothPluralWords(tooth: number): string {
  const plural = GROUP_PLURAL[toothGroupOf(tooth)]
  return dentitionOf(tooth) === "deciduous" ? `${plural} temporales` : plural
}

function toothSingularWords(tooth: number): string {
  const singular = GROUP_SINGULAR[toothGroupOf(tooth)]
  return dentitionOf(tooth) === "deciduous" ? `${singular} temporal` : singular
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es")

/**
 * Si un servicio con anatomía se indica en una pieza de otro grupo, qué decir y
 * qué ofrecer; null si encaja, si no tiene anatomía (servicio propio) o si la
 * pieza no es FDI. `siblings` son los servicios activos de la clínica de la
 * misma familia, con su anatomía.
 */
export function toothFitNotice<T extends Pick<TreatmentAnatomy, "groups" | "dentition">>(
  service: { name: string; anatomy: Pick<TreatmentAnatomy, "groups" | "dentition"> | null },
  tooth: number,
  siblings: readonly T[],
): ToothFitNotice<T> | null {
  const { anatomy } = service
  if (
    !anatomy ||
    anatomy.groups.length === 0 ||
    !isValidTooth(tooth) ||
    anatomyFits(anatomy, tooth)
  )
    return null
  const message = `La ${tooth} es ${toothSingularWords(tooth)} y «${service.name}» es para ${anatomyGroupsWords(anatomy, dentitionOf(tooth) === "deciduous")}.`
  const sibling = anatomySibling(tooth, siblings)
  if (sibling) return { tooth, message, sibling, missing: null }
  // El consentimiento dice el nombre del servicio: si trae la palabra del grupo, esa; si no, el nombre.
  const key = TOOTH_GROUPS.filter((group) => anatomy.groups.includes(group)).join(",")
  const word = GROUP_NAME_WORD[key]
  const said = word && fold(service.name).includes(fold(word)) ? word : service.name
  return {
    tooth,
    message,
    sibling: null,
    missing: `Tu lista no tiene una para ${toothPluralWords(tooth)}: el consentimiento dirá «${said}».`,
  }
}
