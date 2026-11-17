import { expect, it } from "vitest"
import { indicatedForLater } from "./plan-left-out.js"

// QA del 16 nov, Q16 (Paola): endodoncia de la 36 (opción A, elegida) y exodoncia (opción B, no
// elegida). El cierre decía «2 indicados hoy · 1 por ejecutar».
it("lo indicado hoy que sigue en pie no cuenta la opción que la persona no eligió", () => {
  const indicated = [
    { id: "endodoncia", status: "pendiente", decisionStatus: "aceptado" },
    { id: "exodoncia", status: "pendiente", decisionStatus: "no_elegida" },
    { id: "resina", status: "pendiente", decisionStatus: "rechazado" },
    { id: "quitado", status: "cancelado", decisionStatus: "pendiente" },
    { id: "limpieza", status: "realizado", decisionStatus: "aceptado" },
    { id: "corona", status: "pendiente", decisionStatus: "pendiente" },
  ]
  // La limpieza se hizo hoy: ya cuenta en «Realizado hoy».
  expect(indicatedForLater(indicated, new Set(["limpieza"])).map((item) => item.id)).toEqual(["endodoncia", "corona"])
})
