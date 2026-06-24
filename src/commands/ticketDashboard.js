import { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
  listPanels,
  getPanel,
  addButtonToPanel,
  updateButton,
  removeButton,
  makeButtonCustomId,
} from '../utils/panels.js';
import { successEmbed } from '../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';

function parseRoleList(input) {
  if (!input) return [];
  return input.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/<@&?(\d+)>/);
    if (m) return m[1];
    return s.replace(/[^0-9]/g, '');
  }).filter(Boolean);
}

function mapStyle(styleStr) {
  if (!styleStr) return ButtonStyle.Primary;
  const s = String(styleStr).toLowerCase();
  switch (s) {
    case 'primary': return ButtonStyle.Primary;
    case 'secondary': return ButtonStyle.Secondary;
    case 'success': return ButtonStyle.Success;
    case 'danger': return ButtonStyle.Danger;
    default: return ButtonStyle.Primary;
  }
}

function buildButtonComponent(panelId, button) {
  const { ButtonBuilder } = require('discord.js');
  const b = new ButtonBuilder()
    .setCustomId(makeButtonCustomId(panelId, button.id))
    .setLabel(button.label || 'Button')
    .setStyle(mapStyle(button.style));
  if (button.emoji) {
    try { b.setEmoji(button.emoji); } catch (e) { /* ignore invalid emoji */ }
  }
  return b;
}

function buildRows(panel) {
  const { ActionRowBuilder } = require('discord.js');
  const rows = [];
  let current = [];
  for (const btn of panel.buttons || []) {
    current.push(buildButtonComponent(panel.id, btn));
    if (current.length >= 5) {
      rows.push(new ActionRowBuilder().addComponents(...current));
      current = [];
    }
  }
  if (current.length > 0) rows.push(new ActionRowBuilder().addComponents(...current));
  return rows;
}

const data = new SlashCommandBuilder()
  .setName('ticket-dashboard')
  .setDescription('Ticket panel dashboard (admin)')
  .addSubcommand(sc => sc
    .setName('add')
    .setDescription('Add a button to a panel from the dashboard')
    .addStringOption(opt => opt.setName('panel_id').setDescription('Panel ID (optional if only one panel)').setRequired(false))
    .addStringOption(opt => opt.setName('name').setDescription('Button label').setRequired(true))
    .addStringOption(opt => opt.setName('naming_template').setDescription('Naming template {slug}-{counter:03}').setRequired(false))
    .addChannelOption(opt => opt.setName('category').setDescription('Category for new tickets').setRequired(false))
    .addStringOption(opt => opt.setName('staff_roles').setDescription('Comma-separated role mentions or IDs').setRequired(false))
    .addStringOption(opt => opt.setName('emoji').setDescription('Emoji for the button (optional)').setRequired(false))
    .addStringOption(opt => opt.setName('style').setDescription('Button style: Primary, Secondary, Success, Danger').setRequired(false))
  )
  .addSubcommand(sc => sc
    .setName('edit')
    .setDescription('Edit an existing button from the dashboard')
    .addStringOption(opt => opt.setName('panel_id').setDescription('Panel ID').setRequired(true))
    .addStringOption(opt => opt.setName('button_id').setDescription('Button ID').setRequired(true))
    .addStringOption(opt => opt.setName('name').setDescription('Button label').setRequired(false))
    .addStringOption(opt => opt.setName('naming_template').setDescription('Naming template').setRequired(false))
    .addChannelOption(opt => opt.setName('category').setDescription('Category for new tickets').setRequired(false))
    .addStringOption(opt => opt.setName('staff_roles').setDescription('Comma-separated role mentions or IDs').setRequired(false))
    .addStringOption(opt => opt.setName('emoji').setDescription('Emoji').setRequired(false))
    .addStringOption(opt => opt.setName('style').setDescription('Button style').setRequired(false))
  );

const category = 'ticket';

