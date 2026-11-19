import { expect, it } from "vitest"
import { consentEventWords, groupConsentEvents } from "./consentimientos-tab"

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

// QA de diseño del 18 nov (H13): cinco líneas iguales y el nombre dos veces.
it("la Historia junta los cambios seguidos de una misma persona y no repite el nombre", () => {
  const change = (at: string, actorName: string | null = "Dra. Ana Torres") => ({
    toStatus: "riesgos_propios",
    reason: "Cambiados",
    actorName,
    createdAt: at,
  })
  const grouped = groupConsentEvents([
    { toStatus: "pendiente", reason: "Documento creado", actorName: "Dra. Ana Torres", createdAt: "t0" },
    change("t1"),
    change("t2"),
    change("t3"),
    change("t4", "Luis Prado"),
    change("t5"),
  ])
  expect(grouped.map((row) => [row.event.toStatus, row.times, row.lastAt])).toEqual([
    ["pendiente", 1, "t0"],
    ["riesgos_propios", 3, "t3"],
    ["riesgos_propios", 1, "t4"],
    ["riesgos_propios", 1, "t5"],
  ])
  expect(
    consentEventWords({
      toStatus: "informado",
      reason: "Ana Torres · COP 12345",
      actorName: "Dra. Ana Torres",
    }),
  ).toBe("Informado por el profesional · Ana Torres · COP 12345")
})
