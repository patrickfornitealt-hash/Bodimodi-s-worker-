import { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
  createPanel,
  listPanels,
  addButtonToPanel,
  makeButtonCustomId,
  updatePanel,
  removeButton,
  getPanel,
} from '../utils/panels.js';
import { successEmbed } from '../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';

export default {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Server setup utilities')
    .addSubcommandGroup(g => g
      .setName('panel')
      .setDescription('Manage ticket panels')
      .addSubcommand(sc => sc
        .setName('create')
        .setDescription('Create a new ticket panel (posts a message with buttons)')
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel to post the panel in').setRequired(true))
        .addStringOption(opt => opt.setName('title').setDescription('Panel title').setRequired(true)))
      .addSubcommand(sc => sc
        .setName('list')
        .setDescription('List configured panels for this guild'))
      .addSubcommand(sc => sc
        .setName('add-button')
        .setDescription('Add a button to a panel')
        .addStringOption(opt => opt.setName('panel_id').setDescription('ID of the panel').setRequired(true))
        .addStringOption(opt => opt.setName('label').setDescription('Button label').setRequired(true))
        .addStringOption(opt => opt.setName('naming_template').setDescription('Channel naming template (e.g. {slug}-{counter:03})').setRequired(true))
        .addChannelOption(opt => opt.setName('category').setDescription('Category for new tickets').setRequired(false))
        .addChannelOption(opt => opt.setName('log_channel').setDescription('Log channel for ticket lifecycle events').setRequired(false)))
      .addSubcommand(sc => sc
        .setName('remove-button')
        .setDescription('Remove a button from a panel')
        .addStringOption(opt => opt.setName('panel_id').setDescription('ID of the panel').setRequired(true))
        .addStringOption(opt => opt.setName('button_id').setDescription('ID of the button').setRequired(true)))
    ),

  category: 'setup',

  async execute(interaction, config, client) {
    try {
      if (!interaction.inGuild()) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
        return;
      }

      const group = interaction.options.getSubcommandGroup();
      if (group !== 'panel') {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Unknown setup group.' });
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need Manage Server permission to run setup commands.' });
        return;
      }

      if (sub === 'create') {
        const targetChannel = interaction.options.getChannel('channel', true);
        const title = interaction.options.getString('title', true);

        // Validate channel
        const ch = await client.channels.fetch(targetChannel.id).catch(() => null);
        if (!ch || !ch.isTextBased?.()) {
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Selected channel is not a text channel.' });
          return;
        }
        const me = interaction.guild?.members?.me || await interaction.guild.members.fetch(client.user.id).catch(() => null);
        const botPerms = ch.permissionsFor(me);
        if (!botPerms || !botPerms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
          await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'I do not have permission to send messages in the selected channel.' });
          return;
        }

        // create panel record
        const panel = await createPanel(client, interaction.guildId, { name: title, channelId: ch.id });

        // add a default button so the panel has at least one action
        const defaultButton = await addButtonToPanel(client, interaction.guildId, panel.id, {
          label: 'Create Ticket',
          namingTemplate: '{slug}-{counter:03}',
        });

        // build the message with the button
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(makeButtonCustomId(panel.id, defaultButton.id))
            .setLabel(defaultButton.label)
            .setStyle(ButtonStyle.Primary)
        );

        let posted = null;
        try {
          posted = await ch.send({ embeds: [successEmbed(panel.name, 'Press a button below to create a ticket.')], components: [row] });
        } catch (err) {
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `Failed to post panel message: ${err.message}` });
          return;
        }

        // persist message id
        try {
          await updatePanel(client, interaction.guildId, panel.id, { messageId: posted.id });
        } catch (err) {
          // attempt cleanup
          try { await posted.delete().catch(() => {}); } catch (e) {}
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: `Panel created but failed to save state: ${err.message}` });
          return;
        }

        await interaction.reply({ embeds: [successEmbed('Panel Created', `Panel "${panel.name}" created in <#${ch.id}> (id: ${panel.id}).`)], ephemeral: true });
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

        // update posted message if exists
        try {
          const panel = await getPanel(client, interaction.guildId, panelId);
          if (panel && panel.channelId && panel.messageId) {
            const ch = await client.channels.fetch(panel.channelId).catch(() => null);
            if (ch) {
              const msg = await ch.messages.fetch(panel.messageId).catch(() => null);
              if (msg) {
                // rebuild rows (simple single row implementation)
                const row = new ActionRowBuilder();
                for (const b of panel.buttons) {
                  row.addComponents(new ButtonBuilder().setCustomId(makeButtonCustomId(panel.id, b.id)).setLabel(b.label).setStyle(ButtonStyle.Primary));
                }
                await msg.edit({ components: [row] });
              }
            }
          }
        } catch (e) {
          console.warn('Failed to update panel message:', e?.message || e);
        }

        await interaction.reply({ embeds: [successEmbed('Button Added', `Button "${button.label}" added to panel ${panelId}.`)], ephemeral: true });
        return;
      }

      if (sub === 'remove-button') {
        const panelId = interaction.options.getString('panel_id', true);
        const buttonId = interaction.options.getString('button_id', true);

        const removed = await removeButton(client, interaction.guildId, panelId, buttonId);
        if (!removed) {
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Button not found on panel.' });
          return;
        }

        // update posted message if exists
        try {
          const panel = await getPanel(client, interaction.guildId, panelId);
          if (panel && panel.channelId && panel.messageId) {
            const ch = await client.channels.fetch(panel.channelId).catch(() => null);
            if (ch) {
              const msg = await ch.messages.fetch(panel.messageId).catch(() => null);
              if (msg) {
                const row = new ActionRowBuilder();
                for (const b of panel.buttons) {
                  row.addComponents(new ButtonBuilder().setCustomId(makeButtonCustomId(panel.id, b.id)).setLabel(b.label).setStyle(ButtonStyle.Primary));
                }
                await msg.edit({ components: [row] });
              }
            }
          }
        } catch (e) {
          console.warn('Failed to update panel message after button removal:', e?.message || e);
        }

        await interaction.reply({ embeds: [successEmbed('Button Removed', `Button ${buttonId} removed from panel ${panelId}.`)], ephemeral: true });
        return;
      }

      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Unknown subcommand.' });

    } catch (error) {
      console.error('Setup command error', error);
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while running setup.' });
    }
  }
};
