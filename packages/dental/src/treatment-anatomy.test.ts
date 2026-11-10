import { describe, expect, it } from "vitest"
import {
  anatomyFits,
  anatomyGroupsWords,
  anatomySibling,
  type TreatmentAnatomy,
  toothFitNotice,
  toothGroupOf,
} from "./index.js"

type Anatomy = Pick<TreatmentAnatomy, "groups" | "dentition">
const ANTERIOR: Anatomy = { groups: ["anterior"], dentition: null }
const BICUSPID: Anatomy = { groups: ["premolar"], dentition: null }
const POSTERIOR_ENDO: Anatomy = { groups: ["molar"], dentition: null }
const POSTERIOR_RESIN: Anatomy = { groups: ["premolar", "molar"], dentition: null }
const DECIDUOUS_MOLAR: Anatomy = { groups: ["molar"], dentition: "deciduous" }

describe("la anatomía de un tratamiento y la pieza (ISO 3950)", () => {
  it("cada pieza cae en su grupo: los temporales x4–x5 son molares", () => {
    expect([11, 13, 14, 25, 46, 38, 53, 54, 85].map(toothGroupOf)).toEqual([
      "anterior",
      "anterior",
      "premolar",
      "premolar",
      "molar",
      "molar",
      "anterior",
      "molar",
      "molar",
    ])
  })

  it("encaja por grupo y por dentición", () => {
    expect(anatomyFits(ANTERIOR, 46)).toBe(false)
    expect(anatomyFits(POSTERIOR_ENDO, 46)).toBe(true)
    expect(anatomyFits(POSTERIOR_ENDO, 55)).toBe(true)
    expect(anatomyFits(BICUSPID, 46)).toBe(false)
    expect(anatomyFits(POSTERIOR_RESIN, 15)).toBe(true)
    expect(anatomyFits(DECIDUOUS_MOLAR, 46)).toBe(false)
    expect(anatomyFits(DECIDUOUS_MOLAR, 75)).toBe(true)
  })

  it("la endodoncia anterior en la 46 avisa y ofrece la posterior, no la bicúspide", () => {
    const siblings = [
      { id: "bic", name: "Endodoncia bicúspide vital", ...BICUSPID },
      { id: "post", name: "Endodoncia posterior vital", ...POSTERIOR_ENDO },
    ]
    const notice = toothFitNotice(
      { name: "Endodoncia anterior vital", anatomy: ANTERIOR },
      46,
      siblings,
    )
    expect(notice?.message).toBe(
      "La 46 es un molar y «Endodoncia anterior vital» es para dientes anteriores.",
    )
    expect(notice?.sibling?.id).toBe("post")
    expect(notice?.missing).toBeNull()
  })

  it("sin hermano que encaje lo dice, y no ofrece otro grupo", () => {
    const notice = toothFitNotice({ name: "Endodoncia anterior vital", anatomy: ANTERIOR }, 46, [
      { id: "bic", ...BICUSPID },
    ])
    expect(notice?.sibling).toBeNull()
    expect(notice?.missing).toBe(
      "Tu lista no tiene una para molares: el consentimiento dirá «anterior».",
    )
    // La bicúspide en un molar también avisa.
    expect(
      toothFitNotice({ name: "Endodoncia bicúspide vital", anatomy: BICUSPID }, 36, [])?.message,
    ).toBe("La 36 es un molar y «Endodoncia bicúspide vital» es para premolares.")
  })

  it("si la clínica le cambió el nombre, el consentimiento dice ese nombre", () => {
    const notice = toothFitNotice({ name: "Endodoncia unirradicular", anatomy: ANTERIOR }, 46, [])
    expect(notice?.missing).toBe(
      "Tu lista no tiene una para molares: el consentimiento dirá «Endodoncia unirradicular».",
    )
  })

  it("las palabras del servicio siguen sus grupos y su dentición", () => {
    expect(anatomyGroupsWords(POSTERIOR_RESIN)).toBe("premolares y molares")
    expect(anatomyGroupsWords(DECIDUOUS_MOLAR)).toBe("molares temporales")
    expect(
      toothFitNotice({ name: "Pulpectomía posterior, deciduo", anatomy: DECIDUOUS_MOLAR }, 46, [])
        ?.message,
    ).toBe("La 46 es un molar y «Pulpectomía posterior, deciduo» es para molares temporales.")
    expect(
      toothFitNotice(
        { name: "Resina fotocurable, 1 superficie, posterior", anatomy: POSTERIOR_RESIN },
        11,
        [],
      )?.message,
    ).toBe(
      "La 11 es un diente anterior y «Resina fotocurable, 1 superficie, posterior» es para premolares y molares.",
    )
  })

  it("lo que encaja, el servicio propio sin anatomía y lo que no es pieza no avisan", () => {
    expect(
      toothFitNotice({ name: "Endodoncia posterior vital", anatomy: POSTERIOR_ENDO }, 46, []),
    ).toBeNull()
    expect(toothFitNotice({ name: "Endodoncia", anatomy: null }, 46, [])).toBeNull()
    expect(
      toothFitNotice({ name: "Endodoncia anterior vital", anatomy: ANTERIOR }, 99, []),
    ).toBeNull()
  })

  it("entre hermanos que encajan, el más específico", () => {
    const pick = anatomySibling(75, [
      { id: "todos", groups: ["anterior", "molar"], dentition: null },
      { id: "temporal", groups: ["molar"], dentition: "deciduous" },
    ] as const)
    expect(pick?.id).toBe("temporal")
  })
})

it("la endodoncia de permanente en un molar temporal avisa y no ofrece la de molares permanentes (QA antes de entregar)", () => {
  const permanentEndo: Anatomy = { groups: ["molar"], dentition: "permanent" }
  const notice = toothFitNotice({ name: "Endodoncia anterior vital", anatomy: { groups: ["anterior"], dentition: "permanent" } }, 85, [permanentEndo])
  expect(notice?.message).toBe("La 85 es un molar temporal y «Endodoncia anterior vital» es para dientes anteriores permanentes.")
  expect(notice?.sibling).toBeNull()
  // En un molar permanente, no se dice «permanentes»: sobra.
  expect(toothFitNotice({ name: "Endodoncia anterior vital", anatomy: { groups: ["anterior"], dentition: "permanent" } }, 46, [permanentEndo])?.message).toBe(
    "La 46 es un molar y «Endodoncia anterior vital» es para dientes anteriores.",
  )
})
