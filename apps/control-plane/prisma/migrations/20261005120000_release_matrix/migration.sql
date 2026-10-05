-- P7-04d: the component version matrix published with every release (UPD-006).
ALTER TABLE "releases" ADD COLUMN "matrix" JSONB;
