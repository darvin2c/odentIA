import { describe, expect, it } from "vitest"

/**
 * La guía de la Ayuda vive en el servidor (`apps/api/src/ayuda.ts`) y cita lo que dice esta app.
 * `ayuda.test.ts` de la API lo comprueba cuando cambia la guía; esta prueba, cuando cambia la
 * pantalla: el CI corre solo los paquetes que cambiaron, y un botón renombrado aquí dejaría a la
 * guía diciendo otra cosa. Las dos leen el código como texto.
 */

const web = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.*"], {
  query: "?raw",
  import: "default",
  eager: true,
})
const [guideSource] = Object.values(
  import.meta.glob<string>("../../../api/src/ayuda.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)

/** El trozo del archivo de la guía desde `export const <name>` hasta el cierre de su valor. */
function section(name: string, end: RegExp): string {
  const source = guideSource ?? ""
  const start = source.indexOf(`export const ${name}`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  const rest = source.slice(start)
  const close = rest.search(end)
  expect(close, name).toBeGreaterThan(0)
  return rest.slice(0, close)
}

describe("lo que la guía de la Ayuda cita de esta app", () => {
  it("cada texto entre «» de sus respuestas está en la pantalla de hoy", () => {
    const screens = Object.values(web).join("\n")
    const quoted = [...section("HELP_GUIDE", /\r?\n\]\r?\n/).matchAll(/«([^»]+)»/g)].map(
      ([, text]) => text as string,
    )
    expect(quoted.length).toBeGreaterThan(10)
    for (const text of quoted) expect(screens.includes(text), `«${text}»`).toBe(true)
  })

  it("cada pantalla a la que lleva existe, y la Ayuda también", () => {
    const routes = Object.entries(web).find(([file]) => file.endsWith("/main.tsx"))?.[1] ?? ""
    const paths = [...section("HELP_SCREENS", /\r?\n\} as const/).matchAll(/path: "([^"]+)"/g)].map(
      ([, path]) => path as string,
    )
    expect(paths.length).toBeGreaterThan(3)
    for (const path of [...paths, "/ayuda"])
      expect(routes.includes(`path: "${path}"`), path).toBe(true)
  })
})
