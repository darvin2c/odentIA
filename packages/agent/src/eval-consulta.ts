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
  const check = (field: Field, label: string, ok: boolean) => {
    // Sin nota, nada de la consulta salió bien: ni lo que debía estar ni lo que debía faltar.
    const passed = got.hasNote && ok
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
