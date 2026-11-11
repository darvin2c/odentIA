-- Los videos de la Ayuda (ADR 0178): lo que TS no declara. Son de odentIA y la aplicación
-- solo los lee (ADR 0063): los escribe el worker con la conexión propietaria, al leer YouTube.
GRANT SELECT ON TABLE catalog.help_video TO dentalagent_app;--> statement-breakpoint
GRANT SELECT ON TABLE catalog.help_video_link TO dentalagent_app;
