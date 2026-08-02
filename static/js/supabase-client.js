// Public anon key — safe to expose client-side; access is enforced by RLS policies on the DB.
const SUPABASE_URL = "https://lbgtdhzwcqztxocygbgw.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxiZ3RkaHp3Y3F6dHhvY3lnYmd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1ODA2OTgsImV4cCI6MjEwMTE1NjY5OH0.xtAcFzuJh8HAp9OTrLl2eFzOWgmHgueVO2974GhU1a0";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
