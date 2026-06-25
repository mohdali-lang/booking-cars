// =============================================================================
// Amlak One — Driver Reservation System :: CONFIG
// Fill these two values from: Supabase Dashboard > Project Settings > API
// (The anon key is safe to expose in the browser — RLS protects your data.)
// =============================================================================
window.CONFIG = {
  SUPABASE_URL: "https://kvrkmzkkyxtssjkkhfob.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_LWA9SDsD43B0tZI6emS6dw_XrSWXnuB",

  // Default booking length (hours) used when no return time is given.
  // Must match the DB conflict-window default (2h) for accurate UI hints.
  DEFAULT_TRIP_HOURS: 2,

  COMPANY_NAME: "Amlak One",
};
