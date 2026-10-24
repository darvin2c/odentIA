import { createOwnerDb } from "./client.js"
import { seedCatalog } from "./products.js"

/** `seed:procedures`: las listas oficiales y las bibliotecas de odentIA y latidIA (ADR 0069 y 0079). */
const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL es obligatoria para sembrar (rol owner)")

const result = await seedCatalog(createOwnerDb(url))
const lists = result.releases
  .map((r) => `${r.systemKey} ${r.version} (${r.codes} códigos, ${r.mappings} tratamientos)`)
  .join(", ")
console.log(
  `procedure coding seeded: ${result.systems} systems, ${result.codes} codes, ${result.templates} templates; ${lists}`,
)
process.exit(0)
