// El buscador de los códigos odontológicos de la CIE-10 (guía de la CIE-10, «Pruébalo aquí»): los de la
// lista oficial que carga la app, con lo odontológico que muestra primero su buscador
// (`isDentalDiagnosis`). Busca como el de la atención: por nombre o por código, con o sin tildes y
// mayúsculas, cada palabra en cualquier orden. Vacío, muestra los de uso diario. No guarda nada.
import { useId, useMemo, useState } from "react"
import "./demos.css"

interface Code {
  code: string
  title: string
  category: boolean
}

interface Props {
  codes: Code[]
  /** Los de uso diario, por su código: lo que se ve antes de escribir. */
  daily: string[]
}

const MAX = 12

/** Sin tildes ni mayúsculas, y el punto del código fuera: «k021» encuentra K02.1. */
const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
const codeKey = (code: string) => code.replace(/\./g, "").toLowerCase()

export default function Cie10Search({ codes, daily }: Props) {
  const [query, setQuery] = useState("")
  const id = useId()
  const indexed = useMemo(() => codes.map((item) => ({ ...item, words: plain(item.title).split(" "), key: codeKey(item.code) })), [codes])

  const terms = plain(query).split(" ").filter(Boolean)
  // Un código se busca entero, con o sin punto («K02.1», «k021»): antes de partirlo en palabras.
  const asCode = codeKey(query.trim().replace(/\s+/g, ""))
  const byCode = /^[a-z]\d/.test(asCode) ? indexed.filter((item) => item.key.startsWith(asCode)) : []
  const results = terms.length
    ? byCode.length
      ? byCode
      : indexed.filter((item) => terms.every((term) => item.key.startsWith(codeKey(term)) || item.words.some((word) => word.startsWith(term))))
    : daily.map((code) => indexed.find((item) => item.code === code)).filter((item) => item !== undefined)
  // Los de uso diario van todos; lo buscado, los primeros.
  const shown = terms.length ? results.slice(0, MAX) : results

  return (
    <div className="gx gx-cie">
      <div className="gx-card">
        <div className="gx-head">
          <b>Códigos CIE-10 de odontología</b>
          <span>Escribe el diagnóstico o el código: «necrosis», «pulpitis», «K04.1».</span>
        </div>
        <label className="gx-search" htmlFor={id}>
          <span className="sr-only">Buscar un código</span>
          <input
            id={id}
            type="search"
            value={query}
            autoComplete="off"
            placeholder="Buscar por nombre o código"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <p className="gx-count" aria-live="polite">
          {terms.length
            ? results.length
              ? `${results.length === 1 ? "1 código" : `${results.length} códigos`}${results.length > MAX ? `, los primeros ${MAX}` : ""}`
              : "Ninguno con esas palabras. Prueba con otra, o con el comienzo del código."
            : "Los de uso diario en la consulta"}
        </p>
        <ul className="gx-codes">
          {shown.map((item) => (
            <li key={item.code} className={item.category ? "cat" : ""}>
              <b>{item.code}</b>
              <span>{item.title}</span>
            </li>
          ))}
        </ul>
        <p className="gx-note">
          En odentIA, al marcar la caries en el odontograma, su código ya viene propuesto.
        </p>
      </div>
    </div>
  )
}
