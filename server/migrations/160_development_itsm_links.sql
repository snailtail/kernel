-- Links between development and service management (#167, epic #164), part 1.
--
-- How a problem's permanent fix is made. Only a code fix becomes a bug in the development module; a configuration,
-- infrastructure, supplier or process fix goes to a change directly, and accept_risk is the existing risk decision.
-- Empty until someone decides.
ALTER TABLE problems ADD COLUMN fix_type text CHECK (fix_type IN ('code', 'configuration', 'infrastructure', 'supplier', 'process', 'accept_risk'));

-- A work item links the problems, incidents, changes, improvements and requests it belongs to, whichever side the
-- link was made from. The policy from 158 already hides a link to a Kernel record the caller cannot see.
ALTER TABLE work_item_links DROP CONSTRAINT work_item_links_kind_check;
ALTER TABLE work_item_links ADD CONSTRAINT work_item_links_kind_check
  CHECK (kind IN ('work_item', 'document', 'problem', 'incident', 'change', 'improvement', 'request'));
