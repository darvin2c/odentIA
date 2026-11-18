import { expect, it } from "vitest"
import { consentEventWords } from "./consentimientos-tab"

// QA del 18 nov: «Riesgos propios de su caso · Cambiados» no decía quién los cambió.
it("la Historia del documento dice quién cambió los riesgos propios y quién hizo cada paso", () => {
  expect(
    consentEventWords({
      toStatus: "riesgos_propios",
      reason: "Cambiados",
      actorName: "Ana Torres",
    }),
  ).toBe("Riesgos propios de su caso · los cambió Ana Torres")
  expect(
    consentEventWords({
      toStatus: "riesgos_propios",
      reason: "Quitados de la hoja",
      actorName: "Ana Torres",
    }),
  ).toBe("Riesgos propios de su caso · los quitó Ana Torres")
  expect(consentEventWords({ toStatus: "firmado", reason: null, actorName: "Luis Rojas" })).toBe(
    "Firmado · Luis Rojas",
  )
  expect(
    consentEventWords({
      toStatus: "pendiente",
      reason: "Documento creado",
      actorName: "Luis Rojas",
    }),
  ).toBe("Creado (pendiente de firma) · Luis Rojas")
  // Sin quién (lo hizo la persona desde su enlace, o una API anterior), lo de siempre.
  expect(
    consentEventWords({ toStatus: "riesgos_propios", reason: "Cambiados", actorName: null }),
  ).toBe("Riesgos propios de su caso · Cambiados")
  expect(
    consentEventWords({ toStatus: "revocado", reason: "Cambió de opinión", actorName: null }),
  ).toBe("Revocado · Cambió de opinión")
})
