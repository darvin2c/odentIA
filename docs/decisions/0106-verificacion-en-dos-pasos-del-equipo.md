# 0106 · Verificación en dos pasos del equipo de la clínica

Fecha: 2026-10-29 · Estado: aceptada · Lienzo «Verificación en dos pasos del equipo», aprobado el 2026-10-29.

## Problema

El equipo de una clínica (recepción, clínicos, caja) entraba solo con contraseña, aunque ve historias clínicas y cobros. Better Auth ya tenía el segundo factor activo y el inicio de sesión ya pedía el código a quien lo tuviera, pero solo la administración de odentIA podía activarlo. La clínica necesita poder pedirlo a todo su equipo sin que una clínica pequeña quede obligada a algo que no eligió, y sin depender de soporte cuando alguien pierde el teléfono.

## Decisión y motivo

- **Solo app autenticadora** (TOTP, RFC 6238), la que la persona prefiera; se recomiendan Google Authenticator y Microsoft Authenticator porque guardan copia en la cuenta y cambiar de teléfono no deja a nadie fuera. Sin SMS ni correo como segundo factor: cuestan, y el SMS se puede desviar. Los 10 códigos de respaldo de Better Auth son la salida de emergencia, no otro método.
- **Es de la persona**: se activa en Mi perfil y vale para todas sus clínicas. Puede recordar un navegador 30 días (`trustDevice` de Better Auth).
- **La clínica decide si la exige** (`org_profile.require_two_factor`, apagado por defecto), desde Equipo, con permiso `settings.write`. Encenderla exige que quien lo hace ya la tenga.
- **La exige el servidor**: `requireOrgContext` responde 403 `TWO_FACTOR_REQUIRED` en todo lo de esa clínica a quien no la tiene; la app lo lleva a activarla. Por clínica: otra clínica de la misma persona no cambia. Better Auth rechaza desactivarla (`/two-factor/disable`) mientras una de sus clínicas la exija.
- **Restablecer a alguien** (perdió teléfono y códigos) lo hace la propia clínica con `settings.write` y un motivo: borra su factor, sus navegadores recordados y sus sesiones, y queda en Actividad del equipo. No alcanza al personal de odentIA, cuyo factor es también el de la administración.

## Alternativas descartadas

- Una página «Seguridad» aparte en Configuración: el propietario necesita ver quién la tiene para decidir; en Equipo ve las dos cosas juntas.
- Obligatoria para todos: una clínica de una sola recepcionista lo viviría como un obstáculo.
- Restablecer solo desde soporte de odentIA: deja a la clínica sin atender mientras espera.

## Consecuencias

- Quien entra desde un equipo compartido de recepción no debe recordar el navegador; la pantalla lo advierte.
- Las sesiones abiertas antes de activar la exigencia de quien ya tenía la verificación siguen valiendo: se abrieron con su código.
- El personal de odentIA que también es miembro de una clínica que la exige comparte un único factor: activarlo en Mi perfil reemplaza la clave de su app.

## Referencias

`packages/services/src/team-two-factor.ts`, `apps/api/src/routes/team-two-factor.ts`, `apps/api/src/lib/context.ts` (`requireOrgContext`), `packages/auth/src/index.ts` (desactivar bloqueado), `apps/panel/src/routes/_app/profile.tsx`, `packages/clinic-app/src/routes/_org/settings.team.tsx`.
