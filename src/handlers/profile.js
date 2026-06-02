import { Markup } from 'telegraf';
import { getUser } from '../db.js';
import { getSearchHistory } from '../db.js';

function esc(str) {
  return String(str || '').replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

async function showProfile(ctx) {
  const user = getUser(ctx.from.id);
  if (!user) {
    await ctx.editMessageText('❌ Utilisateur introuvable.', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Retour', 'back_main')]])
    });
    return;
  }

  const history = getSearchHistory(ctx.from.id);
  const badge = user.is_premium ? '⭐ **PREMIUM**' : '🆓 **Gratuit**';
  const searchesLeft = user.is_premium
    ? '♾️ Illimité'
    : `${Math.max(0, 1 - (user.searches_today || 0))} recherche(s) aujourd'hui`;

  await ctx.editMessageText(
    `👤 **MON PROFIL**
━━━━━━━━━━━━━━━━━━━━━
🆔 ID : \`${user.id}\`
👤 Nom : ${esc(user.first_name)}
💎 Statut : ${badge}
📊 Recherches effectuées : ${history.length}
📋 Recherches restantes : ${searchesLeft}
📅 Inscrit le : ${new Date(user.joined_at).toLocaleDateString('fr-FR')}
━━━━━━━━━━━━━━━━━━━━━`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Retour', 'back_main')]
      ])
    }
  );
}

export { showProfile };
