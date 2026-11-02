import { type SQL, type SQLWrapper, sql } from "drizzle-orm"

/**
 * Presupuesto que espera respuesta: una sola regla para el Resumen, la
 * coordinación de recepción, Inicio y la cuenta. Espera respuesta lo que se le
 * envió a la persona («Enviado · espera respuesta», `presentado`) y lo que «lo
 * está pensando»: respondió que lo piensa (`pospuesto`) o aceptó una parte y
 * dejó otra para después (`parcial` con alguna línea `pospuesto`). Un borrador
 * nunca cuenta: nadie se lo envió.
 *
 * La misma regla existe en código (`budgetAwaitsAnswer`) y en SQL
 * (`budgetAwaitsAnswerSql`); cambian juntas y su prueba las compara.
 */
export const BUDGET_AWAITING_STATUSES = ["presentado", "pospuesto"] as const

export function budgetAwaitsAnswer(budget: {
  status: string
  items: ReadonlyArray<{ decision: string | null }>
}): boolean {
  if ((BUDGET_AWAITING_STATUSES as readonly string[]).includes(budget.status)) return true
  return budget.status === "parcial" && budget.items.some((line) => line.decision === "pospuesto")
}

/**
 * La misma regla que `valueOptionOf` (`budgets.ts`), en SQL: la opción que vale de
 * una fila de `treatment_budget` (la elegida, si no la recomendada, si no la
 * primera). Para lo que suma presupuestos en la base (Reportes): nunca se suman
 * las opciones. Cambian juntas; su prueba las compara. Vive aquí, sin dependencias,
 * para que también la use la oportunidad.
 */
export function budgetValueOptionSql(budget: { id: SQLWrapper; organizationId: SQLWrapper }): SQL {
  return sql`(select value_option.id from treatment_budget_option value_option
    where value_option.organization_id = ${budget.organizationId} and value_option.budget_id = ${budget.id}
    order by (value_option.decision = 'elegida') desc, value_option.is_recommended desc, value_option.position
    limit 1)`
}

/**
 * La regla como condición SQL sobre una fila de `treatment_budget`. Recibe sus
 * columnas: las de la tabla (`treatmentBudget`) o las de un alias (`sql\`b.id\``).
 */
export function budgetAwaitsAnswerSql(budget: {
  id: SQLWrapper
  status: SQLWrapper
  organizationId: SQLWrapper
}): SQL {
  const statuses = sql.join(
    BUDGET_AWAITING_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )
  // Las columnas del presupuesto van fuera de la subconsulta: Drizzle las escribe
  // sin tabla en la selección de una consulta de una sola tabla, y dentro se
  // confundirían con las de la línea.
  return sql`(${budget.status} in (${statuses}) or (${budget.status} = 'parcial' and (${budget.organizationId}, ${budget.id}) in (
    select awaiting_line.organization_id, awaiting_line.budget_id from treatment_budget_item awaiting_line
    where awaiting_line.decision = 'pospuesto')))`
}
