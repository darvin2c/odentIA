import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { MEDICAL_CONSENT_TEMPLATES } from "./consents.js"

it("cada consentimiento sugerido de latidIA se une a tratamientos que existen en su biblioteca", () => {
  const keys = readFileSync(new URL("../../db/seeds/biblioteca_medica.csv", import.meta.url), "utf8")
    .split("\n")
    .slice(1)
    .map((line) => line.split(",")[0]?.trim() ?? "")
    .filter(Boolean)
  for (const suggestion of MEDICAL_CONSENT_TEMPLATES) {
    for (const prefix of suggestion.servicePrefixes ?? []) {
      expect(keys.some((key) => key.startsWith(prefix)), `${suggestion.key}: ${prefix}`).toBe(true)
    }
  }
})
