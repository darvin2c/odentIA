/**
 * Lo que toma y cambia una exodoncia, en su fila, donde se indica y en el Plan (QA final de
 * formularios, Y2): «Toma warfarina 5 mg (lo dijo ella el 14 nov): pide su INR del día». Lo dice el
 * servidor (`extractionRisksOf`); no frena nada. También en la opción «por decidir»: es al elegir
 * entre conservar y extraer cuando más hace falta (QA del 20 nov).
 */
export function ExtractionRisks({
  lines,
  className = "basis-full",
}: {
  lines: readonly string[] | undefined
  className?: string
}): React.JSX.Element | null {
  if (!lines?.length) return null
  return (
    <ul aria-label="Antes de la exodoncia" className={`${className} rounded-md bg-warning-soft px-3 py-2 text-xs text-warning`}>
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  )
}
