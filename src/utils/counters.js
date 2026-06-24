export async function getNextButtonCounter(client, guildId, panelId, buttonId) {
  // Prefer atomic INCR if available on client.db (Redis-like). Fallback to panels.js increment.
  try {
    if (client?.db && typeof client.db.incr === 'function') {
      const key = `ticket_panel_counter:${guildId}:${panelId}:${buttonId}`;
      const val = await client.db.incr(key);
      return Number(val);
    }
  } catch (err) {
    // If Redis/incr fails, fall back to panels increment
    // eslint-disable-next-line no-console
    console.warn('Atomic counter increment failed, falling back to panels increment:', err?.message || err);
  }

  // Fallback: use panels.incrementButtonCounter
  const { incrementButtonCounter } = await import('./panels.js');
  return await incrementButtonCounter(client, guildId, panelId, buttonId);
}
