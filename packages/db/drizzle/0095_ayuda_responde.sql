CREATE TABLE "catalog"."help_video" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product" text NOT NULL,
	"youtube_id" text NOT NULL,
	"title" text NOT NULL,
	"duration_seconds" integer,
	"published_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gone" boolean DEFAULT false NOT NULL,
	CONSTRAINT "help_video_product_check" CHECK ("catalog"."help_video"."product" IN ('dental','medical','optical')),
	CONSTRAINT "help_video_duration_check" CHECK ("catalog"."help_video"."duration_seconds" is null or "catalog"."help_video"."duration_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "catalog"."help_video_link" (
	"video_id" uuid NOT NULL,
	"target" text NOT NULL,
	"start_seconds" integer,
	"known" boolean DEFAULT true NOT NULL,
	"answer_hash" text,
	"review" boolean DEFAULT false NOT NULL,
	CONSTRAINT "help_video_link_video_id_target_pk" PRIMARY KEY("video_id","target"),
	CONSTRAINT "help_video_link_start_check" CHECK ("catalog"."help_video_link"."start_seconds" is null or "catalog"."help_video_link"."start_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "help_ask" DROP CONSTRAINT "help_ask_verdict_check";--> statement-breakpoint
ALTER TABLE "help_ask" ADD COLUMN "area" text;--> statement-breakpoint
ALTER TABLE "help_ask" ADD COLUMN "written" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "help_ask" ADD COLUMN "none_fits" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."help_video_link" ADD CONSTRAINT "help_video_link_video_id_help_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "catalog"."help_video"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "help_video_product_youtube_uidx" ON "catalog"."help_video" USING btree ("product","youtube_id");--> statement-breakpoint
CREATE INDEX "help_video_link_target_idx" ON "catalog"."help_video_link" USING btree ("target");--> statement-breakpoint
ALTER TABLE "help_ask" ADD CONSTRAINT "help_ask_verdict_check" CHECK ("help_ask"."verdict" is null or "help_ask"."verdict" in ('seguro','duda','ninguna','datos','redactada'));