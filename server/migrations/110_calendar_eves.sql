-- Christmas, New Year's and Midsummer Eve are customary days off in Sweden, not public holidays (#43 review):
-- each calendar decides whether they count as closed.
ALTER TABLE business_calendars ADD COLUMN include_customary boolean NOT NULL DEFAULT true;
