-- M7: Defense-in-depth tenant isolation.
--
-- Enable RLS on every tenant-scoped table and revoke direct access from the
-- anon + authenticated roles. The InsForge service-role API key bypasses RLS,
-- so server-side queries (which authenticate with INSFORGE_API_KEY) still work.
--
-- After this, a leaked anon key cannot read or write tenant data.

ALTER TABLE workspaces   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE runbooks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_users     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_groups    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_accounts  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON workspaces  FROM anon, authenticated;
REVOKE ALL ON tickets     FROM anon, authenticated;
REVOKE ALL ON runbooks    FROM anon, authenticated;
REVOKE ALL ON ad_users    FROM anon, authenticated;
REVOKE ALL ON ad_groups   FROM anon, authenticated;
REVOKE ALL ON ad_accounts FROM anon, authenticated;
