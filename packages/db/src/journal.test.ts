import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

// El migrador de drizzle aplica solo las migraciones cuyo `when` es mayor que
// el de la última aplicada y salta las demás en silencio. Una rama que quede
// con una fecha anterior a la de `main` no falla: su migración nunca corre.
// Esta prueba lo atrapa antes del merge, sin base de datos (ADR 0045 y 0088).
const folder = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle")

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
  entries: JournalEntry[]
}

it("las fechas del journal crecen estrictamente", () => {
  const entries = journal.entries
  for (let i = 1; i < entries.length; i++) {
    expect(
      entries[i]!.when,
      `${entries[i]!.tag} debe tener un \`when\` mayor que ${entries[i - 1]!.tag}`,
    ).toBeGreaterThan(entries[i - 1]!.when)
  }
})

it("cada entrada tiene su archivo y su número coincide con su posición", () => {
  journal.entries.forEach((entry, position) => {
    expect(entry.idx, entry.tag).toBe(position)
    expect(entry.tag.slice(0, 4), entry.tag).toBe(String(entry.idx).padStart(4, "0"))
    expect(existsSync(join(folder, `${entry.tag}.sql`)), `falta ${entry.tag}.sql`).toBe(true)
  })
})

it("no hay migraciones fuera del journal", () => {
  const tags = new Set(journal.entries.map((entry) => entry.tag))
  const files = readdirSync(folder).filter((file) => file.endsWith(".sql"))
  for (const file of files) expect(tags.has(file.replace(/\.sql$/, "")), `${file} no está en el journal`).toBe(true)
})
