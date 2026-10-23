-- Service-wide request budgets survive overlapping Workers and cron runs.
CREATE TABLE vendor_requests (
 vendor TEXT PRIMARY KEY CHECK(vendor IN('lofi','qrz','lotw')),
 window_start INTEGER NOT NULL,
 requests INTEGER NOT NULL DEFAULT 0 CHECK(requests>=0),
 background_requests INTEGER NOT NULL DEFAULT 0 CHECK(background_requests>=0),
 cooldown_until INTEGER NOT NULL DEFAULT 0
);

-- Keep readback of an imported upload in the same background traffic class.
ALTER TABLE attempt_state ADD COLUMN priority TEXT NOT NULL DEFAULT 'background' CHECK(priority IN('live','background'));
