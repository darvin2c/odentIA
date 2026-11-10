import { describe, expect, it } from "vitest"
import { applicationServerKey, isInternalPath } from "./pwa"
import { clinicWebManifest } from "./web-manifest"

describe("la app instalada de la clínica", () => {
  it("se llama como la clínica, con el ícono y el color de su producto", () => {
    const manifest = clinicWebManifest({ brandColor: "#1d5fa8", name: "Pediatría Los Olivos", product: "medical" })
    expect(manifest).toMatchObject({ name: "Pediatría Los Olivos", short_name: "Pediatría Los Olivos", start_url: "/home", scope: "/", display: "standalone", theme_color: "#1d5fa8" })
    expect(manifest.icons.map((icon) => icon.src)).toEqual(["/pwa/latidia-192.png", "/pwa/latidia-512.png", "/pwa/latidia-maskable-512.png"])
    // Bajo el ícono va el nombre de la clínica: dos clínicas no quedan iguales.
    expect(clinicWebManifest({ brandColor: null, name: "Dental Smile", product: "dental" })).toMatchObject({ short_name: "Dental Smile", theme_color: "#ffffff" })
  })

  it("sin datos de la clínica queda la del producto base", () => {
    expect(clinicWebManifest({ brandColor: null })).toMatchObject({ name: "odentIA", icons: [{ src: "/pwa/odentia-192.png" }, {}, {}] })
  })

  it("un aviso solo abre rutas de esta clínica", () => {
    expect(isInternalPath("/home")).toBe(true)
    expect(isInternalPath("/patients/123?tab=datos")).toBe(true)
    expect(isInternalPath("//otra.com/x")).toBe(false)
    expect(isInternalPath("https://otra.com")).toBe(false)
    expect(isInternalPath("javascript:alert(1)")).toBe(false)
  })

  it("la clave pública llega en base64url y se entrega en bytes", () => {
    expect([...applicationServerKey("AQID_-8")]).toEqual([1, 2, 3, 255, 239])
  })
})
