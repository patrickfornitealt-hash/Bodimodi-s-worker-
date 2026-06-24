import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, AttachmentBuilder, MessageFlags, ChannelType, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { createEmbed, successEmbed } from '../utils/embeds.js';
import { createTicket, closeTicket, claimTicket, updateTicketPriority } from '../services/ticket.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { logTicketEvent } from '../utils/ticketLogging.js';
import { logger } from '../utils/logger.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { getTicketPermissionContext } from '../utils/ticketPermissions.js';
import { getPanel, incrementButtonCounter } from '../utils/panels.js';
import { saveTicketData } from '../utils/database.js';

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function ensureGuildContext(interaction) {
  if (interaction.inGuild()) {
    return true;
  }

  if (!interaction.replied && !interaction.deferred) {
    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This action can only be used in a server.' });
  }

  return false;
}

async function replyPermissionCheckFailure(interaction, permissionCheck) {
  let type = ErrorTypes.UNKNOWN;
  if (permissionCheck.error === 'Permission Denied') {
    type = ErrorTypes.PERMISSION;
  } else if (permissionCheck.error === 'Request Timeout') {
    type = ErrorTypes.RATE_LIMIT;
  }

  await replyUserError(interaction, { type, message: permissionCheck.details });
}

async function checkTicketPermissionWithTimeout(interaction, client, actionLabel, options = {}, timeoutMs = 2500) {
  const { allowTicketCreator = false } = options;

  try {
    const contextPromise = getTicketPermissionContext({ client, interaction });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    );

    const context = await Promise.race([contextPromise, timeoutPromise]);

    if (!context.ticketData) {
      return { success: false, error: 'Not a Ticket Channel', details: 'This action can only be used in a valid ticket channel.' };
    }

    const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
    if (!allowed) {
      const permissionMessage = allowTicketCreator
        ? 'You must have **Manage Channels**, the configured **Ticket Staff Role**, or be the **ticket creator**.'
        : 'You must have **Manage Channels** or the configured **Ticket Staff Role**.';
      return { success: false, error: 'Permission Denied', details: `${permissionMessage}\n\nYou cannot ${actionLabel}.` };
    }

    return { success: true, context };
  } catch (error) {
    if (error.message === 'Timeout') {
      return { success: false, error: 'Request Timeout', details: 'The permission check took too long. Please try again.' };
    }
    return { success: false, error: 'Error', details: `Failed to check permissions: ${error.message}` };
  }
}

async function ensureTicketPermission(interaction, client, actionLabel, options = {}) {
  const { allowTicketCreator = false } = options;

  const context = await getTicketPermissionContext({ client, interaction });

  if (!context.ticketData) {
    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This action can only be used in a valid ticket channel.' });
    return null;
  }

  const allowed = allowTicketCreator ? context.canCloseTicket : context.canManageTicket;
  if (!allowed) {
    const permissionMessage = allowTicketCreator
      ? 'You must have **Manage Channels**, the configured **Ticket Staff Role**, or be the **ticket creator**.'
      : 'You must have **Manage Channels** or the configured **Ticket Staff Role**.';

    await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: `${permissionMessage}\n\nYou cannot ${actionLabel}.` });
    return null;
  }

  return context;
}

function formatNamingTemplate(template, { slug, counter }) {
  if (!template) template = '{slug}-{counter}';
  // replace {slug}
  let out = template.replace(/\{slug\}/g, slug);
  // replace {counter} and {counter:03} style
  out = out.replace(/\{counter(?::0?(\d+))?\}/g, (_, pad) => {
    const s = String(counter ?? 0);
    if (pad) return s.padStart(Number(pad), '0');
    return s;
  });
  // sanitize: allow letters, numbers, hyphen, underscore
  out = out.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
  // trim leading/trailing hyphens
  out = out.replace(/(^-+|-+$)/g, '');
  return out;
}

