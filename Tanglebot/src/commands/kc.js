const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const {
  SUBMISSION_FORMAT_MESSAGE,
  clearActiveSession,
  getActiveSession,
  setActiveSession,
} = require('../utils/submissionIntake');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kc')
    .setDescription('Start or end a proof submission session')
    .addSubcommand(subcommand =>
      subcommand
        .setName('start')
        .setDescription('Start a KC/drop proof submission session in this channel')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('end')
        .setDescription('End your active KC/drop proof submission session')
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const config = interaction.client.submissionConfig;

    if (subcommand === 'start') {
      if (!config?.enabled) {
        return interaction.reply({
          content: 'Proof intake is not configured right now. Ask an admin to finish the submission intake environment setup first.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const eventId = config.channelEventMap[interaction.channelId];
      if (!eventId) {
        return interaction.reply({
          content: 'This channel is not configured for proof intake. Run `/kc start` in one of the mapped submission channels.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const existingSession = getActiveSession(interaction.user.id);
      if (existingSession && existingSession.channelId !== interaction.channelId) {
        return interaction.reply({
          content: `You already have an active proof session in <#${existingSession.channelId}>. Run \`/kc end\` there first or finish that submission.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const session = {
        channelId: interaction.channelId,
        eventId,
        startedAt: new Date().toISOString(),
        userId: interaction.user.id,
      };

      setActiveSession(session);

      return interaction.reply({
        content: [
          existingSession
            ? 'Your active proof session in this channel was refreshed.'
            : 'Your proof session is now active for this channel.',
          'Your next valid KC or drop proof message in this channel with exactly one image attachment will be processed.',
          '',
          SUBMISSION_FORMAT_MESSAGE,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'end') {
      const cleared = clearActiveSession(interaction.user.id);
      return interaction.reply({
        content: cleared
          ? 'Your active proof session has been ended.'
          : 'You do not have an active proof session right now.',
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({
      content: 'Unknown kc command.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
