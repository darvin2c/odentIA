import { describe, expect, it } from "vitest"
import { clientDetailSchema } from "./client-model"
import { saleOf } from "./sale-api"

/** Una ficha como la devuelve `/api/admin/clients/:id`, con lo mínimo. */
const detail = (stage: string) =>
  clientDetailSchema.parse({
    id: "c1",
    name: "Clínica Prueba (ficticia)",
    product: "dental",
    stage,
    countryCode: "PE",
    city: null,
    professionals: null,
    currentTool: null,
    origin: "web",
    originDetail: null,
    referredBy: null,
    owner: null,
    organization: null,
    nextStep: null,
    opportunity: null,
    waitlistRequest: null,
    summary: null,
    contacts: [],
    openTasks: [],
    recentActivities: [],
    signals: [],
    riskSignals: [],
    lastContactAt: null,
    archivedAt: null,
    createdAt: "2026-11-12T15:00:00.000Z",
  })

describe("la ficha vista desde la venta", () => {
  it("es la misma lectura de la ficha, con su etapa", () => {
    expect(saleOf(detail("propuesta"))).toMatchObject({ id: "c1", stage: "propuesta" })
  })

  it("una etapa nueva del servidor no rompe la pestaña Venta ni los cajones", () => {
    expect(() => saleOf(detail("etapa_nueva"))).not.toThrow()
    expect(saleOf(detail("etapa_nueva")).stage).toBe("contacto")
  })
})
