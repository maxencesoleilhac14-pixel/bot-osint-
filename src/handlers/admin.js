import { Markup } from 'telegraf';
import {
  getAllUsers, getUserCount, getPremiumCount,
  getUser, setPremium, removePremium,
  getConfig, setConfig, deleteConfig
} from '../db.js';
import { showPaymentConfig } from './subscription.js';

const ADMIN_ID = parseInt(process.env.ADMIN_ID);

function esc(str) {
  return String(str || '').replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function isAdmin(ctx) {
  return ctx.from.id === ADMIN_ID;
}

function adminGuard(ctx, next) {
  if (!isAdmin(ctx)) {
    ctx.answerCbQuery('⛔ Accès réservé à l\'administrateur');
    return;
  }
  return next();
}

function adminMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Statistiques', 'admin_stats')],
    [Markup.button.callback('👥 Gérer utilisateurs', 'admin_users')],
    [Markup.button.callback('⚙️ Configuration', 'admin_config')],
    [Markup.button.callback('💳 Paiements', 'admin_payments')],
    [Markup.button.callback('📨 Broadcast', 'admin_broadcast')],
    [Markup.button.callback('🔙 Retour au menu', 'back_main')]
  ]);
}

async function showAdminMenu(ctx) {
  const count = getUserCount().count;
  const premium = getPremiumCount().count;
  const cfg = getConfig('daily_limit');
  const dailyLimit = cfg ? cfg.value : '1';

  const text = `👑 **PANEL ADMIN SCARFACE OSINT**
━━━━━━━━━━━━━━━━━━━━━
👥 Utilisateurs : ${count}
⭐ Premium : ${premium}
📋 Limite quotidienne : ${dailyLimit}
━━━━━━━━━━━━━━━━━━━━━`;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...adminMenu() });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...adminMenu() });
  }
}

async function replyOrEdit(ctx, text, keyboard) {
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  }
}

async function showStats(ctx) {
  const count = getUserCount().count;
  const premium = getPremiumCount().count;
  const users = getAllUsers();

  let msg = `📊 **STATISTIQUES**
━━━━━━━━━━━━━━━━━━━━━
👥 Total : ${count}
⭐ Premium : ${premium}
🆓 Gratuits : ${count - premium}
━━━━━━━━━━━━━━━━━━━━━

**Derniers utilisateurs :**
`;
  const recent = users.slice(0, 10);
  recent.forEach(u => {
    const name = esc(u.first_name || u.username || 'Inconnu');
    const badge = u.is_premium ? '⭐' : '🆓';
    msg += `\n${badge} [${u.id}] ${name}`;
  });

  await replyOrEdit(ctx, msg,
    Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Retour admin', 'admin_menu')]
    ])
  );
}

async function showUsers(ctx) {
  const users = getAllUsers();
  let msg = `👥 **GESTION UTILISATEURS** (${users.length})
━━━━━━━━━━━━━━━━━━━━━

`;

  const recent = users.slice(0, 15);
  recent.forEach(u => {
    const name = esc(u.first_name || u.username || 'Inconnu');
    const badge = u.is_premium ? '⭐' : '🆓';
    msg += `\n${badge} \`${u.id}\` - ${name}`;
  });

  if (users.length > 15) msg += `\n\n... et ${users.length - 15} autres`;

  msg += `\n\nUtilise /premium <user_id> pour donner le premium`;

  await replyOrEdit(ctx, msg,
    Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Retour admin', 'admin_menu')]
    ])
  );
}

async function showConfig(ctx) {
  const cfg = getConfig('daily_limit');
  const dailyLimit = cfg ? cfg.value : '1';

  await replyOrEdit(ctx,
    `⚙️ **CONFIGURATION**
━━━━━━━━━━━━━━━━━━━━━
📋 Recherches gratuites/jour : ${dailyLimit}
━━━━━━━━━━━━━━━━━━━━━

Utilise /setlimit <nombre> pour changer la limite`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Retour admin', 'admin_menu')]
    ])
  );
}

async function handleAdminAction(ctx) {
  if (!isAdmin(ctx)) return;

  const action = ctx.callbackQuery.data;

  switch (action) {
    case 'admin_menu':
      await showAdminMenu(ctx);
      break;
    case 'admin_stats':
      await showStats(ctx);
      break;
    case 'admin_users':
      await showUsers(ctx);
      break;
    case 'admin_config':
      await showConfig(ctx);
      break;
    case 'admin_payments':
      await showPaymentConfig(ctx);
      break;
    case 'admin_broadcast':
      ctx.session = ctx.session || {};
      ctx.session.waitingBroadcast = true;
      await replyOrEdit(ctx,
        `📨 **BROADCAST**

Envoie le message à diffuser à tous les utilisateurs :

(tape \`/cancel\` pour annuler)`,
        Markup.inlineKeyboard([
          [Markup.button.callback('❌ Annuler', 'admin_menu')]
        ])
      );
      break;
  }
}

export { isAdmin, adminGuard, adminMenu, showAdminMenu, handleAdminAction, ADMIN_ID };
