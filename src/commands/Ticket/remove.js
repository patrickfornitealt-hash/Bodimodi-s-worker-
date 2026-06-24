import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getTicketPermissionContext } from '../../utils/ticketPermissions.js';
import { logTicketEvent } from '../../utils/ticketLogging.js';

export default {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a user from this ticket (revokes their explicit access).')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('The user to remove from the ticket')
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

      // Allow ticket staff / manage channels or the ticket creator to remove users
      const allowed = context.canManageTicket || context.isTicketCreator;
      if (!allowed) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You do not have permission to remove users from this ticket.' });
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

      const currentOverwrite = channel.permissionOverwrites.cache.get(member.id);
      if (!currentOverwrite) {
        await interaction.reply({ embeds: [successEmbed('Not Found', `${member} does not have an explicit override on this ticket.`)], flags: MessageFlags.Ephemeral });
        return;
      }

      // Try to remove the explicit overwrite
      try {
        await channel.permissionOverwrites.delete(member.id);
      } catch (err) {
        // Fallback: set restrictive permissions
        try {
          await channel.permissionOverwrites.edit(member.id, {
            ViewChannel: false,
            SendMessages: false,
            ReadMessageHistory: false,
            AttachFiles: false,
          });
        } catch (err2) {
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to remove user permissions from this ticket.' });
          return;
        }
      }

      // Notify the channel
      await channel.send({ content: `${member} has been removed from this ticket by ${interaction.user}.` }).catch(() => {});

      // Reply to invoker
      await interaction.reply({ embeds: [successEmbed('User Removed', `${member} no longer has explicit access to this ticket.`)], flags: MessageFlags.Ephemeral });

      // Log event (non-fatal)
      try {
        await logTicketEvent({
          client,
          guildId: guild.id,
          event: {
            type: 'remove_user',
            ticketId: channel.id,
            userId: member.id,
            executorId: interaction.user.id,
            metadata: {},
          },
        });
      } catch (e) {
        // ignore
      }
    } catch (error) {
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to remove user from ticket.' });
    }
  },
};
