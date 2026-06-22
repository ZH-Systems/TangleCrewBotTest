const { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('channelmap')
    .setDescription('Show the Discord channel ID to copy into the web panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option =>
      option
        .setName('channel')
        .setDescription('Channel to generate the mapping snippet for')
        .addChannelTypes(ChannelType.GuildText)
    ),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;

    return interaction.reply({
      content: [
        `Channel: <#${channel.id}>`,
        `Channel ID: \`${channel.id}\``,
        '',
        'Web panel fields:',
        `- \`discord_submission_channel_id\`: \`${channel.id}\``,
        `- \`discord_approval_channel_id\`: \`REPLACE_IF_NEEDED\``,
        '',
        'Set those values on the event in the web panel. The bot now reads channel routing from Supabase at runtime.',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  },
};
