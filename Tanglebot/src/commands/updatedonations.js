const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const axios = require('axios');
const ExcelJS = require('exceljs');
const { readJson, writeJson } = require('../utils/db');

const TEMPLAR_ROLE_ID = process.env.TEMPLAR_ROLE_ID;

// Donation tiers ordered highest → lowest so we label each entry with the highest earned tier.
// Thresholds are read from env at startup; defaults match the .env.example values.
const DONATION_TIERS = [
  {
    name:      'Zenyte',
    threshold: parseInt(process.env.DONATION_ZENYTE_THRESHOLD  ?? '300000000', 10),
    roleEnv:   'DONATION_ZENYTE_ROLE_ID',
    emojiEnv:  'DONATION_EMOJI_ZENYTE',
  },
  {
    name:      'Diamond',
    threshold: parseInt(process.env.DONATION_DIAMOND_THRESHOLD ?? '150000000', 10),
    roleEnv:   'DONATION_DIAMOND_ROLE_ID',
    emojiEnv:  'DONATION_EMOJI_DIAMOND',
  },
  {
    name:      'Gold',
    threshold: parseInt(process.env.DONATION_GOLD_THRESHOLD    ??  '75000000', 10),
    roleEnv:   'DONATION_GOLD_ROLE_ID',
    emojiEnv:  'DONATION_EMOJI_GOLD',
  },
];

// Build a Discord custom-emoji string; falls back to empty string if the ID isn't set.
function customEmoji(id, name) {
  return id ? `<:${name}:${id}>` : '';
}

function tierEmoji(tier) {
  return customEmoji(process.env[tier.emojiEnv], tier.name.toLowerCase());
}

const COINS_EMOJI = '💰';

// Handles raw numbers, "300M", "150m", "75,000,000", etc.
function parseDonationAmount(raw) {
  const str = String(raw).trim().toUpperCase().replace(/,/g, '');
  if (!str) return 0;
  const m = str.match(/^([\d.]+)\s*([KMBT]?)$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const suffix = m[2];
  if (suffix === 'K') return Math.round(n * 1_000);
  if (suffix === 'M') return Math.round(n * 1_000_000);
  if (suffix === 'B') return Math.round(n * 1_000_000_000);
  if (suffix === 'T') return Math.round(n * 1_000_000_000_000);
  return Math.round(n);
}

function formatGP(amount) {
  if (amount % 1_000_000_000 === 0) return `${amount / 1_000_000_000}B`;
  if (amount % 1_000_000 === 0)     return `${amount / 1_000_000}M`;
  if (amount % 100_000 === 0)       return `${amount / 1_000_000}M`; // e.g. 77,500,000 → 77.5M
  if (amount % 1_000 === 0)         return `${(amount / 1_000).toLocaleString('en-US')}K`;
  return amount.toLocaleString('en-US');
}

function normalise(str) {
  return String(str).toLowerCase().replace(/[\s_-]/g, '');
}

async function fetchDonations() {
  const shareUrl = process.env.DONATIONS_SHEET_URL;
  if (!shareUrl) throw new Error('DONATIONS_SHEET_URL is not set in .env');

  // Normalise Google Sheets URLs — extract the sheet ID and build the export URL,
  // so edit links, share links, and export links all work the same way.
  let downloadUrl;
  const sheetsMatch = shareUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (sheetsMatch) {
    downloadUrl = `https://docs.google.com/spreadsheets/d/${sheetsMatch[1]}/export?format=xlsx`;
  } else {
    downloadUrl = shareUrl.includes('?') ? `${shareUrl}&download=1` : `${shareUrl}?download=1`;
  }

  console.log(`[updatedonations] Downloading from: ${downloadUrl}`);

  const response = await axios.get(downloadUrl, {
    responseType: 'arraybuffer',
    maxRedirects: 10,
    timeout: 15_000,
    headers: { 'User-Agent': 'Tanglebot/1.0' },
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.data);

  for (const worksheet of workbook.worksheets) {
    let headers = null;
    const rows = [];

    worksheet.eachRow((row, rowNumber) => {
      // row.values is 1-indexed — slice off the leading undefined
      const values = row.values.slice(1).map(v => {
        if (v && typeof v === 'object' && 'text' in v) return v.text;
        if (v && typeof v === 'object' && 'richText' in v) return v.richText.map(r => r.text).join('');
        return v ?? '';
      });

      if (rowNumber === 1) {
        headers = values.map(v => String(v));
      } else {
        if (!headers) return;
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i] ?? ''; });
        rows.push(obj);
      }
    });

    if (!headers || rows.length === 0) continue;

    const idKey      = headers.find(k => normalise(k) === 'discordid');
    const donatedKey = headers.find(k =>
      ['donated', 'total', 'donations', 'gp', 'amount'].includes(normalise(k))
    );
    const nameKey = headers.find(k => normalise(k) === 'name');

    if (!idKey || !donatedKey) continue;

    const results = rows
      .filter(r => r[idKey])
      .map(r => ({
        name:      nameKey ? String(r[nameKey]).trim() : null,
        discordId: String(r[idKey]).trim().replace(/\D/g, ''),
        donated:   parseDonationAmount(r[donatedKey]),
      }))
      .filter(r => r.discordId.length >= 17);

    if (results.length > 0) return results;
  }

  throw new Error(
    'Could not find donation data in the spreadsheet. ' +
    'Make sure a sheet has "DiscordID" and "Donated" column headers.'
  );
}

