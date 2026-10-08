-- Generated initial passwords must be changed at first login.
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
