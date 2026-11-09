-- This deployment-level control is exposed only through administrator settings.
CREATE TABLE inventory_retention_policy (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 settled_retention_days INTEGER NOT NULL DEFAULT 90 CHECK(typeof(settled_retention_days)='integer' AND settled_retention_days BETWEEN 1 AND 3650)
);
INSERT INTO inventory_retention_policy(singleton) VALUES(1);
