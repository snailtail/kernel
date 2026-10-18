-- Dev platforms (part 1 of #32): GitLab (gitlab.com and self-hosted) and Azure DevOps on the same model as GitHub.
ALTER TABLE dev_sources DROP CONSTRAINT dev_sources_platform_check;
ALTER TABLE dev_sources ADD CONSTRAINT dev_sources_platform_check CHECK (platform IN ('github', 'gitlab', 'azure_devops'));
-- Where the platform's links live: https://github.com, https://gitlab.com or a self-hosted GitLab, https://dev.azure.com.
ALTER TABLE dev_sources ADD COLUMN base_url text NOT NULL DEFAULT 'https://github.com';
-- A self-hosted GitLab on the private network: the private ranges it may be reached on, and its CA certificate.
ALTER TABLE dev_sources ADD COLUMN private_allow text[] NOT NULL DEFAULT '{}';
ALTER TABLE dev_sources ADD COLUMN ca_pem text;
ALTER TABLE dev_items ADD CONSTRAINT dev_items_platform_check CHECK (platform IN ('github', 'gitlab', 'azure_devops'));
