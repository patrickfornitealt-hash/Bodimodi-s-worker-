import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const TOKEN = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN || process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || '1518195505388191835';

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing BOT_TOKEN/DISCORD_TOKEN/TOKEN or CLIENT_ID env vars.');
  process.exit(1);
}

const buttonCommand = new SlashCommandBuilder()
  .setName('button')
  .setDescription('Manage ticket panel buttons')
  .addSubcommand(sc => sc.setName('add').setDescription('Add a button').addStringOption(o => o.setName('name').setRequired(true)))
  .addSubcommand(sc => sc.setName('ad').setDescription('Alias for add').addStringOption(o => o.setName('name').setRequired(true)))
  .addSubcommand(sc => sc.setName('edit').setDescription('Edit a button').addStringOption(o => o.setName('panel_id').setRequired(true)).addStringOption(o => o.setName('button_id').setRequired(true)))
  .addSubcommand(sc => sc.setName('remove').setDescription('Remove a button').addStringOption(o => o.setName('panel_id').setRequired(true)).addStringOption(o => o.setName('button_id').setRequired(true)))
  .addSubcommand(sc => sc.setName('preview').setDescription('Preview a button').addStringOption(o => o.setName('panel_id').setRequired(true)).addStringOption(o => o.setName('button_id').setRequired(true)));

const dashboardCommand = new SlashCommandBuilder()
  .setName('ticket-dashboard')
  .setDescription('Ticket panel dashboard (admin)')
  .addSubcommand(sc => sc.setName('add').setDescription('Add a button').addStringOption(o => o.setName('name').setRequired(true)))
  .addSubcommand(sc => sc.setName('edit').setDescription('Edit a button').addStringOption(o => o.setName('panel_id').setRequired(true)).addStringOption(o => o.setName('button_id').setRequired(true)));

const commands = [buttonCommand.toJSON(), dashboardCommand.toJSON()];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('Registering commands to guild', GUILD_ID);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('Commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
