/**
 * Matriz de roles y permisos por dominio (fuente única API/UI).
 *
 * BetterAuth sigue siendo la identidad (sesión, membresías, invitaciones);
 * este módulo decide QUÉ puede hacer cada rol en cada dominio. La API lo
 * consume con `canAccess` y la plataforma con `usePermission`.
 *
 * Dominios: patients (filiación administrativa), clinical (ficha clínica),
 * appointments (agenda operativa), crm (contactos, oportunidades, campos),
 * conversations (bandeja y mensajes), tasks (tareas), finance (caja y cobros),
 * inventory (existencias), reports (reportes), settings (configuración),
 * audit (auditoría), agent (agente IA). Cada dominio tiene `.read`/`.write`,
 * salvo el agente que además expone `agent.decide`: decidir/ejecutar/
 * confirmar propuestas operativas del propio dominio del acto (agenda, CRM,
 * conversaciones). `agent.write` queda reservado a administrar el agente
 * (configuración, conocimiento, simulación); `agent.read` a supervisar.
 *
 * `tasks.all` (ver las tareas de toda la clínica, no solo las propias y las de
 * su área) es solo de propietario y administrador.
 *
 * `clinical.alerts` es la única excepción acotada: quien recibe al paciente ve
 * sus alergias activas (declaradas en el registro o validadas), nunca el resto
 * de la ficha. No implica `clinical.read`.
 *
 * Invariante: lo clínico (`clinical.read`/`.write`) nunca se entrega a
 * recepción/caja y lo financiero (`finance.*`) nunca a recepción/clínica.
 * Presupuestos y comisiones tienen permisos propios; el servidor además limita
 * al odontólogo a su plan y sus comisiones. `member` es el mínimo seguro.
 * Rol o permiso desconocido siempre deniega, incluso para owner/admin.
 */

/** Roles de membresía de la organización. */
export const ORG_ROLES = ["owner", "admin", "reception", "dentist", "cashier", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Dominios con permisos `.read`/`.write`. */
export const PERMISSION_DOMAINS = [
  "patients",
  "clinical",
  "appointments",
  "crm",
  "conversations",
  "tasks",
  "finance",
  "budgets",
  "commissions",
  "inventory",
  "reports",
  "settings",
  "audit",
  "agent",
] as const;
export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];
export type Permission =
  | `${PermissionDomain}.${"read" | "write"}`
  | "agent.decide"
  | "clinical.alerts"
  | "budgets.decide"
  | "finance.close"
  | "finance.admin"
  | "tasks.all"
  | "catalog.read";

/** Etiquetas en español para la UI de miembros. */
export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: "Propietario",
  admin: "Administrador",
  reception: "Recepción",
  dentist: "Odontólogo",
  cashier: "Caja",
  member: "Miembro",
};

/** Qué hace cada rol, en español para la UI de miembros. */
export const ROLE_DESCRIPTIONS: Record<OrgRole, string> = {
  owner: "Puede hacer todo, también nombrar o quitar a otros propietarios.",
  admin: "Puede hacer todo en la clínica, menos nombrar o quitar propietarios.",
  reception:
    "Registra pacientes y lleva la agenda, los contactos y oportunidades, las conversaciones y las tareas; decide lo que el agente le consulta sobre eso. Ve las alergias del paciente, pero no su historia clínica, la caja ni la configuración del agente.",
  dentist: "Pacientes, historia clínica, presupuestos de sus planes, sus propias comisiones, agenda, conversaciones y tareas. Sin caja ni contactos y oportunidades.",
  cashier: "Ve a los pacientes, lleva la caja, registra la respuesta a los presupuestos y ve las tareas. Sin historia clínica ni agenda.",
  member: "Acceso mínimo: solo ve las tareas.",
};

const ALL_PERMISSIONS: Permission[] = [
  ...PERMISSION_DOMAINS.flatMap((domain) => [
    `${domain}.read` as Permission,
    `${domain}.write` as Permission,
  ]),
  "agent.decide",
  "clinical.alerts",
  "budgets.decide",
  "finance.close",
  "finance.admin",
  "tasks.all",
  "catalog.read",
];

/**
 * Permisos explícitos por rol. owner/admin no figuran: tienen todo permiso
 * conocido (ver `canAccess`). Nada aquí otorga gestión de propietarios de
 * BetterAuth; eso lo refuerza el plugin organization (roles operativos sin
 * `member:update`/`invitation:create`).
 */
const ROLE_PERMISSIONS: Record<Exclude<OrgRole, "owner" | "admin">, readonly Permission[]> = {
  reception: [
    "patients.read",
    "patients.write",
    "appointments.read",
    "appointments.write",
    "crm.read",
    "crm.write",
    "conversations.read",
    "conversations.write",
    "tasks.read",
    "tasks.write",
    "agent.decide",
    "clinical.alerts",
    "catalog.read",
  ],
  dentist: [
    "patients.read",
    "clinical.read",
    "clinical.write",
    "budgets.read",
    "budgets.write",
    "budgets.decide",
    "commissions.read",
    "catalog.read",
    "appointments.read",
    "appointments.write",
    "conversations.read",
    "conversations.write",
    "tasks.read",
    "tasks.write",
  ],
  cashier: [
    "patients.read",
    "finance.read",
    "finance.write",
    "finance.close",
    "budgets.read",
    "budgets.decide",
    "catalog.read",
    "tasks.read",
    "tasks.write",
  ],
  member: ["tasks.read"],
};

