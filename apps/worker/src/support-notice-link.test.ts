import { describe, expect, it } from "vitest"
import { supportNoticeLink } from "./support-notices.js"

const urls = {
  adminUrl: "https://admin.odentia.test",
  webUrl: "https://app.odentia.test",
  accountApps: { "/gestoria": { url: "https://app.gestoria.test", brand: "gestoria" as const } },
}
const reply = {
  kind: "respuesta" as const,
  caseId: "caso 1",
  clinicSlug: null,
  clinicProduct: null,
}

describe("el enlace del aviso de un caso de la cuenta (ADR 0218)", () => {
  it("pedido desde gestorIA, lleva a su soporte en su app", () => {
    expect(supportNoticeLink({ ...reply, openedFrom: "/gestoria" }, urls)).toBe(
      "https://app.gestoria.test/cuenta/soporte?caso=caso%201",
    )
  })

  it("pedido desde el panel, o sin la app configurada, sigue llevando al panel", () => {
    expect(supportNoticeLink({ ...reply, openedFrom: "/panel" }, urls)).toBe(
      "https://app.odentia.test/support?caso=caso%201",
    )
    expect(
      supportNoticeLink({ ...reply, openedFrom: "/gestoria" }, { ...urls, accountApps: {} }),
    ).toBe("https://app.odentia.test/support?caso=caso%201")
  })
})
