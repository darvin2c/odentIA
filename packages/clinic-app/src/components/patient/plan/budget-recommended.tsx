/**
 * Cuál opción verá marcada el paciente como recomendada, dicha donde se arma, se
 * entrega o se le muestra el presupuesto. «Lo que le proponemos» es texto libre y
 * nada lo une a esa marca: estas frases solo informan y nunca leen la propuesta
 * para adivinar la recomendada (QA del 14 nov, Rosa: «Le recomendamos la corona»
 * con la resina marcada). Ninguna frena enviar, imprimir ni anotar.
 */
import { useQuery } from "@tanstack/react-query"
import { type BudgetWithTotals, fetchBudgetDetail } from "../../../lib/budgets"
import { usePermission } from "../../../lib/crm"

interface MarkedOption {
  id: string
  label: string
  name?: string | null
  isRecommended: boolean
}

interface OptionLine {
  optionId: string
  planItemId: string
  title: string
}

/** «Opción A · recomendada»: la misma marca del Plan. */
export function optionHeading(option: Pick<MarkedOption, "label" | "isRecommended">): string {
  return `${option.label}${option.isRecommended ? " · recomendada" : ""}`
}

/** «Opción A» dentro de una frase: «la opción A». */
export function inSentence(label: string): string {
  return `${label.charAt(0).toLowerCase()}${label.slice(1)}`
}

/**
 * Cómo se llama la opción para la persona: su nombre o, sin él, lo que solo
 * ella lleva («Corona cerámica pieza 46»); lo que va en todas no la distingue.
 */
export function optionWords(
  option: Pick<MarkedOption, "id" | "name">,
  options: ReadonlyArray<Pick<MarkedOption, "id">>,
  lines: ReadonlyArray<OptionLine> = [],
): string {
  const name = option.name?.trim()
  if (name) return name
  const inEvery = (planItemId: string) =>
    options.every((other) =>
      lines.some((line) => line.optionId === other.id && line.planItemId === planItemId),
    )
  const own = [
    ...new Set(
      lines
        .filter((line) => line.optionId === option.id && !inEvery(line.planItemId))
        .map((line) => line.title),
    ),
  ]
  if (own.length <= 1) return own[0] ?? ""
  return `${own.slice(0, -1).join(", ")} y ${own.at(-1)}`
}

/** La marca que vale: la del servidor y, mientras se guarda otra, esa. */
export function withRecommendation<T extends Pick<MarkedOption, "id" | "isRecommended">>(
  options: readonly T[],
  server: ReadonlyArray<Pick<MarkedOption, "id" | "isRecommended">> | undefined,
  pendingId: string | null = null,
): T[] {
  const recommended =
    pendingId ??
    server?.find((option) => option.isRecommended)?.id ??
    options.find((option) => option.isRecommended)?.id ??
    null
  return options.map((option) => ({ ...option, isRecommended: option.id === recommended }))
}

/**
 * - `propone`: quien arma el presupuesto y puede cambiar la marca.
 * - `envia`: quien lo envía o lo muestra sin poder cambiarla (recepción, o el de
 *   una colega): no propone, avisa a quien lo armó.
 * - `entregado`: ya le llegó; se cambia con una revisión.
 */
export type RecommendedAudience = "propone" | "envia" | "entregado"

/**
 * La frase, con varias opciones; con una sola no hay nada que elegir. `names`,
 * por etiqueta, es lo que se está escribiendo y aún no se guardó.
 */
export function recommendedNotice(
  options: ReadonlyArray<MarkedOption>,
  {
    audience = "propone",
    names = {},
    lines = [],
  }: {
    audience?: RecommendedAudience
    names?: Readonly<Record<string, string>>
    lines?: ReadonlyArray<OptionLine>
  } = {},
): string | null {
  if (options.length < 2) return null
  const recommended = options.find((option) => option.isRecommended)
  if (!recommended) return null
  const typed = names[recommended.label]
  const words = optionWords(
    { id: recommended.id, name: typed ?? recommended.name ?? null },
    options,
    lines,
  )
  const which = `la ${inSentence(recommended.label)}${words ? ` (${words})` : ""}`
  if (audience === "entregado") return `El paciente ve marcada como recomendada ${which}.`
  if (audience === "envia")
    return `El paciente verá marcada como recomendada ${which}. Si no es la que le recomendaron, avisa a quien armó el presupuesto.`
  return `El paciente verá marcada como recomendada ${which}: revisa que coincida con lo que le propones.`
}

/** Lo que se dice tras marcarla, en la región que se anuncia. */
export function recommendedSavedText(label: string): string {
  return `Guardado: recomendada la ${inSentence(label)}`
}

/** La frase para un presupuesto ya cargado (detalle del servidor). */
export function budgetRecommendedNotice(
  budget: Pick<BudgetWithTotals, "options" | "items" | "status" | "canChange">,
  canWrite: boolean,
): string | null {
  const audience: RecommendedAudience =
    budget.status !== "borrador"
      ? "entregado"
      : canWrite && budget.canChange !== false
        ? "propone"
        : "envia"
  return recommendedNotice(budget.options, { audience, lines: budget.items })
}

/**
 * Una línea, para las salidas de la atención que no pasan por «Revisar antes»
 * («Imprimir y entregar», «Anotar su respuesta», «Mostrar a…»). Lee el mismo
 * detalle del presupuesto que ya se vuelve a pedir: si otra persona cambió la
 * marca, la línea cambia con él.
 */
export function RecommendedLine({
  patientId,
  budgetId,
  className,
}: {
  patientId: string
  budgetId: string
  className?: string
}): React.JSX.Element | null {
  const canWrite = usePermission("budgets.write")
  const budget = useQuery({
    queryKey: ["budget", patientId, budgetId],
    queryFn: () => fetchBudgetDetail(patientId, budgetId),
  }).data?.data
  const text = budget ? budgetRecommendedNotice(budget, canWrite) : null
  if (!text) return null
  return <p className={className ?? "basis-full text-sm text-muted-foreground"}>{text}</p>
}
