import { createOwnerDb } from "./client.js"
import { seedProcedureCodes } from "./procedure-codes.js"

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL es obligatoria para sembrar (rol owner)")

const result = await seedProcedureCodes(createOwnerDb(url))
const lists = result.releases.map((r) => `${r.systemKey} ${r.version} (${r.codes} códigos, ${r.mappings} tratamientos)`).join(", ")
console.log(`procedure coding seeded: ${result.systems} systems, ${result.codes} codes, ${result.templates} templates; ${lists}`)
process.exit(0)