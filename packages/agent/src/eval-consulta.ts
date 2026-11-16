import { BUNDLED_DIAGNOSIS_LISTS, readDiagnosisList } from "@odentia/db"
import { diagnosisClash, diagnosisSearchWords, diagnosisSibling } from "@odentia/services"

/**
 * Lo que se espera de la consulta en un dictado de práctica, campo por campo, para
 * las mediciones de los dos productos (`eval:dictado` y `eval:dictado-medico`).
 * Saber que salió «una nota» no dice si el motivo, el tiempo y el relato quedaron
 * en su lugar: esto lo cuenta por palabras, sin juez. Cada palabra admite variantes
 * separadas por «|» («tres|3»): basta con una, y se busca desde el inicio de una
 * palabra («3» no vale dentro de «13»; «blanque» sí vale en «blanqueamiento»).
 */
export interface ExpectedConsulta {
  /** Palabras que debe tener el motivo de consulta. */
  motivo?: string[]
  /** Palabras que no deben estar en el motivo (el tiempo, la pieza, lo examinado). */
  motivoSin?: string[]
  /** Una palabra del tiempo de enfermedad, o null si no se dijo y debe quedar vacío. */
  tiempo?: string | null
  /** Lo que no es tiempo de enfermedad: el plazo de un control o de un evento («seis meses», «la boda»). */
  tiempoSin?: string[]
  /** Palabras que debe tener el relato. */
  relato?: string[]
  /**
   * Lo que no debe estar en el relato: lo que se le dijo al paciente o lo que lloró mientras lo
   * atendían (prueba con voz del 15 nov). Sin relato, no está: cuenta como bien.
   */
  relatoSin?: string[]
}

type Field = "motivo" | "tiempo" | "relato"

/** Lo que salió bien de cada campo en toda la medición, para el resumen. */
const totals: Record<Field, { bien: number; total: number }> = {
  motivo: { bien: 0, total: 0 },
  tiempo: { bien: 0, total: 0 },
  relato: { bien: 0, total: 0 },
}

const plain = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Un código de diagnóstico esperado, con sus variantes («K04.6|K04.7»): basta con que uno de los propuestos empiece con una. */
export const diagnosisProposed = (expected: string, codes: readonly string[]) =>
  expected.split("|").some((one) => codes.some((code) => code.toUpperCase().startsWith(one.toUpperCase())))

/** La CIE-10 del MINSA que trae el repositorio, por código: la lista con que se miden los diagnósticos. */
let icd10: Array<{ code: string; title: string; isCategory: boolean }> | null = null
function diagnosisList() {
  if (!icd10) {
    const load = BUNDLED_DIAGNOSIS_LISTS.find((item) => item.system === "ICD-10-PE")
    if (!load) throw new Error("Falta la CIE-10 del MINSA en el repositorio")
    icd10 = readDiagnosisList(load).rows.map((row) => ({ code: row.code, title: row.title, isCategory: row.isCategory }))
  }
  return icd10
}

/**
 * Los diagnósticos que propuso Clío como los deja el servidor (`prepare` de los servicios, con la
 * lista de la clínica; aquí, la CIE-10 del MINSA): el que contradice lo dictado pasa al hermano que
 * calza y queda por revisar (`diagnosisClash`, `diagnosisSibling`, con los mismos candidatos que busca
 * `diagnosisCodesWith`). `said`: lo demás dictado, de lo más cerca a lo más lejos.
 */
export function serverDiagnoses(drafts: ReadonlyArray<{ kind: string; payload: Record<string, unknown>; sourceText?: string | undefined }>, said: readonly string[]): Array<{ code: string; ready: boolean }> {
  const list = diagnosisList()
  return drafts
    .filter((draft) => draft.kind === "diagnostico")
    .map((draft) => {
      const code = String(draft.payload["diagnosisCode"] ?? "").trim().toUpperCase()
      const known = list.find((row) => row.code === code)
      const clash = known && !known.isCategory ? diagnosisClash(known.title, draft.sourceText ?? "", said) : null
      if (!known || !clash) return { code, ready: true }
      const words = diagnosisSearchWords(known.title, clash)
      const candidates = list.filter((row) => words.every((word) => plain(`${row.code} ${row.title}`).includes(word))).slice(0, 40)
      return { code: diagnosisSibling(known, clash, candidates)?.code ?? code, ready: false }
    })
}

/** Si el texto tiene alguna de las variantes, empezando donde empieza una palabra. */
const has = (text: string, word: string) =>
  word.split("|").some((variant) => new RegExp(`(^|[^a-z0-9])${escape(plain(variant))}`).test(text))

/** Une los campos de todas las notas del dictado: el modelo puede partirla en varias. */
function consultaOf(drafts: Array<{ kind: string; payload: Record<string, unknown> }>) {
  const notes = drafts.filter((draft) => draft.kind === "nota")
  const join = (key: string) => plain(notes.map((draft) => String(draft.payload[key] ?? "")).join(" "))
  return { hasNote: notes.length > 0, motivo: join("reason"), tiempo: join("illnessDuration"), relato: join("presentIllness") }
}

/** Cuenta cada expectativa de la consulta con `other` (etiqueta, si salió bien) y en el total de su campo. */
export function scoreConsulta(
  expected: ExpectedConsulta | undefined,
  drafts: Array<{ kind: string; payload: Record<string, unknown> }>,
  other: (label: string, ok: boolean) => void,
): void {
  if (!expected) return
  const got = consultaOf(drafts)
  const check = (field: Field, label: string, ok: boolean, withoutNote = false) => {
    // Sin nota, nada de la consulta salió bien: ni lo que debía estar ni lo que debía faltar. Lo que no
    // debía ir en el relato (`withoutNote`) sí: sin relato, no está.
    const passed = (got.hasNote || withoutNote) && ok
    totals[field].total += 1
    if (passed) totals[field].bien += 1
    other(label, passed)
  }
  for (const word of expected.motivo ?? []) check("motivo", `motivo con «${word}»`, has(got.motivo, word))
  for (const word of expected.motivoSin ?? []) check("motivo", `motivo sin «${word}»`, !has(got.motivo, word))
  if (expected.tiempo === null) check("tiempo", "tiempo vacío", got.tiempo === "")
  else {
    if (expected.tiempo !== undefined) check("tiempo", `tiempo con «${expected.tiempo}»`, has(got.tiempo, expected.tiempo))
    // Con el tiempo vacío ya se cuenta arriba; aquí, solo que lo escrito no sea un plazo.
    for (const word of expected.tiempoSin ?? []) check("tiempo", `tiempo sin «${word}»`, !has(got.tiempo, word))
  }
  for (const word of expected.relato ?? []) check("relato", `relato con «${word}»`, has(got.relato, word))
  for (const word of expected.relatoSin ?? []) check("relato", `relato sin «${word}»`, !has(got.relato, word), true)
}

/** El resumen por campo, para imprimir al final de la medición; vacío si ningún dictado lo midió. */
export function consultaSummary(): string {
  const parts = (Object.keys(totals) as Field[])
    .filter((field) => totals[field].total > 0)
    .map((field) => {
      const { bien, total } = totals[field]
      return `${field} ${bien} de ${total} (${Math.round((100 * bien) / total)} %)`
    })
  return parts.length ? `Consulta, por campo: ${parts.join(" · ")}` : ""
}
