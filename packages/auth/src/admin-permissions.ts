/**
 * Roles del personal interno de odentIA (administración global).
 *
 * Separados de OrgRole: `admin`/`support` internos no equivalen a
 * owner/admin de clínica y no otorgan membresía en ningún tenant.
 * Canónico para @odentia/services (admin-core) y el guard de la API.
 */

/** Roles internos. Ningún otro valor es staff. */
export const ADMIN_ROLES = ["admin", "support"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Etiquetas en español para la UI de equipo. */
export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  admin: "Administración",
  support: "Soporte",
};

/** Qué puede hacer cada rol interno, en español para la UI de equipo. */
export const ADMIN_ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  admin: "Acceso total: equipo, auditoría, facturación, organizaciones y soporte.",
  support: "Atiende casos de soporte con acceso delegado temporal; sin gestión de equipo.",
};

/** ¿Es `role` un rol interno válido? Falla cerrado ante desconocidos. */
export function isAdminRole(role: string): role is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

/** Solo `admin` gestiona el equipo (invitar, roles, desactivar, resets). */
export function isAdminManager(role: string): boolean {
  return role === "admin";
}
