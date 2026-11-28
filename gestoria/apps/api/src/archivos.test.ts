/**
 * El almacenamiento de gestorIA contra un S3 de verdad (ADR 0236): RustFS, el mismo de desarrollo
 * de las clínicas, en un contenedor propio que se borra al terminar. Guarda, lee, firma un enlace
 * que se abre por HTTP (y que vence) y borra una carpeta entera sin tocar la de al lado.
 */
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createS3Storage } from "./archivos.js"

let container: StartedTestContainer
let storage: ReturnType<typeof createS3Storage>

beforeAll(async () => {
  container = await new GenericContainer("docker.io/rustfs/rustfs:1.0.1")
    .withEnvironment({ RUSTFS_ACCESS_KEY: "gestoria", RUSTFS_SECRET_KEY: "gestoria-prueba" })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/health", 9000).forStatusCode(200))
    .start()
  storage = createS3Storage({
    endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
    region: "us-east-1",
    accessKeyId: "gestoria",
    secretAccessKey: "gestoria-prueba",
    bucket: "gestoria-medios-prueba",
  })
  await storage.ensureBucket()
})

afterAll(async () => {
  await container?.stop()
})

describe("el bucket privado de gestorIA", () => {
  it("guarda y lee; lo que no está es null", async () => {
    await storage.put(
      "tiendas/t1/productos/p1/fotos/f1/original",
      new Uint8Array([1, 2, 3]),
      "image/jpeg",
    )
    expect(await storage.get("tiendas/t1/productos/p1/fotos/f1/original")).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    expect(await storage.get("tiendas/t1/no-esta")).toBeNull()
  })

  it("nadie lo lee sin enlace firmado, y el enlace vence", async () => {
    const key = "tiendas/t1/productos/p1/fotos/f1/vitrina"
    await storage.put(key, new TextEncoder().encode("foto"), "image/webp")
    const url = await storage.signedUrl(key, 60)
    const ok = await fetch(url)
    expect(ok.status).toBe(200)
    expect(ok.headers.get("content-type")).toBe("image/webp")
    expect(await ok.text()).toBe("foto")
    const bare = await fetch(url.split("?")[0]!)
    expect(bare.status).toBe(403)
    const short = await storage.signedUrl(key, 1)
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect((await fetch(short)).status).toBe(403)
  })

  it("borra una carpeta entera y deja la de al lado", async () => {
    await storage.put("tiendas/t1/productos/p1/fotos/f2/original", new Uint8Array([9]), "image/png")
    await storage.put(
      "tiendas/t1/productos/p1/fotos/f22/original",
      new Uint8Array([8]),
      "image/png",
    )
    await storage.removeFolder("tiendas/t1/productos/p1/fotos/f2")
    expect(await storage.get("tiendas/t1/productos/p1/fotos/f2/original")).toBeNull()
    expect(await storage.get("tiendas/t1/productos/p1/fotos/f22/original")).toEqual(
      new Uint8Array([8]),
    )
  })
})