const createTicketHandler = {
  name: 'create_ticket',
  // accept args so panel buttons (create_ticket:panelId:buttonId) can pass their ids
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      // If args are provided, assume this is a panel button press: [panelId, buttonId]
      if (Array.isArray(args) && args.length >= 2 && args[0] && args[1]) {
        const panelId = args[0];
        const buttonId = args[1];

        // rate limit per user for panel press
        const rateLimitKey = `${interaction.user.id}:panel_create`;
        const allowed = await checkRateLimit(rateLimitKey, 6, 30000);
        if (!allowed) {
          await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: 'You are creating tickets too quickly. Please wait a moment and try again.' });
          return;
        }

        // fetch panel/button configuration
        const panel = await getPanel(client, interaction.guildId, panelId);
        if (!panel) {
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Panel configuration not found.' });
          return;
        }
        const button = panel.buttons.find(b => b.id === buttonId);
        if (!button) {
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Button configuration not found.' });
          return;
        }

        // Check per-user ticket limit
        const config = await getGuildConfig(client, interaction.guildId);
        const maxTicketsPerUser = config.maxTicketsPerUser || 3;
        const { getUserTicketCount } = await import('../services/ticket.js');
        const currentTicketCount = await getUserTicketCount(interaction.guildId, interaction.user.id);
        if (currentTicketCount >= maxTicketsPerUser) {
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `You have reached the maximum number of open tickets (${maxTicketsPerUser}). Please close existing tickets before creating a new one.` });
          return;
        }

        // Defer reply so we have time
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) return;

        // increment per-button counter
        let counterValue;
        try {
          counterValue = await incrementButtonCounter(client, interaction.guildId, panelId, buttonId);
        } catch (err) {
          logger.error('Failed to increment button counter', err);
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to create ticket (counter). Please try again.' });
          return;
        }

        // format channel name
        const slug = button.slug || (button.label || 'ticket').toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const channelName = formatNamingTemplate(button.namingTemplate || '{slug}-{counter}', { slug, counter: counterValue });

        // determine category to create under
        const guildConfig = await getGuildConfig(client, interaction.guildId);
        const categoryId = button.categoryId || panel.categoryId || guildConfig.ticketCategoryId || null;

        // create channel
        let channel;
        try {
          channel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: categoryId || undefined,
            permissionOverwrites: [
              { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
              { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
              ...(button.staffRoleIds && button.staffRoleIds.length ? button.staffRoleIds.map(rid => ({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] })) : (guildConfig.ticketStaffRoleId ? [{ id: guildConfig.ticketStaffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }] : []))
            ],
          });
        } catch (err) {
          logger.error('Failed to create ticket channel', err);
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `Failed to create ticket channel: ${err.message}` });
          return;
        }

        // prepare and save ticket data
        const ticketData = {
          id: channel.id,
          userId: interaction.user.id,
          guildId: interaction.guildId,
          createdAt: new Date().toISOString(),
          status: 'open',
          claimedBy: null,
          priority: 'none',
          reason: `Opened via panel ${panel.name} / ${button.label}`,
          panelId,
          buttonId,
          buttonCounter: counterValue,
        };

        try {
          await saveTicketData(interaction.guildId, channel.id, ticketData);
        } catch (err) {
          logger.error('Failed to save ticket data', err);
        }

        // send initial ticket message
        try {
          const embed = createEmbed({
            title: `Ticket ${channelName}`,
            description: `${interaction.user.toString()}, thank you — a staff member will be with you shortly.\n\n**Opened via:** ${button.label}`,
            color: 0x2ecc71,
            fields: [
              { name: 'Status', value: '🟢 Open', inline: true },
              { name: 'Claimed By', value: 'Not claimed', inline: true },
              { name: 'Created', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
            ]
          });

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setStyle(ButtonStyle.Primary).setEmoji('🙋'),
            new ButtonBuilder().setCustomId('ticket_pin').setLabel('Pin').setStyle(ButtonStyle.Secondary).setEmoji('📌'),
            new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒')
          );

          const ticketMessage = await channel.send({ content: `${interaction.user}`, embeds: [embed], components: [row] });
          await ticketMessage.pin().catch(() => {});
        } catch (err) {
          logger.error('Failed to send initial ticket message', err);
        }

        // log event
        try {
          await logTicketEvent({
            client: interaction.client,
            guildId: interaction.guildId,
            event: {
              type: 'open',
              ticketId: channel.id,
              ticketNumber: channelName,
              userId: interaction.user.id,
              executorId: interaction.user.id,
              metadata: { panelId, buttonId, buttonCounter: counterValue }
            }
          });
        } catch (err) {
          logger.warn('Failed to log ticket open event', err.message || err);
        }

        await interaction.editReply({ content: `Ticket created: ${channel}`, ephemeral: true });
        return;
      }

      // FALLBACK: if no args, show modal to create ticket (existing behavior)
      const rateLimitKey = `${interaction.user.id}:create_ticket`;
      const allowed = await checkRateLimit(rateLimitKey, 3, 60000);
      if (!allowed) {
        await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: 'You are creating tickets too quickly. Please wait a minute and try again.' });
        return;
      }

      const config = await getGuildConfig(client, interaction.guildId);
      const maxTicketsPerUser = config.maxTicketsPerUser || 3;

      const { getUserTicketCount } = await import('../services/ticket.js');
      const currentTicketCount = await getUserTicketCount(interaction.guildId, interaction.user.id);

      if (currentTicketCount >= maxTicketsPerUser) {
        return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `You have reached the maximum number of open tickets (${maxTicketsPerUser}).\n\nPlease close your existing tickets before creating a new one.` });
      }

      const modal = new ModalBuilder()
        .setCustomId('create_ticket_modal')
        .setTitle('Create a Ticket');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Why are you creating this ticket?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('')
        .setRequired(true)
        .setMaxLength(1000);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error creating ticket modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open ticket creation form.' });
      }
    }
  }
};

