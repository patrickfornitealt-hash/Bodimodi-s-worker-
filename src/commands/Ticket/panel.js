import { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createPanel, listPanels, addButtonToPanel, makeButtonCustomId, updatePanel } from '../../utils/panels.js';
import { successEmbed } from '../../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

export default {
  data: new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Manage ticket panels')
    .addSubcommand(sc => sc
      .setName('create')
      .setDescription('Create a new ticket panel (posts a message with buttons)')
      .addChannelOption(opt => opt.setName('channel').setDescription('Channel to post the panel in').setRequired(true))
      .addStringOption(opt => opt.setName('title').setDescription('Panel title').setRequired(true))
    )
    .addSubcommand(sc => sc
      .setName('list')
      .setDescription('List configured panels for this guild')
    )
    .addSubcommand(sc => sc
      .setName('add-button')
      .setDescription('Add a button to a panel')
      .addStringOption(opt => opt.setName('panel_id').setDescription('ID of the panel').setRequired(true))
      .addStringOption(opt => opt.setName('label').setDescription('Button label').setRequired(true))
      .addStringOption(opt => opt.setName('naming_template').setDescription('Channel naming template (e.g. {slug}-{counter:03})').setRequired(true))
      .addChannelOption(opt => opt.setName('category').setDescription('Category for new tickets').setRequired(false))
      .addChannelOption(opt => opt.setName('log_channel').setDescription('Log channel for ticket lifecycle events').setRequired(false))
    ),

  category: 'ticket',

  async execute(interaction, config, client) {
    try {
      if (!interaction.inGuild()) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === 'create') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need Manage Server permission to create a panel.' });
          return;
        }

        const channel = interaction.options.getChannel('channel', true);
        const title = interaction.options.getString('title', true);

        // Create panel record
        const panel = await createPanel(client, interaction.guildId, { name: title, channelId: channel.id });

        // Create a default button and add to panel
        const defaultButton = await addButtonToPanel(client, interaction.guildId, panel.id, {
          label: 'Create Ticket',
          namingTemplate: '{slug}-{counter:03}',
        });

        const buttonRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(makeButtonCustomId(panel.id, defaultButton.id))
            .setLabel(defaultButton.label)
            .setStyle(ButtonStyle.Primary)
        );

        // Post panel message in the configured channel
        let postedMessage = null;
        try {
          postedMessage = await channel.send({ embeds: [successEmbed(panel.name, 'Press a button below to create a ticket.')], components: [buttonRow] });
        } catch (sendError) {
          // If we couldn't post the message, remove the created button and return error
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `Could not post panel message in <#${channel.id}>: ${sendError.message}` });
          return;
        }

        // Save messageId into panel
        await updatePanel(client, interaction.guildId, panel.id, { messageId: postedMessage.id });

        await interaction.reply({ embeds: [successEmbed('Panel Created', `Created panel ${panel.name} (id: ${panel.id}) in ${channel}.`)], ephemeral: true });
        return;
      }

      if (sub === 'list') {
        const panels = await listPanels(client, interaction.guildId);
        if (!panels || panels.length === 0) {
          await interaction.reply({ embeds: [successEmbed('Panels', 'No panels configured for this server.')], ephemeral: true });
          return;
        }

        const lines = panels.map(p => `• ${p.name} — id: ${p.id} — channel: <#${p.channelId}> — buttons: ${p.buttons?.length || 0}`);
        await interaction.reply({ embeds: [successEmbed('Panels', lines.join('\n'))], ephemeral: true });
        return;
      }

      if (sub === 'add-button') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need Manage Server permission to edit panels.' });
          return;
        }

        const panelId = interaction.options.getString('panel_id', true);
        const label = interaction.options.getString('label', true);
        const namingTemplate = interaction.options.getString('naming_template', true);
        const category = interaction.options.getChannel('category', false);
        const logChannel = interaction.options.getChannel('log_channel', false);

        const button = await addButtonToPanel(client, interaction.guildId, panelId, {
          label,
          namingTemplate,
          categoryId: category?.id || null,
          logChannelId: logChannel?.id || null,
        });

        // If panel has a posted message, edit it to add the new button
        try {
          const panel = await (await import('../../utils/panels.js')).getPanel(client, interaction.guildId, panelId);
          if (panel && panel.messageId && panel.channelId) {
            const ch = await client.channels.fetch(panel.channelId).catch(() => null);
            if (ch) {
              const msg = await ch.messages.fetch(panel.messageId).catch(() => null);
              if (msg) {
                // Rebuild rows: take existing buttons and append
                const rows = [];
                const row = new ActionRowBuilder();
                for (const b of panel.buttons) {
                  row.addComponents(
                    new ButtonBuilder()
                      .setCustomId(makeButtonCustomId(panel.id, b.id))
                      .setLabel(b.label)
                      .setStyle(ButtonStyle.Primary)
                  );
                }
                rows.push(row);
                await msg.edit({ components: rows });
              }
            }
          }
        } catch (e) {
          console.warn('Failed to update panel message with new button:', e.message);
        }

        await interaction.reply({ embeds: [successEmbed('Button Added', `Button ${button.label} added to panel (id: ${panelId}).` )], ephemeral: true });
        return;
      }

    } catch (error) {
      console.error('Ticket panel command error', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to execute ticket panel command.' });
    }
  }
};
