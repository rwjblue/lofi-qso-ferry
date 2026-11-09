-- Seek the requested set, then load each probe once for its bucket tokens.
-- The previous token-first plan looked up the same probe for every token.
DROP VIEW inventory_match_stale_tokens;
CREATE VIEW inventory_match_stale_tokens AS
 SELECT h.tenant,h.set_id
 FROM inventory_match_sets h
 CROSS JOIN inventory_match_probes p
 CROSS JOIN inventory_match_tokens t
 LEFT JOIN bucket_versions b
  ON (b.tenant,b.generation_id,b.scope_id,b.key_class,b.bucket_hash)
   =(h.tenant,h.generation_id,p.search_scope,t.key_class,t.bucket_hash)
 WHERE (p.tenant,p.set_id)=(h.tenant,h.set_id)
 AND (t.tenant,t.set_id,t.probe_id)=(p.tenant,p.set_id,p.probe_id)
 AND coalesce(b.version,0)!=t.version;
