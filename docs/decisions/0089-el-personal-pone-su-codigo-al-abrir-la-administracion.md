# 0089 · El personal de odentIA pone su código al abrir la administración, no al entrar

Fecha: 2026-10-25 · Estado: aceptada · El plazo de 48 h lo reemplaza la [0090](0090-el-codigo-de-la-administracion-se-pide-solo-cuando-hace-falta.md)

## Problema

La administración exige un segundo factor ligado a la sesión. Para enrolarlo usa el `twoFactor` de Better Auth, que al confirmar el primer código enciende `user.twoFactorEnabled`. Con esa marca, Better Auth también pide el código al iniciar sesión, en el panel y en cualquier clínica. Así el personal ponía el código dos veces seguidas: al entrar y otra vez al abrir la administración, que no se entera del primero. Además se le pedía para entrar a una clínica, donde nadie más lo usa.

## Decisión y motivo

- **El código se pide al abrir la administración y vale 48 horas en esa sesión** (`ADMIN_MFA_SESSION_TTL_MS`; antes 12 h). Un código de respaldo sigue valiendo 30 minutos y obliga a enrolar de nuevo.
- **Al entrar no se pide.** Al confirmar el enrolamiento, la administración apaga la marca (`keepStaffSignInWithoutFactor`) y la migración `0002` la apaga a quien ya la tenía. El factor (`two_factor` verificado) no cambia: la administración lo sigue verificando con `verifyTOTP` y `verifyBackupCode` de Better Auth, que no miran la marca.
- **Los códigos de respaldo los regenera la administración** (`regenerateStaffBackupCodes`), con el mismo formato y cifrados como los guarda Better Auth, después de probar la contraseña con `verifyPassword`: el endpoint nativo exige la marca.

## Alternativas descartadas

- **Que el código del inicio de sesión valga también para la administración.** El personal seguiría poniéndolo para entrar a una clínica.
- **Verificar el código fuera de Better Auth.** Habría que copiar su verificación y sus bloqueos por intentos; la suya funciona sin la marca.

## Consecuencias

- Beneficio: un solo código cada 48 horas, y solo para lo que lo necesita.
- Sacrificio: con la contraseña sola se entra a las clínicas del personal, como cualquier dueño de clínica, que hoy no tiene segundo factor. La administración sigue cerrada sin el código.
- Revisar si las clínicas pueden activar su propio segundo factor: a quien lo active se le pediría al entrar, y el personal debería seguir sin la marca.

## Referencias

`apps/api/src/routes/admin-core.ts` (`/mfa/enroll/confirm`, `/challenge/verify`, `/mfa/backup-codes`), `packages/services/src/admin-core.ts`, `packages/db/drizzle/0002_staff_sign_in_without_factor.sql` y la prueba «el personal entra sin código» de `packages/services/src/admin-core.test.ts`.
