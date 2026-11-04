/**
 * Lo que se espera de la consulta en un dictado de práctica, campo por campo, para
 * las mediciones de los dos productos (`eval:dictado` y `eval:dictado-medico`).
 * Saber que salió «una nota» no dice si el motivo, el tiempo y el relato quedaron
 * en su lugar: esto lo cuenta por palabras, sin juez. Cada palabra admite variantes
 * separadas por «|» («tres|3»): basta con una.
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
  /** Palabras que debe tener el relato, o null si no hay enfermedad y debe quedar vacío. */
  relato?: string[] | null
  /** Palabras que no deben estar en el relato (lo examinado, lo que se hizo). */
  relatoSin?: string[]
}

const plain = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()

/** Si el texto tiene alguna de las variantes de la palabra. */
const has = (text: string, word: string) => word.split("|").some((variant) => text.includes(plain(variant)))

/** Une los campos de todas las notas del dictado: el modelo puede partirla en varias. */
function consultaOf(drafts: Array<{ kind: string; payload: Record<string, unknown> }>) {
  const join = (key: string) =>
    plain(
      drafts
        .filter((draft) => draft.kind === "nota")
        .map((draft) => String(draft.payload[key] ?? ""))
        .join(" "),
    )
  return { motivo: join("reason"), tiempo: join("illnessDuration"), relato: join("presentIllness") }
}

/** Cuenta cada expectativa de la consulta con `other` (etiqueta, si salió bien). */
export function scoreConsulta(
  expected: ExpectedConsulta | undefined,
  drafts: Array<{ kind: string; payload: Record<string, unknown> }>,
  other: (label: string, ok: boolean) => void,
): void {
  if (!expected) return
  const got = consultaOf(drafts)
  for (const word of expected.motivo ?? []) other(`motivo con «${word}»`, has(got.motivo, word))
  for (const word of expected.motivoSin ?? []) other(`motivo sin «${word}»`, !has(got.motivo, word))
  if (expected.tiempo === null) other("tiempo vacío", got.tiempo === "")
  else if (expected.tiempo !== undefined) other(`tiempo con «${expected.tiempo}»`, has(got.tiempo, expected.tiempo))
  for (const word of expected.tiempoSin ?? []) other(`tiempo sin «${word}»`, !has(got.tiempo, word))
  if (expected.relato === null) other("relato vacío", got.relato === "")
  else for (const word of expected.relato ?? []) other(`relato con «${word}»`, has(got.relato, word))
  for (const word of expected.relatoSin ?? []) other(`relato sin «${word}»`, !has(got.relato, word))
}
