ALTER TABLE customer_plan_changes
    ADD COLUMN IF NOT EXISTS target_access_quantity integer,
    ADD COLUMN IF NOT EXISTS target_variant_kind text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='customer_plan_changes_access_quantity_check'
    ) THEN
        ALTER TABLE customer_plan_changes
            ADD CONSTRAINT customer_plan_changes_access_quantity_check
            CHECK (target_access_quantity IS NULL OR target_access_quantity > 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='customer_plan_changes_variant_kind_check'
    ) THEN
        ALTER TABLE customer_plan_changes
            ADD CONSTRAINT customer_plan_changes_variant_kind_check
            CHECK (target_variant_kind IS NULL OR target_variant_kind IN ('streams','households'));
    END IF;
END $$;
