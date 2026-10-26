/**
 * Núcleo admin: invariantes puras + integración real contra Postgres
 * (harness compartido, migraciones completas) + smoke HTTP de rotación.
 */
import { createHmac } from "node:crypto"
import { createAuth, LEGAL_VERSION } from "@odentia/auth"
import { sql } from "drizzle-orm"
import { beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { ownerDb, setupTestDb } from "./test-setup.js"
import {
  acceptAdminInvitation,
  ADMIN_TRUSTED_DEVICE_IDLE_MS,
  ADMIN_MFA_MAX_ATTEMPTS,
  bootstrapAdminStaff,
  canAcceptAdminInvitation,
  claimMfaCode,
  clearPendingStaffFactor,
  getLiveSessionBinding,
  getStaffFactorId,
  hasStaffFactor,
  hashInviteToken,
  hashMfaCode,
  isLastActiveAdmin,
  isSessionBindingLive,
  keepStaffSignInWithoutFactor,
  matchesInviteTokenHash,
  normalizeStaffEmail,
  recordAdminSessionBinding,
  regenerateStaffBackupCodes,
  resolveAdminVerification,
  setAdminStaffActive,
  trustAdminDevice,
} from "./admin-core.js"
import { ServiceError } from "./errors.js"

describe("normalizeStaffEmail", () => {
  it("compara sin distinguir mayúsculas ni espacios", () => {
    expect(normalizeStaffEmail("  Ana@Odentia.pe ")).toBe("ana@odentia.pe")
  })
})

describe("isLastActiveAdmin", () => {
  it("protege al único admin activo e ignora el resto", () => {
    const staff = [
      { userId: "a", role: "admin", active: true },
      { userId: "b", role: "admin", active: false },
      { userId: "c", role: "support", active: true },
    ]
    expect(isLastActiveAdmin(staff, "a")).toBe(true)
    expect(isLastActiveAdmin([...staff, { userId: "d", role: "admin", active: true }], "a")).toBe(false)
    expect(isLastActiveAdmin(staff, "c")).toBe(false)
    expect(isLastActiveAdmin(staff, "x")).toBe(false)
  })
})

describe("canAcceptAdminInvitation", () => {
  const now = new Date("2026-10-14T12:00:00Z")
  const invitation = { status: "pending", email: "nueva@odentia.pe", expiresAt: new Date(now.getTime() + 1000) }
  it("acepta identidad verificada del mismo correo y rechaza lo demás", () => {
    expect(canAcceptAdminInvitation(invitation, { id: "u", email: "NUEVA@odentia.pe", emailVerified: true }, now)).toBe(true)
    expect(canAcceptAdminInvitation(invitation, { id: "u", email: "otra@odentia.pe", emailVerified: true }, now)).toBe(false)
    expect(canAcceptAdminInvitation(invitation, { id: "u", email: "nueva@odentia.pe", emailVerified: false }, now)).toBe(false)
    expect(
      canAcceptAdminInvitation({ ...invitation, status: "revoked" }, { id: "u", email: "nueva@odentia.pe", emailVerified: true }, now),
    ).toBe(false)
    expect(
      canAcceptAdminInvitation({ ...invitation, expiresAt: now }, { id: "u", email: "nueva@odentia.pe", emailVerified: true }, now),
    ).toBe(false)
  })
})

describe("isSessionBindingLive", () => {
  it("exige vigencia sin revocar y sin expirar (frontera de expiración para el consumidor)", () => {
    const now = new Date("2026-10-14T12:00:00Z")
    expect(isSessionBindingLive({ expiresAt: new Date(now.getTime() + 1000), revokedAt: null }, now)).toBe(true)
    expect(isSessionBindingLive(undefined, now)).toBe(false)
    expect(isSessionBindingLive({ expiresAt: new Date(now.getTime() + 1000), revokedAt: now }, now)).toBe(false)
    expect(isSessionBindingLive({ expiresAt: now, revokedAt: null }, now)).toBe(false)
  })
})

describe("invite token", () => {
  it("acepta el crudo una vez hasheado y rechaza otro", () => {
    const hash = hashInviteToken("abc123")
    expect(matchesInviteTokenHash("abc123", hash)).toBe(true)
    expect(matchesInviteTokenHash("otro", hash)).toBe(false)
  })
})

describe("hashMfaCode", () => {
  it("es determinista y separa por credencial y código", () => {
    expect(hashMfaCode("f1", "123456")).toBe(hashMfaCode("f1", "123456"))
    expect(hashMfaCode("f1", "123456")).not.toBe(hashMfaCode("f1", "654321"))
    expect(hashMfaCode("f1", "123456")).not.toBe(hashMfaCode("f2", "123456"))
  })
})

describe("admin-core contra Postgres", () => {
  setupTestDb()

  // Aislamiento entre pruebas: purga el estado propio del slice (hijos
  // primero por FK). Sin orden cruzado: cada prueba parte de cero.
  beforeEach(async () => {
    await ownerDb.execute(sql`delete from admin_session_verification`)
    await ownerDb.execute(sql`delete from admin_audit`)
    await ownerDb.execute(sql`delete from admin_invitation`)
    await ownerDb.execute(sql`delete from admin_staff`)
    await ownerDb.execute(sql`delete from two_factor`)
    await ownerDb.execute(sql`delete from "session"`)
    await ownerDb.execute(sql`delete from "account"`)
    await ownerDb.execute(sql`delete from user_global_block`)
    await ownerDb.execute(sql`delete from "user" where id like 'u-%' or email like '%@example.test'`)
  })
  async function makeUser(id: string, email: string): Promise<void> {
    await ownerDb.execute(sql`insert into "user" (id,name,email,email_verified) values (${id},${id},${email},true) on conflict (id) do nothing`)
  }

  async function makeStaff(userId: string, role: "admin" | "support"): Promise<void> {
    await ownerDb.execute(
      sql`insert into admin_staff (user_id,role,active) values (${userId},${role},true) on conflict (user_id) do update set role=excluded.role, active=true`,
    )
  }

  it("degradación concurrente del último admin: exactamente una gana", async () => {
    await makeUser("u-last-a", "lasta@example.test")
    await makeUser("u-last-b", "lastb@example.test")
    await makeStaff("u-last-a", "admin")
    await makeStaff("u-last-b", "admin")
    const results = await Promise.allSettled([
      setAdminStaffActive(ownerDb, { userId: "u-last-a", role: "admin" }, "u-last-b", false, "motivo concurrente a"),
      setAdminStaffActive(ownerDb, { userId: "u-last-b", role: "admin" }, "u-last-a", false, "motivo concurrente b"),
    ])
    const ok = results.filter((r) => r.status === "fulfilled").length
    const denied = results.filter(
      (r) =>
        r.status === "rejected" &&
        r.reason instanceof ServiceError &&
        (r.reason.code === "LAST_ADMIN" || r.reason.code === "FORBIDDEN"),
    ).length
    expect(ok).toBe(1)
    expect(denied).toBe(1)
    const remaining = await ownerDb.execute(
      sql`select count(*)::int as n from admin_staff where role='admin' and active`,
    )
    const countRows = z.array(z.object({ n: z.number() })).parse(remaining)
    expect(countRows[0]?.n).toBe(1)
  }, 60_000)

  it("claim concurrente: replay 409 y presupuesto 429", async () => {
    await makeUser("u-claim", "claim@example.test")
    await makeStaff("u-claim", "support")
    const actor = { userId: "u-claim", role: "support" as const }
    const codes = ["c1", "c2", "c3"]
    const burst = await Promise.allSettled(
      codes.flatMap((code) => [0, 1, 2, 3].map(() => claimMfaCode(ownerDb, actor, { method: "totp", codeHash: hashMfaCode("f-test", code) }))),
    )
    expect(burst.filter((r) => r.status === "fulfilled").length).toBe(3)
    const rejected = burst.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    expect(rejected.map(error => error instanceof ServiceError ? error.code : String(error)))
      .toEqual(Array(9).fill("MFA_REPLAY"))
    for (let i = 0; i < ADMIN_MFA_MAX_ATTEMPTS - 3; i++) {
      await claimMfaCode(ownerDb, actor, { method: "totp", codeHash: hashMfaCode("f-test", `d${i}`) })
    }
    await expect(claimMfaCode(ownerDb, actor, { method: "totp", codeHash: hashMfaCode("f-test", "final") })).rejects.toMatchObject({
      code: "MFA_LOCKED",
    })
  }, 60_000)

  it("equipo reconocido: no pide el código salvo otro país, 30 días, otra contraseña u otro factor", async () => {
    await makeUser("u-device", "device@example.test")
    await makeStaff("u-device", "admin")
    await ownerDb.execute(
      sql`insert into two_factor (id,user_id,secret,backup_codes,verified) values ('tf-device','u-device','s','b',true)`,
    )
    await ownerDb.execute(
      sql`insert into account (id,account_id,provider_id,user_id,password,created_at,updated_at) values ('acc-device','u-device','credential','u-device','hash-1',now(),now())`,
    )
    const now = new Date()
    const resolve = (sessionId: string, deviceToken: string | null, country: string | null, at = now) =>
      resolveAdminVerification(ownerDb, { userId: "u-device", sessionId, deviceToken, country, now: at })

    // Sin equipo reconocido ni marca: se pide, sin motivo especial.
    expect(await resolve("s-1", null, "PE")).toEqual({ verified: false, reason: null })

    // Tras el código en Perú: otra sesión del mismo equipo en Perú entra sola.
    const token = await trustAdminDevice(ownerDb, { userId: "u-device", factorId: "tf-device", country: "PE", currentToken: null })
    const fromDevice = await resolve("s-2", token, "PE")
    expect(fromDevice.verified && fromDevice.binding.method).toBe("device")
    // Esa marca vale para la sesión mientras siga en Perú; desde Chile se pide, y dice por qué.
    expect((await resolve("s-2", token, "PE")).verified).toBe(true)
    expect(await resolve("s-2", token, "CL")).toEqual({ verified: false, reason: "country" })
    expect(await resolve("s-3", token, "CL")).toEqual({ verified: false, reason: "country" })
    // Poner el código en Chile reconoce el mismo equipo allí, con el mismo token.
    expect(await trustAdminDevice(ownerDb, { userId: "u-device", factorId: "tf-device", country: "CL", currentToken: token })).toBe(token)
    expect((await resolve("s-4", token, "CL")).verified).toBe(true)

    // 30 días sin abrir la administración en ese equipo: se pide y el equipo deja de valer.
    const later = new Date(now.getTime() + ADMIN_TRUSTED_DEVICE_IDLE_MS + 60_000)
    expect(await resolve("s-5", token, "CL", later)).toEqual({ verified: false, reason: null })
    expect((await resolve("s-6", token, "CL")).verified).toBe(false)

    // Otra contraseña u otro factor dejan sin valor al equipo.
    const second = await trustAdminDevice(ownerDb, { userId: "u-device", factorId: "tf-device", country: "PE", currentToken: null })
    await ownerDb.execute(sql`update account set password='hash-2' where id='acc-device'`)
    expect((await resolve("s-7", second, "PE")).verified).toBe(false)
    const third = await trustAdminDevice(ownerDb, { userId: "u-device", factorId: "tf-device", country: "PE", currentToken: null })
    expect((await resolve("s-8", third, "PE")).verified).toBe(true)
    await ownerDb.execute(sql`update two_factor set id='tf-device-2' where id='tf-device'`)
    expect((await resolve("s-9", third, "PE")).verified).toBe(false)

    // Un token de otra persona no vale.
    await makeUser("u-other", "other@example.test")
    expect((await resolveAdminVerification(ownerDb, { userId: "u-other", sessionId: "s-10", deviceToken: third, country: "PE", now })).verified).toBe(false)
  }, 60_000)

  it("enrolamiento abandonado no cuenta y permite reiniciar", async () => {
    await makeUser("u-pending", "pending@example.test")
    await makeStaff("u-pending", "support")
    await ownerDb.execute(
      sql`insert into two_factor (id,user_id,secret,backup_codes,verified) values ('tf-pending','u-pending','s','b',false) on conflict (id) do nothing`,
    )
    expect(await hasStaffFactor(ownerDb, "u-pending")).toBe(false)
    expect(await getStaffFactorId(ownerDb, "u-pending")).toBeNull()
    expect(await clearPendingStaffFactor(ownerDb, { userId: "u-pending", role: "support" })).toBe(true)
    expect(await clearPendingStaffFactor(ownerDb, { userId: "u-pending", role: "support" })).toBe(false)
  }, 60_000)

  /** Better Auth real con un navegador mínimo: guarda las cookies que recibe. */
  function authClient() {
    const mailer = { send: async (): Promise<void> => undefined }
    const auth = createAuth({
      db: ownerDb,
      ownerDb,
      mailer,
      secret: "smoke-secret-que-supera-treinta-y-dos-bytes",
      baseURL: "http://localhost:3001/api/auth",
      webURL: "http://localhost:3000",
      cookieDomain: "localhost",
      trustedOrigins: ["http://localhost:3000"],
      googleClientId: "",
      googleClientSecret: "",
      passwordBreachCheck: false,
    })
    const jar: Record<string, string> = {}
    function storeCookies(res: Response): void {
      for (const setCookie of res.headers.getSetCookie()) {
        const pair = setCookie.split(";")[0] ?? ""
        const at = pair.indexOf("=")
        if (at > 0) {
          const name = pair.slice(0, at).trim()
          const value = pair.slice(at + 1).trim()
          if (value === "" || value === "null") delete jar[name]
          else jar[name] = value
        }
      }
    }
    function cookieHeader(): Record<string, string> {
      const entries = Object.entries(jar).map(([name, value]) => `${name}=${value}`)
      return entries.length > 0 ? { cookie: entries.join("; ") } : {}
    }
    async function call(path: string, body: unknown): Promise<Response> {
      const res = await auth.handler(
        new Request(`http://localhost:3001/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...cookieHeader() },
          body: JSON.stringify(body),
        }),
      )
      storeCookies(res)
      return res
    }
    const clear = () => {
      for (const name of Object.keys(jar)) delete jar[name]
    }
    return { auth, call, cookieHeader, clear }
  }

  it("smoke HTTP: backup-code rota o conserva sesión y el binding ata la efectiva", async () => {
    const { auth, call, cookieHeader } = authClient()
    const email = "smoke@example.test"
    const password = "Demo1234"
    const signup = await call("/sign-up/email", { name: "Smoke", email, password, termsVersion: LEGAL_VERSION })
    expect(signup.status).toBeLessThan(300)
    await ownerDb.execute(sql`update "user" set email_verified=true where email=${email}`)
    const signin = await call("/sign-in/email", { email, password })
    expect(signin.status).toBeLessThan(300)
    const users = z.array(z.object({ id: z.string() })).parse(await ownerDb.execute(sql`select id from "user" where email=${email}`))
    const userId = users[0]?.id ?? ""
    expect(userId).not.toBe("")
    await makeStaff(userId, "support")
    const sessionBefore = await auth.api.getSession({ headers: new Headers(cookieHeader()) })
    const enableShape = z.looseObject({ totpURI: z.string(), backupCodes: z.array(z.string()) })
    const enableRes = await call("/two-factor/enable", { password, method: "totp" })
    expect(enableRes.status).toBeLessThan(300)
    const enabled = enableShape.parse(await enableRes.json())
    expect(enabled.backupCodes.length).toBeGreaterThan(0)
    const wrongRes = await call("/two-factor/verify-backup-code", { code: "00000000" })
    expect(wrongRes.status).toBeGreaterThanOrEqual(400)
    const noBinding = await getLiveSessionBinding(ownerDb, sessionBefore?.session.id ?? "sin-sesion", new Date())
    expect(noBinding).toBeNull()
    const verifyRes = await call("/two-factor/verify-backup-code", { code: enabled.backupCodes[0] })
    expect(verifyRes.status).toBeLessThan(300)
    const sessionAfter = await auth.api.getSession({ headers: new Headers(cookieHeader()) })
    expect(sessionAfter?.user.id).toBe(userId)
    const effectiveSessionId = sessionAfter?.session.id ?? ""
    expect(effectiveSessionId).not.toBe("")
    const factors = z.array(z.object({ id: z.string() })).parse(await ownerDb.execute(sql`select id from two_factor where user_id=${userId}`))
    const binding = await recordAdminSessionBinding(ownerDb, {
      userId,
      sessionId: effectiveSessionId,
      factorId: factors[0]?.id ?? "",
      method: "recovery",
      ttlMs: 30 * 60 * 1000,
    })
    expect((await getLiveSessionBinding(ownerDb, effectiveSessionId, new Date()))?.id).toBe(binding.id)
    // La sesión de entrada puede haber rotado o no según versión; el wrapper ata la efectiva.
    expect(typeof sessionBefore?.session.id).toBe("string")
  }, 120_000)

  /** Código TOTP de ahora (RFC 6238, 6 dígitos cada 30 s) para el secreto de un `otpauth://`. */
  function totpNow(totpURI: string): string {
    const secret = new URL(totpURI).searchParams.get("secret") ?? ""
    let bits = ""
    for (const char of secret.replace(/=+$/, "").toUpperCase())
      bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char).toString(2).padStart(5, "0")
    const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? [])
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
    const mac = createHmac("sha1", key).update(counter).digest()
    const offset = (mac.at(-1) ?? 0) & 0xf
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0")
  }

  it("el personal entra sin código: lo pone al abrir la administración", async () => {
    const { auth, call, cookieHeader, clear } = authClient()
    const email = "personal@example.test"
    const password = "Demo1234"
    await call("/sign-up/email", { name: "Personal", email, password, termsVersion: LEGAL_VERSION })
    await ownerDb.execute(sql`update "user" set email_verified=true where email=${email}`)
    await call("/sign-in/email", { email, password })
    const [row] = z.array(z.object({ id: z.string() })).parse(await ownerDb.execute(sql`select id from "user" where email=${email}`))
    const userId = row?.id ?? ""
    await makeStaff(userId, "admin")
    const flag = async () =>
      z.array(z.object({ on: z.boolean() })).parse(await ownerDb.execute(sql`select two_factor_enabled as on from "user" where id=${userId}`))[0]?.on

    // Enrolar como la administración: Better Auth enciende el factor al confirmar y se apaga después.
    const enabled = z.looseObject({ totpURI: z.string(), backupCodes: z.array(z.string()) }).parse(
      await (await call("/two-factor/enable", { password, method: "totp" })).json(),
    )
    expect((await call("/two-factor/verify-totp", { code: totpNow(enabled.totpURI) })).status).toBe(200)
    expect(await flag()).toBe(true)
    await keepStaffSignInWithoutFactor(ownerDb, userId)
    expect(await flag()).toBe(false)
    expect(await hasStaffFactor(ownerDb, userId)).toBe(true)

    // Entrar de nuevo no pide código: queda la sesión, sin desvío al segundo factor.
    clear()
    const again = await call("/sign-in/email", { email, password })
    expect(again.status).toBe(200)
    expect(z.looseObject({ twoFactorRedirect: z.boolean().optional() }).parse(await again.json()).twoFactorRedirect).toBeUndefined()
    expect((await auth.api.getSession({ headers: new Headers(cookieHeader()) }))?.user.id).toBe(userId)

    // En la administración el código de la app sigue valiendo y no vuelve a encender el factor.
    expect((await call("/two-factor/verify-totp", { code: totpNow(enabled.totpURI) })).status).toBe(200)
    expect(await flag()).toBe(false)

    // Códigos de respaldo nuevos: valen, y los de antes ya no.
    const { secretConfig } = await auth.$context
    const fresh = await regenerateStaffBackupCodes(ownerDb, userId, secretConfig)
    expect(fresh).toHaveLength(10)
    expect(fresh[0]).toMatch(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/)
    expect((await call("/two-factor/verify-backup-code", { code: enabled.backupCodes[0] })).status).toBeGreaterThanOrEqual(400)
    expect((await call("/two-factor/verify-backup-code", { code: fresh[0] })).status).toBe(200)
    expect(await flag()).toBe(false)
  }, 120_000)

  it("bootstrap solo sin admins e invitación nominal", async () => {
    await makeUser("u-boot", "boot@example.test")
    const actor = await bootstrapAdminStaff(ownerDb, "boot@example.test")
    expect(actor.role).toBe("admin")
    await makeUser("u-second-bootstrap", "second-boot@example.test")
    await expect(bootstrapAdminStaff(ownerDb, "second-boot@example.test")).rejects.toMatchObject({ status: 403 })
    const staffRows = await ownerDb.execute(sql`select user_id from admin_staff where active and role = 'admin'`)
    expect(z.array(z.object({ user_id: z.string() })).parse(staffRows)).toEqual([{ user_id: actor.userId }])
    const accepted = await (async () => {
      await makeUser("u-invited", "invited@example.test")
      return acceptAdminInvitation(
        ownerDb,
        { id: "u-invited", email: "invited@example.test", emailVerified: true },
        "token-invalido-que-no-existe",
      ).then(
        () => "unexpected",
        (e: unknown) => (e instanceof ServiceError ? e.code : "unexpected"),
      )
    })()
    expect(accepted).toBe("NOT_FOUND")
  }, 60_000)
})
