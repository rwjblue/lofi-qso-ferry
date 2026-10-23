-- LoTW validates signing-certificate authority when processing uploads.
-- Remove only the obsolete shared public-root cache; credentials are unchanged.
DROP TABLE IF EXISTS lotw_trust_cache;
