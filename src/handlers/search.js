import { Markup } from 'telegraf';
import { getUser, incrementSearch, resetDailySearches, saveSearch, getSearchHistory, getConfig } from '../db.js';
import { searchGeneral, searchDeep, searchFamily, formatResults, formatResultsDeep, formatFamily, exportToTkt, esc } from '../api.js';

function generalMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Recherche Générale', 'search_general')],
    [Markup.button.callback('📜 Mon historique', 'search_history')],
    [Markup.button.callback('🔙 Retour', 'back_main')]
  ]);
}

function resultActionsMenu(page, total, viewMode = 'normal') {
  const nav = [];
  if (total > 1) {
    if (page > 0) nav.push(Markup.button.callback('◀', `page_prev`));
    nav.push(Markup.button.callback(`${page + 1}/${total}`, 'page_info'));
    if (page < total - 1) nav.push(Markup.button.callback('▶', `page_next`));
  }

  const rows = [];
  if (nav.length) rows.push(nav);

  if (viewMode === 'normal') {
    rows.push(
      [Markup.button.callback('🔍 Approfondir', 'result_deep')],
      [Markup.button.callback('👨‍👩‍👧‍👦 Famille', 'result_family')],
      [Markup.button.callback('📥 .tkt', 'result_export')],
      [Markup.button.callback('🔎 Nouvelle recherche', 'search_general')],
      [Markup.button.callback('📜 Historique', 'search_history')],
      [Markup.button.callback('🏠 Menu', 'back_main')]
    );
  } else {
    rows.push(
      [Markup.button.callback('🔙 Retour résultats', 'result_back')],
      [Markup.button.callback('📥 .tkt', 'result_export')],
      [Markup.button.callback('🔎 Nouvelle recherche', 'search_general')],
      [Markup.button.callback('🏠 Menu', 'back_main')]
    );
  }
  return Markup.inlineKeyboard(rows);
}

function parseInput(text) {
  const tokens = text.trim().split(/\s+/);
  const body = {};

  for (const token of tokens) {
    if (/^(\+33|0033|0)[1-9]\d{8}$/.test(token) || /^\+33\d{9}$/.test(token)) {
      body.telephone = token.replace(/[^0-9]/g, '');
    } else if (/^[\w.-]+@[\w.-]+\.\w+$/.test(token.toLowerCase())) {
      body.email = token.toLowerCase();
    }
  }

  const remaining = tokens.filter(t =>
    !(/^(\+33|0033|0)[1-9]\d{8}$/.test(t) || /^\+33\d{9}$/.test(t) || /^[\w.-]+@[\w.-]+\.\w+$/.test(t.toLowerCase()))
  );

  if (remaining.length >= 2) {
    body.nom_famille = remaining[0];
    body.prenom = remaining[1];
    if (remaining.length >= 3) body.ville = remaining.slice(2).join(' ');
  } else if (remaining.length === 1) {
    body.nom_famille = remaining[0];
  }

  return body;
}

function parseInputAllPerms(text) {
  const base = parseInput(text);
  const tokens = text.trim().split(/\s+/);
  const remaining = tokens.filter(t =>
    !(/^(\+33|0033|0)[1-9]\d{8}$/.test(t) || /^\+33\d{9}$/.test(t) || /^[\w.-]+@[\w.-]+\.\w+$/.test(t.toLowerCase()))
  );

  const bodies = [];

  // Si le premier mot est un nombre → c'est une adresse (ex: "131 Chemin des...")
  if (remaining.length >= 2 && /^\d+/.test(remaining[0])) {
    bodies.push({ adresse: remaining.join(' '), flexible: true });
    return bodies;
  }

  if (remaining.length >= 2) {
    bodies.push({ nom_famille: remaining[0], prenom: remaining[1] });
    bodies.push({ nom_famille: remaining[1], prenom: remaining[0] });
  } else if (remaining.length === 1) {
    bodies.push({ nom_famille: remaining[0], flexible: true });
  }

  // Recherche par téléphone seul ou email seul
  if (bodies.length === 0) {
    if (base.telephone) bodies.push({ telephone: base.telephone, flexible: true });
    if (base.email) bodies.push({ email: base.email, flexible: true });
  }

  if (base.telephone) bodies.forEach(b => b.telephone = base.telephone);
  if (base.email) bodies.forEach(b => b.email = base.email);
  bodies.forEach(b => b.flexible = true);

  return bodies;
}

function canSearch(user) {
  const cfg = getConfig('daily_limit');
  const dailyLimit = parseInt(cfg ? cfg.value : '1');
  if (user && user.is_premium) return true;
  resetDailySearches();
  const updated = getUser(user ? user.id : 0);
  return updated && (updated.searches_today || 0) < dailyLimit;
}

function getRemaining(user) {
  if (user && user.is_premium) return '♾️ Illimité';
  const cfg = getConfig('daily_limit');
  const limit = parseInt(cfg ? cfg.value : '1');
  return `${Math.max(0, limit - (user ? user.searches_today || 0 : 0))} restante(s)`;
}

async function showGeneralMenu(ctx) {
  const user = getUser(ctx.from.id);
  if (!canSearch(user)) {
    await ctx.editMessageText(
      '❌ **Limite quotidienne atteinte !**\n\n⭐ Passe Premium pour des recherches illimitées.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⭐ Premium', 'premium_info')],
          [Markup.button.callback('🔙 Retour', 'back_main')]
        ])
      }
    );
    return;
  }

  await ctx.editMessageText(
    `🔍 **RECHERCHE GÉNÉRALE**
━━━━━━━━━━━━━━━━━━━━━
📊 ${getRemaining(user)}

Envoie toutes les informations que tu as en une seule ligne :

Exemples :
\`\`\`
Martin Jean 0612345678 Paris
\`\`\`
\`\`\`
Sophie Martin sophie@email.com
\`\`\`
\`\`\`
Martin 0612345678 Lyon martin@email.com
\`\`\`

Le robot détecte automatiquement :
📱 Téléphone 📧 Email 👤 Nom 🏙️ Ville
━━━━━━━━━━━━━━━━━━━━━`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Annuler', 'back_main')]
      ])
    }
  );
}

async function showHistory(ctx) {
  const history = getSearchHistory(ctx.from.id);
  if (!history.length) {
    await ctx.editMessageText(
      '📜 **HISTORIQUE**\n\nAucune recherche pour le moment.',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Retour', 'back_main')]]) }
    );
    return;
  }

  let msg = `📜 **HISTORIQUE** (${history.length})\n━━━━━━━━━━━━━━━━━━━━━\n`;
  const recent = history.slice(0, 15);
  recent.forEach((h, i) => {
    msg += `\n${i + 1}. \`${esc(h.query)}\` — ${new Date(h.created_at).toLocaleDateString('fr-FR')}`;
  });

  await ctx.editMessageText(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🗑 Effacer', 'clear_history')],
      [Markup.button.callback('🔙 Retour', 'back_main')]
    ])
  });
}

export { generalMenu, resultActionsMenu, parseInput, parseInputAllPerms, canSearch, getRemaining, showGeneralMenu, showHistory };