const createTicketModalHandler = {
  name: 'create_ticket_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const reason = interaction.fields.getTextInputValue('reason');
      const config = await getGuildConfig(client, interaction.guildId);
      const categoryId = config.ticketCategoryId || null;
      
      const result = await createTicket(
        interaction.guild,
        interaction.member,
        categoryId,
        reason
      );
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed(
            'Ticket Created',
            `Your ticket has been created in ${result.channel}!`
          )]
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to create ticket.' });
      }
    } catch (error) {
      logger.error('Error creating ticket:', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while creating your ticket.' });
    }
  }
};

// ... rest of file unchanged (close, claim, priority, pin, unclaim, reopen, delete handlers)

const closeTicketHandler = {
  name: 'ticket_close',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'close this ticket',
        { allowTicketCreator: true },
        2000 
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId('ticket_close_modal')
        .setTitle('Close Ticket');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Reason for closing (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Add an optional reason for closing this ticket...')
        .setRequired(false)
        .setMaxLength(1000);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } catch (error) {
      logger.error('Error closing ticket:', error);

      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not open ticket close form.' });
      }
    }
  }
};

const closeTicketModalHandler = {
  name: 'ticket_close_modal',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'close this ticket',
        { allowTicketCreator: true },
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;

      const providedReason = interaction.fields.getTextInputValue('reason')?.trim();
      const reason = providedReason || 'Closed via ticket button without a specific reason.';

      const result = await closeTicket(interaction.channel, interaction.user, reason);

      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket Closed', 'This ticket has been closed.')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to close ticket.' });
      }
    } catch (error) {
      logger.error('Error submitting close ticket modal:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while closing the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while closing the ticket.' });
      }
    }
  }
};

const claimTicketHandler = {
  name: 'ticket_claim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'claim tickets',
        {},
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const result = await claimTicket(interaction.channel, interaction.user);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket Claimed', 'You have successfully claimed this ticket!')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to claim ticket.' });
      }
    } catch (error) {
      logger.error('Error claiming ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while claiming the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while claiming the ticket.' });
      }
    }
  }
};

const priorityTicketHandler = {
  name: 'ticket_priority',
  async execute(interaction, client, args) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'change ticket priority',
        {},
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const priority = args?.[0];
      if (!priority) {
        await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'A priority value is required.' });
        return;
      }

      const result = await updateTicketPriority(interaction.channel, priority, interaction.user);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Priority Updated', `Ticket priority set to ${priority}.`)],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to update priority.' });
      }
    } catch (error) {
      logger.error('Error updating ticket priority:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while updating the priority.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while updating the priority.' });
      }
    }
  }
};

