GRANT USAGE ON SCHEMA pgmq TO dentalagent_app;--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO dentalagent_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgmq TO dentalagent_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE dentalagent IN SCHEMA pgmq GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dentalagent_app;
