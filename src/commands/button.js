import { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
  listPanels,
  getPanel,
  addButtonToPanel,
  updateButton,
  removeButton,
  makeButtonCustomId,
  updatePanel,
} from '../utils/panels.js';
import { successEmbed } from '../utils/embeds.js';
import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';

function parseRoleList(input) {
  if (!input) return [];
  // accept comma-separated mentions or ids like <@&id> or plain ids
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
  .setName('button')
  .setDescription('Manage ticket panel buttons')
  .addSubcommand(sc => sc
    .setName('add')
    .setDescription('Add a button to a panel')
    .addStringOption(opt => opt.setName('panel_id').setDescription('ID of the panel (optional if only one panel)').setRequired(false))
    .addStringOption(opt => opt.setName('name').setDescription('Button label').setRequired(true))
    .addStringOption(opt => opt.setName('naming_template').setDescription('Naming template {slug}-{counter:03}').setRequired(false))
    .addChannelOption(opt => opt.setName('category').setDescription('Category for new tickets').setRequired(false))
    .addStringOption(opt => opt.setName('staff_roles').setDescription('Comma-separated role mentions or IDs').setRequired(false))
    .addChannelOption(opt => opt.setName('log_channel').setDescription('Log channel for this button').setRequired(false))
    .addStringOption(opt => opt.setName('emoji').setDescription('Emoji for the button (optional)').setRequired(false))
    .addStringOption(opt => opt.setName('style').setDescription('Button style: Primary, Secondary, Success, Danger').setRequired(false))
  )
  // alias subcommand 'ad' to match shorthand requested by admins
  .addSubcommand(sc => sc
    .setName('ad')
    .setDescription('Alias for add (admin shorthand)')
    .addStringOption(opt => opt.setName('panel_id').setDescription('ID of the panel (optional if only one panel)').setRequired(false))
    .addStringOption(opt => opt.setName('name').setDescription('Button label').setRequired(true))
    .addStringOption(opt => opt.setName('naming_template').setDescription('Naming template {slug}-{counter:03}').setRequired(false))
    .addChannelOption(opt => opt.setName('category').setDescription('Category for new tickets').setRequired(false))
    .addStringOption(opt => opt.setName('staff_roles').setDescription('Comma-separated role mentions or IDs').setRequired(false))
    .addChannelOption(opt => opt.setName('log_channel').setDescription('Log channel for this button').setRequired(false))
    .addStringOption(opt => opt.setName('emoji').setDescription('Emoji for the button (optional)').setRequired(false))
    .addStringOption(opt => opt.setName('style').setDescription('Button style: Primary, Secondary, Success, Danger').setRequired(false))
  )
  .addSubcommand(sc => sc
    .setName('edit')
    .setDescription('Edit a button')
    .addStringOption(opt => opt.setName('panel_id').setDescription('ID of the panel').setRequired(true))
    .addStringOption(opt => opt.setName('button_id').setDescription('ID of the button').setRequired(true))
    .addStringOption(opt => opt.setName('name').setDescription('Button label'))
    .addStringOption(opt => opt.setName('naming_template').setDescription('Naming template'))
    .addChannelOption(opt => opt.setName('category').setDescription('Category for new tickets'))
    .addStringOption(opt => opt.setName('staff_roles').setDescription('Comma-separated role mentions or IDs'))
    .addChannelOption(opt => opt.setName('log_channel').setDescription('Log channel for this button'))
    .addStringOption(opt => opt.setName('emoji').setDescription('Emoji'))
    .addStringOption(opt => opt.setName('style').setDescription('Button style: Primary, Secondary, Success, Danger'))
    .addBooleanOption(opt => opt.setName('allow_multiple_claims').setDescription('Allow multiple staff to claim this ticket'))
  )
  .addSubcommand(sc => sc
    .setName('remove')
    .setDescription('Remove a button from a panel')
    .addStringOption(opt => opt.setName('panel_id').setDescription('ID of the panel').setRequired(true))
    .addStringOption(opt => opt.setName('button_id').setDescription('ID of the button').setRequired(true))
  )
  .addSubcommand(sc => sc
    .setName('preview')
    .setDescription('Preview a button configuration (example channel name and embed)')
    .addStringOption(opt => opt.setName('panel_id').setDescription('ID of the panel').setRequired(true))
    .addStringOption(opt => opt.setName('button_id').setDescription('ID of the button').setRequired(true))
  );

const category = 'ticket';

async function execute(interaction, config, client) {
  try {
    if (!interaction.inGuild()) {
      await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
      return;
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need Manage Server permission to manage buttons.' });
      return;
    }

    let sub = interaction.options.getSubcommand();
    // normalize alias
    if (sub === 'ad') sub = 'add';

    if (sub === 'add') {
      let panelId = interaction.options.getString('panel_id', false);
      const name = interaction.options.getString('name', true);
      const namingTemplate = interaction.options.getString('naming_template', false) || undefined;
      const categoryOpt = interaction.options.getChannel('category', false);
      const staffRolesRaw = interaction.options.getString('staff_roles', false) || undefined;
      const logChannel = interaction.options.getChannel('log_channel', false);
      const emoji = interaction.options.getString('emoji', false) || undefined;
      const style = interaction.options.getString('style', false) || undefined;

      // determine panel if not provided and only one exists
      if (!panelId) {
        const panels = await listPanels(client, interaction.guildId);
        if (!panels || panels.length === 0) {
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'No panels configured for this server. Create a panel first.' });
          return;
        }
        if (panels.length === 1) {
          panelId = panels[0].id;
        } else {
          await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Multiple panels exist — please provide panel_id.' });
          return;
        }
      }

      // ensure panel exists
      const panel = await getPanel(client, interaction.guildId, panelId);
      if (!panel) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Panel not found.' });
        return;
      }

      const staffRoleIds = parseRoleList(staffRolesRaw);

      const button = await addButtonToPanel(client, interaction.guildId, panelId, {
        label: name,
        emoji: emoji || null,
        style: style || 'Primary',
        namingTemplate: namingTemplate || `{slug}-{counter:03}`,
        categoryId: categoryOpt?.id || null,
        staffRoleIds,
        logChannelId: logChannel?.id || null,
      });

      // update posted message if exists
      try {
        const p = await getPanel(client, interaction.guildId, panelId);
        if (p && p.channelId && p.messageId) {
          const ch = await client.channels.fetch(p.channelId).catch(() => null);
          if (ch) {
            const msg = await ch.messages.fetch(p.messageId).catch(() => null);
            if (msg) {
              const rows = buildRows(p);
              await msg.edit({ components: rows });
            }
          }
        }
      } catch (e) {
        console.warn('Failed to update panel message after add:', e?.message || e);
      }

      await interaction.reply({ embeds: [successEmbed('Button Created', `Button **${button.label}** added to panel **${panel.name}** (id: ${panelId}).`)], ephemeral: true });
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
      if (interaction.options.getChannel('log_channel', false)) updates.logChannelId = interaction.options.getChannel('log_channel', false).id;
      if (interaction.options.getString('emoji', false)) updates.emoji = interaction.options.getString('emoji', false);
      if (interaction.options.getString('style', false)) updates.style = interaction.options.getString('style', false);
      if (interaction.options.getBoolean('allow_multiple_claims', false) !== null) updates.allowMultipleClaims = interaction.options.getBoolean('allow_multiple_claims', false) === true;

      try {
        const updated = await updateButton(client, interaction.guildId, panelId, buttonId, updates);

        // update posted message if exists
        try {
          const p = await getPanel(client, interaction.guildId, panelId);
          if (p && p.channelId && p.messageId) {
            const ch = await client.channels.fetch(p.channelId).catch(() => null);
            if (ch) {
              const msg = await ch.messages.fetch(p.messageId).catch(() => null);
              if (msg) {
                const rows = buildRows(p);
                await msg.edit({ components: rows });
              }
            }
          }
        } catch (e) {
          console.warn('Failed to update panel message after edit:', e?.message || e);
        }

        await interaction.reply({ embeds: [successEmbed('Button Updated', `Button **${updated.label}** updated on panel ${panelId}.`)], ephemeral: true });
      } catch (err) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: err.message || 'Failed to update button.' });
      }

      return;
    }

    if (sub === 'remove') {
      const panelId = interaction.options.getString('panel_id', true);
      const buttonId = interaction.options.getString('button_id', true);

      try {
        const removed = await removeButton(client, interaction.guildId, panelId, buttonId);
        if (!removed) {
          await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Button not found.' });
          return;
        }

        // update posted message if exists
        try {
          const p = await getPanel(client, interaction.guildId, panelId);
          if (p && p.channelId && p.messageId) {
            const ch = await client.channels.fetch(p.channelId).catch(() => null);
            if (ch) {
              const msg = await ch.messages.fetch(p.messageId).catch(() => null);
              if (msg) {
                const rows = buildRows(p);
                await msg.edit({ components: rows });
              }
            }
          }
        } catch (e) {
          console.warn('Failed to update panel message after remove:', e?.message || e);
        }

        await interaction.reply({ embeds: [successEmbed('Button Removed', `Button ${buttonId} removed from panel ${panelId}.`)], ephemeral: true });
      } catch (err) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: err.message || 'Failed to remove button.' });
      }

      return;
    }

    if (sub === 'preview') {
      const panelId = interaction.options.getString('panel_id', true);
      const buttonId = interaction.options.getString('button_id', true);

      const panel = await getPanel(client, interaction.guildId, panelId);
      if (!panel) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Panel not found.' });
        return;
      }
      const button = panel.buttons.find(b => b.id === buttonId);
      if (!button) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Button not found.' });
        return;
      }

      const slug = button.slug || (button.label || 'ticket').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const exampleName = (button.namingTemplate || '{slug}-{counter}').replace(/\{slug\}/g, slug).replace(/\{counter(?::0?(\d+))?\}/g, (_, pad) => pad ? '001' : '1');

      const embed = successEmbed('Button Preview', `Label: **${button.label}**\nStyle: **${button.style}**\nEmoji: ${button.emoji || 'none'}\nCategory: ${button.categoryId ? `<#${button.categoryId}>` : 'not set'}\nStaff Roles: ${button.staffRoleIds && button.staffRoleIds.length ? button.staffRoleIds.map(r=>`<@&${r}>`).join(', ') : 'none'}\nNaming example: **${exampleName}**`);
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Unknown subcommand.' });
  } catch (error) {
    console.error('Button command error', error);
    await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Failed to execute button command.' });
  }
}

const command = { data, category, execute };

export default command;
export { data, execute, category };
