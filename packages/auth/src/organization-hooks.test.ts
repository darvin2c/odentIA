import { describe, expect, it } from "vitest"
import { lockClinicIdentityFields } from "./index.js"

describe("organization/update de Better Auth", () => {
  it("no cambia el logo ni el nombre de la clínica: tienen su propio camino", async () => {
    await expect(lockClinicIdentityFields({ organization: { logo: "https://cdn.example.com/avatars/clinica-otra/logo.png" } })).rejects.toMatchObject({
      body: { code: "ORGANIZATION_FIELD_LOCKED" },
    })
    await expect(lockClinicIdentityFields({ organization: { logo: null } })).rejects.toMatchObject({ body: { code: "ORGANIZATION_FIELD_LOCKED" } })
    await expect(lockClinicIdentityFields({ organization: { name: "Otro nombre" } })).rejects.toMatchObject({ body: { code: "ORGANIZATION_FIELD_LOCKED" } })
  })

  it("lo demás pasa como siempre", async () => {
    await expect(lockClinicIdentityFields({ organization: { metadata: { a: 1 } } })).resolves.toBeUndefined()
  })
})
