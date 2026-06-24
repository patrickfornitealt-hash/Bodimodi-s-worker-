import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getTicketPermissionContext } from '../../utils/ticketPermissions.js';
import { logTicketEvent } from '../../utils/ticketLogging.js';

export default {
  data: new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a user to this ticket (grants access to the ticket channel).')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('The user to add to the ticket')
        .setRequired(true),
    ),

  category: 'ticket',

  async execute(interaction, config, client) {
    try {
      if (!interaction.inGuild()) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
        return;
      }

      const context = await getTicketPermissionContext({ client, interaction });
      if (!context?.ticketData) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This channel is not a ticket.' });
        return;
      }

      // Allow ticket staff / manage channels or the ticket creator to add users
      const allowed = context.canManageTicket || context.isTicketCreator;
      if (!allowed) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You do not have permission to add users to this ticket.' });
        return;
      }

      const targetUser = interaction.options.getUser('user', true);
      const guild = interaction.guild;
      const channel = interaction.channel;

      // Fetch member to ensure they are in the guild
      const member = await guild.members.fetch(targetUser.id).catch(() => null);
      if (!member) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not find that user in the server.' });
        return;
      }

      // Check if the user already has explicit access
      const currentOverwrite = channel.permissionOverwrites.cache.get(member.id);
      const alreadyHasAccess = currentOverwrite && currentOverwrite.allow?.has?.('ViewChannel');

      if (alreadyHasAccess) {
        await interaction.reply({ embeds: [successEmbed('Already Added', `${member} already has access to this ticket.`)], flags: MessageFlags.Ephemeral });
        return;
      }

      // Grant permissions on the ticket channel to the user
      await channel.permissionOverwrites.edit(member.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
      });

      // Notify the ticket channel (ping the user)
      await channel.send({ content: `${member} has been added to this ticket by ${interaction.user}.` }).catch(() => {});

      // Reply to the command invoker
      await interaction.reply({ embeds: [successEmbed('User Added', `${member} was granted access to this ticket.`)], flags: MessageFlags.Ephemeral });

      // Log event
      try {
        await logTicketEvent({
          client,
          guildId: guild.id,
          event: {
            type: 'add_user',
            ticketId: channel.id,
            userId: member.id,
            executorId: interaction.user.id,
            metadata: {},
          },
        });
      } catch (e) {
        // non-fatal
      }
    } catch (error) {
      // Generic handler
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to add user to ticket.' });
    }
  },
};
