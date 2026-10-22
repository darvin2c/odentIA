import { describe, expect, it } from "vitest"
import { dentalProfileFor, kindOfSpecialty, phaseForKind, specialtyForKind, TREATMENT_KIND_KEYS } from "./index.js"

describe("especialidades de cada país (ADR 0069)", () => {
  it("cada tipo de la biblioteca va a una sola especialidad, en el núcleo y en Perú", () => {
    for (const country of ["PE", "CO", "MX", "CL", "CR", "SV", "UY", null]) {
      const profile = dentalProfileFor(country)
      for (const kind of TREATMENT_KIND_KEYS) {
        const owners = profile.specialties.list.filter((item) => item.receives.includes(kind))
        expect(owners, `${country ?? "núcleo"} · ${kind}`).toHaveLength(1)
      }
      const keys = profile.specialties.list.map((item) => item.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it("Colombia y Chile tienen sus especialidades y nada peruano", () => {
    expect(dentalProfileFor("CO").odontogram).toBeNull()
    expect(specialtyForKind(dentalProfileFor("CO"), "implantologia")?.name).toBe("Cirugía oral")
    expect(specialtyForKind(dentalProfileFor("CL"), "disfuncion")?.name).toBe("Trastornos temporomandibulares y dolor orofacial")
    expect(specialtyForKind(dentalProfileFor("MX"), "protesis")?.name).toBe("Rehabilitación oral")
  })

  it("en Perú la prótesis va a Rehabilitación Oral y la limpieza a Odontología general", () => {
    const peru = dentalProfileFor("PE")
    expect(specialtyForKind(peru, "protesis")?.name).toBe("Rehabilitación Oral")
    expect(specialtyForKind(peru, "prevencion")?.name).toBe("Odontología general")
    expect(peru.specialties.source).toBe("DS 023-2020-SA")
    expect(peru.specialties.list.map((item) => item.name)).not.toContain("Diagnóstico")
  })

  it("un servicio propio toma el tipo de su especialidad; una especialidad de la clínica no tiene", () => {
    const peru = dentalProfileFor("PE")
    expect(kindOfSpecialty(peru, "cirugia_bucal_maxilofacial")).toBe("cirugia")
    expect(phaseForKind(kindOfSpecialty(peru, "cirugia_bucal_maxilofacial"))).toBe("quirurgica")
    expect(kindOfSpecialty(peru, "estetica_facial")).toBeNull()
    // Una especialidad conservada con la clave de un tipo de la biblioteca sigue siendo ese tipo.
    expect(kindOfSpecialty(peru, "estetica")).toBe("estetica")
    expect(phaseForKind(null)).toBe("basica")
  })
})
