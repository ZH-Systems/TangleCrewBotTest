# What Was Done Today - 2026-06-22

- Removed Discord submission channel routing from the bot env and moved proof channel resolution to Supabase `events.discord_submission_channel_id`.
- Added runtime Supabase lookup with short in-memory channel-to-event caching and non-fatal failure handling for submission routing.
- Updated `/kc start` to resolve the current channel through Supabase instead of the old JSON env map.
- Repurposed `/channelmap` so it now gives admins the channel ID values to paste into the web panel instead of generating an env var snippet.
- Updated bot token/env documentation and added the new Supabase lookup variables to the README and `.env.example`.
