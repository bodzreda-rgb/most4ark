# Step 1 — Project Inspection (Mostshark / مستشارك)

Date: 2026-10-18

## Findings
- No existing Mostshark project was found on the Desktop (searched for mostshark / mustashar variants). This is a **greenfield** build.
- Created `Desktop/mostshark/` as the project root, with `docs/`.
- Other Desktop folders (Belya, MOBILE APP, HPC labs, etc.) are unrelated and were not touched.
- Flutter/Dart are **not available** in the sandbox shell I work from, so I cannot run `flutter create`, `flutter analyze` or `flutter test` here. They must run on your Windows machine (see "Required on your machine").
- Reusable components: none yet.

## Required on your machine
1. Flutter SDK (stable) + Dart, with `flutter doctor` passing (Chrome for web, Android Studio or VS Code).
2. Git.
3. A Supabase project (free tier is fine) and the Supabase CLI (for migrations and Edge Functions).
4. Firebase project (FCM) — only needed later, at Step 10.
5. A maps provider key (decision pending, see below) — only needed at Step 6.

## Decisions needing your input before Step 3
- **Maps provider:** OpenStreetMap via `flutter_map` (no key, free) vs Google Maps (key + billing). Default: flutter_map + OSM.
- **Public alias format:** default `Advocate #A1xxx` (configurable in platform settings).
- **Targets for first release:** Android + Web (admin dashboard on web) by default; iOS/desktop later.
