ALTER TABLE "vault_tokens" DROP CONSTRAINT "vault_tokens_payment_token_id_unique";--> statement-breakpoint
CREATE INDEX "vault_tokens_payment_token" ON "vault_tokens" USING btree ("payment_token_id");--> statement-breakpoint
ALTER TABLE "vault_tokens" ADD CONSTRAINT "vault_tokens_user_payment_token" UNIQUE("user_id","payment_token_id");