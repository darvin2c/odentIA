/** Las respuestas correctas de las preguntas nuevas del dueño (`eval/argos-owner.json`), por área. */
import { budgetSolvers } from "./budgets.js"
import { dentistSolvers } from "./dentists.js"
import { financeSolvers } from "./finance.js"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"
import { inventorySolvers } from "./inventory.js"
import { marketingSolvers } from "./marketing.js"
import { patientSolvers } from "./patients.js"
import { productSolvers } from "./products.js"
import { salesSolvers } from "./sales.js"
import { strategySolvers } from "./strategy.js"
import { trendSolvers } from "./trends.js"

export function ownerSolvers(h: GoldenHelpers): GoldenSolvers {
  return {
    ...financeSolvers(h),
    ...patientSolvers(h),
    ...dentistSolvers(h),
    ...budgetSolvers(h),
    ...marketingSolvers(h),
    ...strategySolvers(h),
    ...productSolvers(h),
    ...salesSolvers(h),
    ...inventorySolvers(h),
    ...trendSolvers(h),
  }
}