const pinTicketHandler = {
  name: 'ticket_pin',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'pin tickets',
        {},
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const channel = interaction.channel;
      const category = channel.parent;

      if (!category) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This ticket is not in a category.' });
        return;
      }

      const hasPingEmoji = channel.name.startsWith('📌');
      
      if (hasPingEmoji) {
        
        const newName = channel.name.replace(/^📌\s*/, '');
        await channel.edit({
          name: newName,
          position: 999 
        });

        await interaction.editReply({
          embeds: [createEmbed({
            title: '📌 Ticket Unpinned',
            description: 'This ticket has been unpinned and moved back to normal position.',
            color: 0x95A5A6
          })],
          flags: MessageFlags.Ephemeral
        });

        logger.info('Ticket unpinned', {
          guildId: interaction.guildId,
          channelId: channel.id,
          channelName: newName,
          userId: interaction.user.id
        });
      } else {
        
        const pinnedName = `📌 ${channel.name}`;
        await channel.edit({
          name: pinnedName,
          position: 0 
        });

        await interaction.editReply({
          embeds: [createEmbed({
            title: '📌 Ticket Pinned',
            description: 'This ticket has been pinned to the top of the category.',
            color: 0x3498db
          })],
          flags: MessageFlags.Ephemeral
        });

        logger.info('Ticket pinned', {
          guildId: interaction.guildId,
          channelId: channel.id,
          channelName: pinnedName,
          userId: interaction.user.id
        });
      }

      await logTicketEvent({
        client: interaction.client,
        guildId: interaction.guildId,
        event: {
          type: hasPingEmoji ? 'unpin' : 'pin',
          ticketId: channel.id,
          ticketNumber: channel.name.replace(/[^0-9]/g, ''),
          userId: interaction.user.id,
          executorId: interaction.user.id,
          metadata: {
            isPinned: !hasPingEmoji,
            newChannelName: hasPingEmoji ? channel.name.replace(/^📌\s*/, '') : `📌 ${channel.name}`
          }
        }
      });

    } catch (error) {
      logger.error('Error pinning/unpinning ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to pin/unpin the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to pin/unpin the ticket.' });
      }
    }
  }
};

const unclaimTicketHandler = {
  name: 'ticket_unclaim',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'unclaim tickets',
        {},
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { unclaimTicket } = await import('../services/ticket.js');
      const result = await unclaimTicket(interaction.channel, interaction.member);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket Unclaimed', 'You have successfully unclaimed this ticket!')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to unclaim ticket.' });
      }
    } catch (error) {
      logger.error('Error unclaiming ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while unclaiming the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while unclaiming the ticket.' });
      }
    }
  }
};

const reopenTicketHandler = {
  name: 'ticket_reopen',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'reopen tickets',
        {},
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { reopenTicket } = await import('../services/ticket.js');
      const result = await reopenTicket(interaction.channel, interaction.member);
      
      if (result.success) {
        let reopenMessage = 'You have successfully reopened this ticket!';
        if (result.openCategoryMoveFailed) {
          reopenMessage += '\n\n⚠️ The ticket was reopened, but it could not be moved to the configured open ticket category.';
        }

        await interaction.editReply({
          embeds: [successEmbed('Ticket Reopened', reopenMessage)],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to reopen ticket.' });
      }
    } catch (error) {
      logger.error('Error reopening ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while reopening the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while reopening the ticket.' });
      }
    }
  }
};

const deleteTicketHandler = {
  name: 'ticket_delete',
  async execute(interaction, client) {
    try {
      if (!(await ensureGuildContext(interaction))) return;

      const permissionCheck = await checkTicketPermissionWithTimeout(
        interaction,
        client,
        'delete tickets',
        {},
        2000
      );

      if (!permissionCheck.success) {
        await replyPermissionCheckFailure(interaction, permissionCheck);
        return;
      }

      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) return;
      
      const { deleteTicket } = await import('../services/ticket.js');
      const result = await deleteTicket(interaction.channel, interaction.member);
      
      if (result.success) {
        await interaction.editReply({
          embeds: [successEmbed('Ticket Deleted', 'This ticket will be permanently deleted in 3 seconds.')],
          flags: MessageFlags.Ephemeral
        });
      } else {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: result.error || 'Failed to delete ticket.' });
      }
    } catch (error) {
      logger.error('Error deleting ticket:', error);
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while deleting the ticket.' });
      } else if (interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while deleting the ticket.' });
      }
    }
  }
};

export default createTicketHandler;
export { 
  createTicketModalHandler, 
  closeTicketModalHandler,
  closeTicketHandler, 
  claimTicketHandler, 
  priorityTicketHandler,
  pinTicketHandler,
  unclaimTicketHandler,
  reopenTicketHandler,
  deleteTicketHandler 
};
