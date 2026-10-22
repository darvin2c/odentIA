/** Las respuestas correctas de las preguntas del dueño (`eval/argos-owner.json`), por área, de las generadas (`eval/argos-generadas.json`) y de las escritas a ciegas (`eval/argos-blind.json` y `eval/argos-blind-2.json`). */
import { blindSolvers1 } from "./blind-1.js"
import { blindSolvers2 } from "./blind-2.js"
import { blindSolvers3 } from "./blind-3.js"
import { blindSolvers4 } from "./blind-4.js"
import { budgetSolvers } from "./budgets.js"
import { dentistSolvers } from "./dentists.js"
import { financeSolvers } from "./finance.js"
import { generatedSolvers1 } from "./generated-1.js"
import { generatedSolvers2 } from "./generated-2.js"
import { generatedSolvers3 } from "./generated-3.js"
import { generatedSolvers4 } from "./generated-4.js"
import { generatedSolvers5 } from "./generated-5.js"
import { generatedSolvers6 } from "./generated-6.js"
import { generatedSolvers7 } from "./generated-7.js"
import { generatedSolvers8 } from "./generated-8.js"
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
    ...generatedSolvers1(h),
    ...generatedSolvers2(h),
    ...generatedSolvers3(h),
    ...generatedSolvers4(h),
    ...generatedSolvers5(h),
    ...generatedSolvers6(h),
    ...generatedSolvers7(h),
    ...generatedSolvers8(h),
    ...blindSolvers1(h),
    ...blindSolvers2(h),
    ...blindSolvers3(h),
    ...blindSolvers4(h),
  }
}
