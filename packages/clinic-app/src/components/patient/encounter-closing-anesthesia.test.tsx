import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { AnesthesiaHealthLine } from "./encounter-closing"

// QA del 14 nov (causa raíz, A1): el aviso de anestesia del cierre no decía lo que dijo del corazón ni
// de la anestesia.
it("con anestesia, el cierre dice lo que dijo del corazón y de la anestesia, sin frenar", () => {
  const page = renderToStaticMarkup(
    <AnesthesiaHealthLine
      anesthetics={["Lidocaína 2 %"]}
      gaps={[]}
      risks={["tiene una válvula, un problema del corazón de nacimiento o tuvo endocarditis", "su médico le indicó antibiótico antes del dentista"]}
    />,
  ).replace(/<[^>]+>/g, "|")
  expect(page).toContain("Anestesia: revisa lo que dijo")
  expect(page).toContain(
    "Dijo que tiene una válvula, un problema del corazón de nacimiento o tuvo endocarditis y su médico le indicó antibiótico antes del dentista.",
  )
  expect(page).toContain("Puedes firmar igual.")
  // Sin anestesia no se dice.
  expect(renderToStaticMarkup(<AnesthesiaHealthLine anesthetics={[]} gaps={[]} risks={["x"]} />)).toBe("")
})
