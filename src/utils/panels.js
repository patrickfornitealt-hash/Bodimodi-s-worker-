import { randomUUID } from 'crypto';

const PANELS_KEY_PREFIX = 'ticket_panels:';

function panelsKey(guildId) {
  return `${PANELS_KEY_PREFIX}${guildId}`;
}

async function getRawPanels(client, guildId) {
  if (!client.db) return [];
  const key = panelsKey(guildId);
  const raw = await client.db.get(key).catch(() => null);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    return raw;
  }
}

async function saveRawPanels(client, guildId, panels) {
  if (!client.db) return;
  const key = panelsKey(guildId);
  await client.db.set(key, JSON.stringify(panels));
}

export async function listPanels(client, guildId) {
  return await getRawPanels(client, guildId);
}

export async function createPanel(client, guildId, attrs = {}) {
  const panels = await getRawPanels(client, guildId);
  const id = randomUUID();
  const panel = Object.assign({
    id,
    name: attrs.name || `Panel ${panels.length + 1}`,
    channelId: attrs.channelId || null,
    messageId: attrs.messageId || null,
    embed: attrs.embed || {},
    buttons: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, attrs);

  panels.push(panel);
  await saveRawPanels(client, guildId, panels);
  return panel;
}

export async function getPanelByMessageId(client, guildId, messageId) {
  const panels = await getRawPanels(client, guildId);
  return panels.find(p => p.messageId === String(messageId));
}

export async function getPanel(client, guildId, panelId) {
  const panels = await getRawPanels(client, guildId);
  return panels.find(p => p.id === panelId) || null;
}

export async function addButtonToPanel(client, guildId, panelId, buttonAttrs = {}) {
  const panels = await getRawPanels(client, guildId);
  const panel = panels.find(p => p.id === panelId);
  if (!panel) throw new Error('Panel not found');

  const id = randomUUID();
  const button = Object.assign({
    id,
    label: buttonAttrs.label || 'Button',
    style: buttonAttrs.style || 'Primary',
    emoji: buttonAttrs.emoji || null,
    slug: buttonAttrs.slug || (buttonAttrs.label || 'button').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
    categoryId: buttonAttrs.categoryId || null,
    namingTemplate: buttonAttrs.namingTemplate || '{slug}-{counter}',
    staffRoleIds: buttonAttrs.staffRoleIds || [],
    logChannelId: buttonAttrs.logChannelId || null,
    counter: buttonAttrs.counter || 0,
    allowMultipleClaims: buttonAttrs.allowMultipleClaims === true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, buttonAttrs);

  panel.buttons.push(button);
  panel.updatedAt = new Date().toISOString();
  await saveRawPanels(client, guildId, panels);
  return button;
}

export async function getButton(client, guildId, panelId, buttonId) {
  const panel = await getPanel(client, guildId, panelId);
  if (!panel) return null;
  return panel.buttons.find(b => b.id === buttonId) || null;
}

export function makeButtonCustomId(panelId, buttonId) {
  // Use colon-separated format so the interaction loader splits it into args
  return `create_ticket:${panelId}:${buttonId}`;
}

export async function incrementButtonCounter(client, guildId, panelId, buttonId) {
  const panels = await getRawPanels(client, guildId);
  const panel = panels.find(p => p.id === panelId);
  if (!panel) throw new Error('Panel not found');
  const button = panel.buttons.find(b => b.id === buttonId);
  if (!button) throw new Error('Button not found');

  button.counter = (Number(button.counter) || 0) + 1;
  button.updatedAt = new Date().toISOString();
  panel.updatedAt = new Date().toISOString();
  await saveRawPanels(client, guildId, panels);
  return button.counter;
}

export async function updateButton(client, guildId, panelId, buttonId, updates = {}) {
  const panels = await getRawPanels(client, guildId);
  const panel = panels.find(p => p.id === panelId);
  if (!panel) throw new Error('Panel not found');
  const idx = panel.buttons.findIndex(b => b.id === buttonId);
  if (idx === -1) throw new Error('Button not found');
  panel.buttons[idx] = { ...panel.buttons[idx], ...updates, updatedAt: new Date().toISOString() };
  panel.updatedAt = new Date().toISOString();
  await saveRawPanels(client, guildId, panels);
  return panel.buttons[idx];
}

export async function removeButton(client, guildId, panelId, buttonId) {
  const panels = await getRawPanels(client, guildId);
  const panel = panels.find(p => p.id === panelId);
  if (!panel) throw new Error('Panel not found');
  const before = panel.buttons.length;
  panel.buttons = panel.buttons.filter(b => b.id !== buttonId);
  panel.updatedAt = new Date().toISOString();
  await saveRawPanels(client, guildId, panels);
  return before !== panel.buttons.length;
}
