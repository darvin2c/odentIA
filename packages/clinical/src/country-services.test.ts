import { describe, expect, it } from "vitest"
import { clinicalProfileFor, kindOfSpecialty, phaseForKind, specialtyForKind, TREATMENT_KIND_KEYS } from "./index.js"

describe("lista de servicios y especialidades de cada país (ADR 0067)", () => {
  it("Perú pide la CPMS a toda clínica; un país sin perfil no tiene lista", () => {
    expect(clinicalProfileFor("PE").services).toMatchObject({ system: "CPMS", label: "CPMS", codeName: "código CPMS", required: true, norm: "RM 550-2023-MINSA" })
    expect(clinicalProfileFor("UY").services).toBeNull()
    expect(clinicalProfileFor(null).services).toBeNull()
  })

  it("cada tipo de la biblioteca va a una sola especialidad, en el núcleo y en Perú", () => {
    for (const country of ["PE", "CO", "MX", "CL", "CR", "SV", "UY", null]) {
      const profile = clinicalProfileFor(country)
      for (const kind of TREATMENT_KIND_KEYS) {
        const owners = profile.specialties.list.filter((item) => item.receives.includes(kind))
        expect(owners, `${country ?? "núcleo"} · ${kind}`).toHaveLength(1)
      }
      const keys = profile.specialties.list.map((item) => item.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it("Colombia y México piden su lista a toda clínica; Chile la tiene de referencia", () => {
    expect(clinicalProfileFor("CO").services).toMatchObject({ system: "CUPS", required: true })
    expect(clinicalProfileFor("MX").services).toMatchObject({ system: "CIE9MC-MX", label: "CIE-9-MC", required: true })
    expect(clinicalProfileFor("CL").services).toMatchObject({ system: "FONASA", required: false })
    expect(clinicalProfileFor("CR").services).toMatchObject({ system: "COLEGIO-CR", required: false })
    expect(clinicalProfileFor("SV").services).toMatchObject({ system: "CIE9MC-SV", required: false })
    // Lo demás de esos países sigue siendo el núcleo: nada peruano.
    expect(clinicalProfileFor("CO").odontogram).toBeNull()
    expect(specialtyForKind(clinicalProfileFor("CO"), "implantologia")?.name).toBe("Cirugía oral")
    expect(specialtyForKind(clinicalProfileFor("CL"), "disfuncion")?.name).toBe("Trastornos temporomandibulares y dolor orofacial")
    expect(specialtyForKind(clinicalProfileFor("MX"), "protesis")?.name).toBe("Rehabilitación oral")
  })

  it("en Perú la prótesis va a Rehabilitación Oral y la limpieza a Odontología general", () => {
    const peru = clinicalProfileFor("PE")
    expect(specialtyForKind(peru, "protesis")?.name).toBe("Rehabilitación Oral")
    expect(specialtyForKind(peru, "prevencion")?.name).toBe("Odontología general")
    expect(peru.specialties.source).toBe("DS 023-2020-SA")
    expect(peru.specialties.list.map((item) => item.name)).not.toContain("Diagnóstico")
  })

  it("un servicio propio toma el tipo de su especialidad; una especialidad de la clínica no tiene", () => {
    const peru = clinicalProfileFor("PE")
    expect(kindOfSpecialty(peru, "cirugia_bucal_maxilofacial")).toBe("cirugia")
    expect(phaseForKind(kindOfSpecialty(peru, "cirugia_bucal_maxilofacial"))).toBe("quirurgica")
    expect(kindOfSpecialty(peru, "estetica_facial")).toBeNull()
    // Una especialidad conservada con la clave de un tipo de la biblioteca sigue siendo ese tipo.
    expect(kindOfSpecialty(peru, "estetica")).toBe("estetica")
    expect(phaseForKind(null)).toBe("basica")
  })
})
