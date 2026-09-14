import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Cifrado de secretos de conexión (config de proveedor) con AES-256-GCM.
 * Formato: `v1.{iv}.{tag}.{ct}`, todo base64.
 */
export function secretsKeyFromEnv(raw: string | undefined): Buffer {
  if (!raw) throw new Error("SECRETS_KEY no configurada (openssl rand -hex 32)");
  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), "hex");
  } catch {
    throw new Error("SECRETS_KEY inválida: se esperan 32 bytes en hex");
  }
  if (key.length !== 32) throw new Error("SECRETS_KEY inválida: se esperan 32 bytes en hex");
  return key;
}

export function encryptJson(key: Buffer, obj: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = JSON.stringify(obj);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (b: Buffer): string => b.toString("base64");
  return `v1.${b64(iv)}.${b64(tag)}.${b64(ct)}`;
}

export function decryptJson(key: Buffer, sealed: string): unknown {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !parts[1] || !parts[2] || !parts[3]) {
    throw new Error("Secreto cifrado con formato inválido");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as unknown;
  } catch {
    throw new Error("No se pudo descifrar el secreto (clave incorrecta o datos corruptos)");
  }
}

/** Descifra y exige un objeto de configuración (frontera validada). */
export function decryptConfig(key: Buffer, sealed: string): Record<string, unknown> {
  const value: unknown = decryptJson(key, sealed);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Configuración de conexión con formato inválido");
  }
  // Invariante de frontera: ya se probó que es objeto no-array.
  const config = value as Record<string, unknown>;
  return config;
}
