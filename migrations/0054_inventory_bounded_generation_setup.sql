-- Generation creation and source configuration changes already enroll/reset
-- bounded index builds. Every new/configuration-changed ordinary index row
-- atomically queues its own projection work during bounded build publication.
-- Do not also walk every retained operation in those setup transactions.
-- Operation/event mutations during a build retain their narrow enqueue triggers.
DROP TRIGGER inventory_projection_job_generation;
DROP TRIGGER inventory_projection_job_scope;
