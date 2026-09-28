import { randomUUID } from "node:crypto"
import { tenant } from "./env"
import { expect, test } from "./fixtures"
import { gotoHydrated } from "./hydration"

test("cola: tarea completada aparece por SSE", async ({ owner }) => {
  await gotoHydrated(owner.page, tenant(owner.org.slug, "/demo"))
  const box = owner.page.getByPlaceholder("Escribe un mensaje")
  await expect(box).toBeVisible()
  await expect(box).toBeEnabled()
  await box.fill(`hola-${randomUUID()}`)
  const send = owner.page.getByRole("button", { name: "Enviar tarea" })
  await expect(send).toBeEnabled()
  await send.click()
  await expect(owner.page.getByText("demo_task.done").first()).toBeVisible({ timeout: 15_000 })
})
