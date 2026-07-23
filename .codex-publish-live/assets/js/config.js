// Supabase public browser config.
// This file may safely use the anon public key. Never paste a service role key here.
const NEXUS_SUPABASE_PROJECT_URL = "https://vzgblkghicyozoxkljga.supabase.co";
// To make Google OAuth say "continue to nexus-ai.software", set this to a verified
// Supabase custom domain such as https://auth.nexus-ai.software, then add
// https://auth.nexus-ai.software/auth/v1/callback to the Google OAuth client.
const NEXUS_SUPABASE_PUBLIC_URL = NEXUS_SUPABASE_PROJECT_URL;
const NEXUS_FUNCTIONS_BASE_URL = `${NEXUS_SUPABASE_PROJECT_URL}/functions/v1`;
const NEXUS_SITE_URL = "https://nexus-ai.software";

window.NEXUS_CONFIG = {
  SITE_URL: NEXUS_SITE_URL,
  NEXUS_SITE_URL,
  SUPABASE_URL: NEXUS_SUPABASE_PUBLIC_URL,
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6Z2Jsa2doaWN5b3pveGtsamdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzMTc4NDcsImV4cCI6MjA5Mzg5Mzg0N30.zbZ7DjmSw0lUwur-WyZC71QG-8ijRj71OtA7AJbwl9o"
};