// Build one leaderboard entry line
function buildLine(entry) {
  const topTier = DONATION_TIERS.find(t => entry.donated >= t.threshold);
  const badge   = topTier ? `${tierEmoji(topTier)} ` : '';
  return `${badge}<@${entry.discordId}> — ${formatGP(entry.donated)}`;
}

module.exports = {
  requiredEnv: ['DONATIONS_SHEET_URL', 'DONATIONS_CHANNEL_ID'],

  data: new SlashCommandBuilder()
    .setName('updatedonations')
    .setDescription('Sync donation roles and post the ranked leaderboard to the donations channel'),

  async execute(interaction) {
    // Role guard — Templar only
    if (TEMPLAR_ROLE_ID && !interaction.member.roles.cache.has(TEMPLAR_ROLE_ID)) {
      return interaction.reply({
        content: 'You need the Templar role to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const channelId = process.env.DONATIONS_CHANNEL_ID;
    if (!channelId) {
      return interaction.reply({
        content: '`DONATIONS_CHANNEL_ID` is not configured in `.env`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    console.log(`[updatedonations] Started by ${interaction.user.tag}`);

    try {
      // ── 1. Fetch, deduplicate & sort donations ─────────────────────────────
      console.log('[updatedonations] Fetching donations from sheet...');
      const raw = await fetchDonations();

      // Merge duplicate Discord IDs by summing their donations
      const merged = new Map();
      for (const entry of raw) {
        if (merged.has(entry.discordId)) {
          merged.get(entry.discordId).donated += entry.donated;
        } else {
          merged.set(entry.discordId, { ...entry });
        }
      }
      const entries = [...merged.values()].sort((a, b) => b.donated - a.donated);
      console.log(`[updatedonations] ${raw.length} rows → ${entries.length} unique donor(s) after dedup.`);

      // ── 2. Cache guild members so we can look them up by Discord ID ────────
      const guild = interaction.guild;
      console.log('[updatedonations] Fetching guild members...');
      await guild.members.fetch();
      console.log(`[updatedonations] ${guild.members.cache.size} member(s) cached.`);

      // ── 3. Assign / remove donation tier roles ─────────────────────────────
      let assigned = 0;
      let removed  = 0;
      let notFound = 0;

      for (const entry of entries) {
        const member = guild.members.cache.get(entry.discordId);
        if (!member) {
          console.log(`[updatedonations] Member not found in server: ${entry.name ?? entry.discordId}`);
          notFound++;
          continue;
        }

        // DONATION_TIERS is ordered highest → lowest.
        // Find the highest tier earned; every tier below it is also granted.
        const highestIndex = DONATION_TIERS.findIndex(t => entry.donated >= t.threshold);
        const highestTier  = highestIndex !== -1 ? DONATION_TIERS[highestIndex].name : 'none';
        console.log(`[updatedonations] ${member.user.tag} — ${formatGP(entry.donated)} → highest tier: ${highestTier}`);

        for (let i = 0; i < DONATION_TIERS.length; i++) {
          const tier   = DONATION_TIERS[i];
          const roleId = process.env[tier.roleEnv];
          if (!roleId) {
            console.log(`[updatedonations]   Skipping ${tier.name}: role ID not configured`);
            continue;
          }

          const role = guild.roles.cache.get(roleId);
          if (!role) {
            console.log(`[updatedonations]   Skipping ${tier.name}: role ID ${roleId} not found in server`);
            continue;
          }

          // Qualifies if they reached this tier or any higher one
          const qualifies = highestIndex !== -1 && i >= highestIndex;
          const hasRole   = member.roles.cache.has(roleId);

          if (qualifies && !hasRole) {
            console.log(`[updatedonations]   +${tier.name} → ${member.user.tag}`);
            await member.roles.add(role);
            assigned++;
          } else if (!qualifies && hasRole) {
            console.log(`[updatedonations]   -${tier.name} → ${member.user.tag}`);
            await member.roles.remove(role);
            removed++;
          } else {
            console.log(`[updatedonations]   ${tier.name}: no change (qualifies=${qualifies}, hasRole=${hasRole})`);
          }
        }
      }

      console.log(`[updatedonations] Roles done — +${assigned} assigned, -${removed} removed, ${notFound} not found in server.`);

      // ── 4. Build all lines ─────────────────────────────────────────────────
      const totalDonated = entries.reduce((sum, e) => sum + e.donated, 0);
      const ce = customEmoji(process.env.DONATION_EMOJI_COINS, 'coins');

      const allLines = [];
      allLines.push(`# ${COINS_EMOJI} Donation High Scores ${COINS_EMOJI}`);
      allLines.push('');
      allLines.push(`# ${ce} Total Donated: ${formatGP(totalDonated)} ${ce}`.trim());
      allLines.push('');

      entries.forEach((entry, i) => {
        const line = buildLine(entry);
        allLines.push(i === 0 ? `# ${line}` : line);
      });

      // Split lines into chunks that fit within Discord's 2000-char message limit
      const chunks = [];
      let current = '';
      for (const line of allLines) {
        const candidate = current ? `${current}\n${line}` : line;
        if (candidate.length > 2000) {
          chunks.push(current);
          current = line;
        } else {
          current = candidate;
        }
      }
      if (current) chunks.push(current);

      console.log(`[updatedonations] Built ${chunks.length} message chunk(s).`);

      // ── 5. Post or edit in donations channel ───────────────────────────────
      const channel = await guild.channels.fetch(channelId);
      const stored  = readJson('donations_message.json');
      const prevIds = Array.isArray(stored.messageIds) ? stored.messageIds : (stored.messageId ? [stored.messageId] : []);
      const newIds  = [];

      for (let i = 0; i < chunks.length; i++) {
        const prevId = prevIds[i];
        if (prevId) {
          try {
            console.log(`[updatedonations] Editing message ${i + 1}/${chunks.length} (${prevId})...`);
            const existing = await channel.messages.fetch(prevId);
            await existing.edit({ content: chunks[i] });
            newIds.push(existing.id);
          } catch (err) {
            console.log(`[updatedonations] Could not edit message ${prevId} (${err.message}), sending new...`);
            const sent = await channel.send({ content: chunks[i] });
            newIds.push(sent.id);
          }
        } else {
          console.log(`[updatedonations] Sending new message ${i + 1}/${chunks.length}...`);
          const sent = await channel.send({ content: chunks[i] });
          newIds.push(sent.id);
          console.log(`[updatedonations] Sent: ${sent.id}`);
        }
      }

      // Delete any leftover messages from a previous run that had more chunks
      for (let i = chunks.length; i < prevIds.length; i++) {
        try {
          console.log(`[updatedonations] Deleting surplus message ${prevIds[i]}...`);
          const old = await channel.messages.fetch(prevIds[i]);
          await old.delete();
        } catch {
          // Already deleted — ignore
        }
      }

      writeJson('donations_message.json', { messageIds: newIds });
      console.log('[updatedonations] Done.');

      await interaction.editReply(
        `Leaderboard posted to <#${channelId}>.\n` +
        `Roles updated: **+${assigned}** assigned, **-${removed}** removed.`
      );

    } catch (err) {
      console.error('[updatedonations] Fatal error:', err);
      await interaction.editReply(`Error: ${err.message}`);
    }
  },
};
