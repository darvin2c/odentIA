# Paquetes compartidos

Cada paquete tiene una responsabilidad; no importar apps desde paquetes ni duplicar contratos del dominio.

| Paquete | Responsabilidad y límite |
| --- | --- |
| `services` | Operaciones de negocio transaccionales; no HTTP ni UI. Leer sus reglas locales. |
| `db` | Esquema, RLS, migraciones y catálogos; no parches manuales del esquema. |
| `auth` | Identidad, membresías y permisos canónicos; ocultar UI no sustituye autorización. |
| `channels` | Normalizar proveedores/capacidades; no decidir identidad clínica o reglas comerciales. |
| `agent` | Contexto autorizado, razonamiento y herramientas; efectos mediante servicios y políticas. |
| `clinical` | Utilidades clínicas compartidas; no una historia paralela ni otra capa de persistencia. |
| `mail` | Correo transaccional de la plataforma; distinto del buzón omnicanal de una organización. |
| `ui` | Primitivas visuales y accesibles sin negocio. |
| `ui-patterns` | Composiciones reutilizables, con stories; las apps deciden sus datos y permisos. |

## Contratos particulares

- Better Auth: conservar explícitamente `ownerAc`, `adminAc` y `memberAc` al personalizar roles. Recepción no recibe historia clínica ni caja; odontología no recibe caja. Única excepción: `clinical.alerts` entrega a recepción las alergias activas del paciente, nunca el resto de la ficha. `agent.decide` no implica administrar el agente ni autorizar cualquier acto.
- Passwords: scrypt de `better-auth/crypto` (`hashPassword`); no otro hasher.
- Canales: verificar autenticidad de eventos, normalizar entrada y preservar estados de entrega. No tratar encolado como aceptación del proveedor.
- Reasignar identidad de canal conserva pacientes, oportunidades y seguimientos comerciales en origen y desvincula el hilo; solo tareas operativas sin oportunidad pueden acompañarlo. Auditar vínculos conciliados.
