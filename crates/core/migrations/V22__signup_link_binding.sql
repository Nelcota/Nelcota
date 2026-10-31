-- Nelcota: bind a signup confirmation to the client that signed up.
-- Contract documented in docs/schema-auth.md.
--
-- Opening a signup link proves only that someone reads the inbox. The password
-- chosen at signup may belong to whoever registered the address, so a
-- confirmation keeps it only when the client that signed up proves itself with
-- the PKCE verifier of the S256 challenge it sent; otherwise the password is
-- cleared, as for a magic link.

ALTER TABLE auth.one_time_tokens ADD COLUMN code_challenge text;
ALTER TABLE auth.one_time_tokens ADD CONSTRAINT one_time_tokens_code_challenge_check
    CHECK (code_challenge IS NULL OR (kind = 'signup' AND length(code_challenge) = 43));
