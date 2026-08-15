BEGIN;

ALTER TABLE reseller_sales DROP CONSTRAINT IF EXISTS reseller_sales_amount_minor_check;
ALTER TABLE reseller_sales
    ADD CONSTRAINT reseller_sales_amount_minor_check
    CHECK (
        (sale_type='adjustment' AND amount_minor BETWEEN -1000000000 AND 1000000000)
        OR (sale_type<>'adjustment' AND amount_minor >= 0)
    );

CREATE INDEX IF NOT EXISTS reseller_sales_parent_type_idx
    ON reseller_sales(parent_sale_id,sale_type,created_at);

COMMIT;
