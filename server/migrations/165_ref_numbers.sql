-- Refs were prefix || lpad(seq, 6, '0'), but lpad truncates a longer string: after 999 999 the next incident got
-- INC100000 (and the one after that a duplicate key), never INC1000000 (#229). kernel_ref keeps six digits, zero
-- padded, and writes larger numbers in full, so refs grow to seven digits and more. REF_DIGITS in records.ts matches it.

CREATE FUNCTION kernel_ref(prefix text, n bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT prefix || CASE WHEN n < 1000000 THEN lpad(n::text, 6, '0') ELSE n::text END
$$;

ALTER TABLE problems ALTER COLUMN ref SET DEFAULT kernel_ref('PRB', nextval('problem_ref_seq'));
ALTER TABLE incidents ALTER COLUMN ref SET DEFAULT kernel_ref('INC', nextval('incident_ref_seq'));
ALTER TABLE changes ALTER COLUMN ref SET DEFAULT kernel_ref('CHG', nextval('change_ref_seq'));
ALTER TABLE incident_reviews ALTER COLUMN ref SET DEFAULT kernel_ref('PIR', nextval('incident_review_ref_seq'));
ALTER TABLE improvements ALTER COLUMN ref SET DEFAULT kernel_ref('IMP', nextval('improvement_ref_seq'));
ALTER TABLE requests ALTER COLUMN ref SET DEFAULT kernel_ref('REQ', nextval('request_ref_seq'));
ALTER TABLE work_items ALTER COLUMN ref SET DEFAULT kernel_ref('WI', nextval('work_item_ref_seq'));