function normalizeRole(role: string): OrgRole | null {
  const normalized = role.trim().toLowerCase();
  return (ORG_ROLES as readonly string[]).includes(normalized) ? (normalized as OrgRole) : null;
}

function isPermission(permission: string): permission is Permission {
  if (
    permission === "agent.decide" ||
    permission === "clinical.alerts" ||
    permission === "budgets.decide" ||
    permission === "finance.close" ||
    permission === "finance.admin" ||
    permission === "tasks.all" ||
    permission === "catalog.read"
  ) return true;
  const separator = permission.lastIndexOf(".");
  if (separator < 0) return false;
  const domain = permission.slice(0, separator);
  const action = permission.slice(separator + 1);
  return (
    (PERMISSION_DOMAINS as readonly string[]).includes(domain) && (action === "read" || action === "write")
  );
}

/**
 * ¿Puede `role` ejercer `permission`? Falla cerrado ante rol o permiso
 * desconocido. owner/admin tienen todo permiso conocido.
 */
export function canAccess(role: string, permission: string): boolean {
  if (!isPermission(permission)) return false;
  const normalized = normalizeRole(role);
  if (!normalized) return false;
  if (normalized === "owner" || normalized === "admin") return true;
  return ROLE_PERMISSIONS[normalized].includes(permission);
}

/** ¿Puede `role` ejercer al menos uno de `permissions`? (puertas O). */
export function canAccessAny(role: string, permissions: readonly string[]): boolean {
  return permissions.some((permission) => canAccess(role, permission));
}

/** Roles que `memberRole` puede asignar a otros (sin escalada propia). */
export function assignableRoles(memberRole: string): OrgRole[] {
  const normalized = normalizeRole(memberRole);
  if (normalized === "owner") return [...ORG_ROLES];
  if (normalized === "admin") return ORG_ROLES.filter((role) => role !== "owner");
  return [];
}

export { ALL_PERMISSIONS };

interface PlatformPathRule {
  prefix: string;
  permissions: Permission[];
}

/**
 * Mapa ruta de plataforma → permisos de lectura para el guard de `_org`
 * (la navegación lo consume para filtrar con `canAccessAny`; cada pantalla
 * re-verifica con `usePermission`). Rutas en inglés, `null` = pública o
 * fuera del panel. El tarifario lo ven clínica, agenda, caja y ajuste.
 */
const PLATFORM_PATH_RULES: PlatformPathRule[] = [
  { prefix: "/agenda", permissions: ["appointments.read"] },
  // La página de cada persona y la lista única (ADR 0029): cada bloque pide
  // su propio permiso al servidor; entrar es de quien ve a las personas.
  { prefix: "/people", permissions: ["patients.read"] },
  // La ficha del paciente redirige a su persona; la atención y las
  // impresiones siguen colgando de aquí.
  { prefix: "/patients", permissions: ["patients.read"] },
  { prefix: "/inbox", permissions: ["conversations.read"] },
  // Dirección antigua de Contactos: solo redirige a la página de la persona.
  { prefix: "/contacts", permissions: ["patients.read"] },
  { prefix: "/opportunities", permissions: ["crm.read"] },
  { prefix: "/pipeline", permissions: ["crm.read"] },
  { prefix: "/tasks", permissions: ["tasks.read"] },
  { prefix: "/services", permissions: ["catalog.read"] },
  { prefix: "/commissions", permissions: ["commissions.read"] },
  { prefix: "/finance", permissions: ["finance.read"] },
  { prefix: "/inventory", permissions: ["inventory.read"] },
  { prefix: "/reports", permissions: ["reports.read"] },
  // Regla específica antes de la genérica: la auditoría vive bajo Configuración
  // pero la consulta quien tiene `audit.read`.
  { prefix: "/settings/audit", permissions: ["audit.read"] },
  // Regla específica antes de la genérica: las aprobaciones operativas las
  // resuelve quien decide (`agent.decide`), no solo quien supervisa.
  { prefix: "/agent/pendientes", permissions: ["agent.read", "agent.decide"] },
  // La dirección vieja de «Pendientes» solo redirige; conserva la misma regla.
  { prefix: "/agent/approvals", permissions: ["agent.read", "agent.decide"] },
  { prefix: "/agent", permissions: ["agent.read"] },
  // Regla específica antes de la genérica: el modelo del agente se abre desde
  // Integraciones, pero lo cambia quien administra el agente.
  { prefix: "/settings/integrations/model", permissions: ["agent.write"] },
  // Reglas específicas antes de la genérica: etapas de venta y campos de
  // contacto son parte del trabajo diario de ventas; los define también quien
  // trabaja con oportunidades y contactos (`crm.write`), no solo quien configura.
  { prefix: "/settings/pipelines", permissions: ["settings.read", "crm.write"] },
  { prefix: "/settings/fields", permissions: ["settings.read", "crm.write"] },
  // Sedes, Equipo e Integraciones viven bajo Configuración: los cubre esta regla.
  { prefix: "/settings", permissions: ["settings.read"] },
  // Direcciones antiguas de Equipo y Sedes: solo redirigen a `/settings/team` y
  // `/settings/branches`, y piden lo mismo que su destino.
  { prefix: "/members", permissions: ["settings.read"] },
  { prefix: "/branches", permissions: ["settings.read"] },
];

export function platformPathPermission(pathname: string): Permission[] | null {
  return (
    PLATFORM_PATH_RULES.find(
      (rule) => pathname === rule.prefix || pathname.startsWith(`${rule.prefix}/`),
    )?.permissions ?? null
  );
}
