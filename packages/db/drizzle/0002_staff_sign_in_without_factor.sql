-- El personal de odentIA pone su código al abrir la administración, no al
-- entrar: Better Auth lo pide al iniciar sesión a toda cuenta con
-- two_factor_enabled, que se encendía al confirmar el factor. Su factor
-- (two_factor verificado) no cambia: es el que vale para la administración.
UPDATE "user" SET two_factor_enabled = false
WHERE two_factor_enabled AND id IN (SELECT user_id FROM admin_staff);