async function execute(interaction, config, client) {
  try {
    if (!interaction.inGuild()) {
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
      return;
    }
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need Manage Server permission to use the dashboard.' });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      let panelId = interaction.options.getString('panel_id', false);
      const name = interaction.options.getString('name', true);
      const namingTemplate = interaction.options.getString('naming_template', false) || `{slug}-{counter:03}`;
      const categoryOpt = interaction.options.getChannel('category', false);
      const staffRolesRaw = interaction.options.getString('staff_roles', false) || undefined;
      const emoji = interaction.options.getString('emoji', false) || undefined;
      const style = interaction.options.getString('style', false) || undefined;

      if (!panelId) {
        const panels = await listPanels(client, interaction.guildId);
        if (!panels || panels.length === 0) {
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'No panels configured. Create a panel first.' });
          return;
        }
        if (panels.length === 1) panelId = panels[0].id;
        else {
          await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Multiple panels exist — provide panel_id.' });
          return;
        }
      }

      const panel = await getPanel(client, interaction.guildId, panelId);
      if (!panel) { await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Panel not found.' }); return; }

      const staffRoleIds = parseRoleList(staffRolesRaw);

      const button = await addButtonToPanel(client, interaction.guildId, panelId, {
        label: name,
        emoji: emoji || null,
        style: style || 'Primary',
        namingTemplate,
        categoryId: categoryOpt?.id || null,
        staffRoleIds,
      });

      // update panel message if posted
      try {
        const p = await getPanel(client, interaction.guildId, panelId);
        if (p && p.channelId && p.messageId) {
          const ch = await client.channels.fetch(p.channelId).catch(()=>null);
          if (ch) {
            const msg = await ch.messages.fetch(p.messageId).catch(()=>null);
            if (msg) {
              const rows = buildRows(p);
              await msg.edit({ components: rows });
            }
          }
        }
      } catch (e) { console.warn('Failed to update panel after dashboard add', e?.message || e); }

      await interaction.reply({ embeds: [successEmbed('Button Added', `Button **${button.label}** added to panel **${panel.name}**.`)], ephemeral: true });
      return;
    }

    if (sub === 'edit') {
      const panelId = interaction.options.getString('panel_id', true);
      const buttonId = interaction.options.getString('button_id', true);

      const updates = {};
      if (interaction.options.getString('name', false)) updates.label = interaction.options.getString('name', false);
      if (interaction.options.getString('naming_template', false)) updates.namingTemplate = interaction.options.getString('naming_template', false);
      if (interaction.options.getChannel('category', false)) updates.categoryId = interaction.options.getChannel('category', false).id;
      if (interaction.options.getString('staff_roles', false)) updates.staffRoleIds = parseRoleList(interaction.options.getString('staff_roles', false));
      if (interaction.options.getString('emoji', false)) updates.emoji = interaction.options.getString('emoji', false);
      if (interaction.options.getString('style', false)) updates.style = interaction.options.getString('style', false);

      try {
        const updated = await updateButton(client, interaction.guildId, panelId, buttonId, updates);
        // update panel message
        try {
          const p = await getPanel(client, interaction.guildId, panelId);
          if (p && p.channelId && p.messageId) {
            const ch = await client.channels.fetch(p.channelId).catch(()=>null);
            if (ch) {
              const msg = await ch.messages.fetch(p.messageId).catch(()=>null);
              if (msg) {
                const rows = buildRows(p);
                await msg.edit({ components: rows });
              }
            }
          }
        } catch (e) { console.warn('Failed to update panel after dashboard edit', e?.message || e); }

        await interaction.reply({ embeds: [successEmbed('Button Updated', `Button **${updated.label}** updated on panel ${panelId}.`)], ephemeral: true });
      } catch (err) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: err.message || 'Failed to update button.' });
      }
      return;
    }

    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Unknown subcommand.' });
  } catch (error) {
    console.error('ticket-dashboard command error', error);
    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to execute dashboard command.' });
  }
}

const command = { data, category, execute };
export default command;
export { data, execute, category };
