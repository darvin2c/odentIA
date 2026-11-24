/**
 * Vuelve a escribir las plantillas en blanco de las guías en la web
 * (`apps/web/public/guias/`): `pnpm --filter @odentia/services plantillas`.
 * Hay que correrlo cuando cambia el dibujo de la hoja o de la plantilla; la prueba
 * `blank-sheets.test.ts` avisa si quedaron viejas.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { BLANK_SHEET_KEYS, BLANK_SHEETS, renderBlankSheet } from "./blank-sheets.js"

const out = fileURLToPath(new URL("../../../apps/web/public/guias/", import.meta.url))
mkdirSync(out, { recursive: true })
for (const sheet of BLANK_SHEET_KEYS) {
  const bytes = await renderBlankSheet(sheet)
  writeFileSync(`${out}${BLANK_SHEETS[sheet].file}`, bytes)
  console.log(`${BLANK_SHEETS[sheet].file}: ${Math.round(bytes.length / 1024)} KB`)
}
