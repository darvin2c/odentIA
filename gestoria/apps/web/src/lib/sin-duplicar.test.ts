import { describe, expect, it } from "vitest"

/**
 * gestorIA usa las piezas comunes de `@odentia/ui-patterns` y no las repite (`gestoria/AGENTS.md`,
 * «Las piezas comunes»): un formulario va en `FormDrawer` o `FormPanel`, con `useAppForm` y sus
 * campos; el aviso de borrador es el común. Esta prueba lee el código como texto y falla si
 * vuelve un panel propio de formulario (`Sheet` de `@odentia/ui`) o una de las piezas que se
 * quitaron.
 */

const web = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.*"], {
  query: "?raw",
  import: "default",
  eager: true,
})

/** Lo que ya existe en lo común, con el nombre de lo común que lo reemplaza. */
const REPEATED: { pattern: RegExp; instead: string }[] = [
  { pattern: /\bfunction\s+FormSheet\b|<FormSheet\b/, instead: "FormDrawer o FormPanel" },
  { pattern: /\bfunction\s+useDirty\b|\buseDirty\(/, instead: "useFormSurface (isDirty)" },
  { pattern: /\bSELECT_CLASSES\b/, instead: "field.SelectField o Select" },
  { pattern: /\bfunction\s+FormAlert\b|<FormAlert\b/, instead: "useFormSurface (error junto a los botones)" },
  { pattern: /\bfunction\s+fieldErrors\b|\bfieldErrors\(/, instead: "useFormSurface (errores en cada campo)" },
  { pattern: /\bfunction\s+(TextField|SelectField|SwitchField|DateField)\b/, instead: "los campos de useAppForm" },
  { pattern: /\bfunction\s+ErrorBlock\b|<ErrorBlock\b/, instead: "ErrorState" },
  { pattern: /type=["'](date|time|datetime-local)["']/, instead: "los controles de fecha comunes" },
]

/** El `Sheet` de `@odentia/ui` importado en una pantalla: un panel propio en vez del común. */
const OWN_SHEET = /import\s*\{[^}]*\bSheet(Content)?\b[^}]*\}\s*from\s*["']@odentia\/ui["']/

describe("gestorIA no repite las piezas comunes", () => {
  it("lee el código de la app", () => {
    expect(Object.keys(web).length).toBeGreaterThan(20)
  })

  it("ningún formulario usa un panel propio", () => {
    const found = Object.entries(web)
      .filter(([, source]) => OWN_SHEET.test(source))
      .map(([file]) => file)
    expect(found, "Usa FormDrawer, FormPanel o DetailDrawer de @odentia/ui-patterns").toEqual([])
  })

  for (const { pattern, instead } of REPEATED)
    it(`no vuelve ${pattern.source.slice(0, 40)}…`, () => {
      const found = Object.entries(web)
        .filter(([, source]) => pattern.test(source))
        .map(([file]) => file)
      expect(found, `Usa ${instead} de @odentia/ui-patterns`).toEqual([])
    })
})
