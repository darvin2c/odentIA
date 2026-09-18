import { createOwnerDb } from "./client.js"
import { seedProcedureCodes } from "./procedure-codes.js"

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL es obligatoria para sembrar (rol owner)")

const result = await seedProcedureCodes(createOwnerDb(url))
console.log(
  `procedure coding seeded: ${result.systems} systems, ${result.codes} codes, ${result.templates} templates 1:1, release ${result.systemKey} ${result.version} vigente`,
)
process.exit(0)