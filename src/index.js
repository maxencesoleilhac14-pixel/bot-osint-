import 'dotenv/config';
import { Telegraf, Markup, session } from 'telegraf';
import { initDb, upsertUser, getUser, incrementSearch, saveSearch, getSearchHistory, deleteSearchHistory, getAllUsers, getConfig, setConfig } from './db.js';
import { isAdmin, showAdminMenu, handleAdminAction, ADMIN_ID } from './handlers/admin.js';
import { generalMenu, resultActionsMenu, parseInput, parseInputAllPerms, canSearch, getRemaining, showGeneralMenu, showHistory } from './handlers/search.js';
import { TIERS, showPremiumInfo, showTierInfo, showPaymentMethod, handlePaymentDone, handlePaymentProof, handleApprove, handleReject, togglePaymentMethod, showPaymentConfig, handleSetPremium, handleRemovePremium } from './handlers/subscription.js';
import { showProfile } from './handlers/profile.js';
import { searchGeneral, searchDeep, searchFamily, formatResults, formatResultsDeep, formatFamily, exportToTkt, esc } from './api.js';

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

bot.use((ctx, next) => {
  if (ctx.from) {
    upsertUser(ctx.from.id, ctx.from.username || null, ctx.from.first_name || null, ctx.from.last_name || null);
  }
  return next();
});

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Recherche Générale', 'search_general')],
    [Markup.button.callback('⭐ Premium', 'premium_info')],
    [Markup.button.callback('👤 Mon Profil', 'profile')]
  ]);
}

bot.start(async (ctx) => {
  const isAdminUser = isAdmin(ctx);
  const msg = `🔥 **SCARFACE OSINT**
━━━━━━━━━━━━━━━━━━━━━
Bienvenue ${esc(ctx.from.first_name)} !

Bot de recherche OSINT puissant.
🔍 Envoie toutes les infos en une ligne, on cherche tout !

━━━━━━━━━━━━━━━━━━━━━
📋 1 recherche gratuite/jour
⭐ Premium illimité
━━━━━━━━━━━━━━━━━━━━━${isAdminUser ? '\n\n👑 Mode Admin détecté — /admin' : ''}`;

  await ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu() });
});

bot.action('back_main', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.searchType = null;
  ctx.session.lastQuery = null;
  ctx.session.results = null;
  ctx.session.page = 0;
  await ctx.editMessageText(
    `🔥 **SCARFACE OSINT**
━━━━━━━━━━━━━━━━━━━━━
Que veux-tu faire ?${isAdmin(ctx) ? '\n\n👑 /admin' : ''}`,
    { parse_mode: 'Markdown', ...mainMenu() }
  );
});

bot.action('search_general', async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.searchType = 'general';
  await showGeneralMenu(ctx);
});
bot.action('premium_info', async (ctx) => { await showPremiumInfo(ctx); });

bot.action(/^tier_select_(.+)$/, async (ctx) => { await showTierInfo(ctx, ctx.match[1]); });
bot.action(/^pay_method_(.+)_(.+)$/, async (ctx) => { await showPaymentMethod(ctx, ctx.match[1], ctx.match[2]); });
bot.action(/^pay_done_(.+)_(.+)$/, async (ctx) => { await handlePaymentDone(ctx, ctx.match[1], ctx.match[2]); });
bot.action(/^approve_(\d+)_(.+)$/, async (ctx) => { await handleApprove(ctx, ctx.match[1], ctx.match[2]); });
bot.action(/^reject_(\d+)$/, async (ctx) => { await handleReject(ctx, ctx.match[1]); });
bot.action(/^paytoggle_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await togglePaymentMethod(ctx, ctx.match[1]);
  await showPaymentConfig(ctx);
});

bot.action('profile', async (ctx) => { await showProfile(ctx); });
bot.action('search_history', async (ctx) => { await showHistory(ctx); });

bot.action('clear_history', async (ctx) => {
  deleteSearchHistory(ctx.from.id);
  await ctx.answerCbQuery('✅ Historique effacé');
  await ctx.editMessageText('🗑 **Historique effacé !**', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Retour', 'back_main')]])
  });
});

// Pagination
bot.action('page_next', async (ctx) => {
  ctx.session = ctx.session || {};
  const items = ctx.session.results || [];
  const total = items.length;
  if (!total) return await ctx.answerCbQuery('Aucun résultat');
  const page = Math.min((ctx.session.page || 0) + 1, total - 1);
  ctx.session.page = page;
  const mode = ctx.session.viewMode || 'normal';
  await ctx.editMessageText(formatResults([items[page]]), {
    parse_mode: 'Markdown',
    ...resultActionsMenu(page, total, mode)
  });
});

bot.action('page_prev', async (ctx) => {
  ctx.session = ctx.session || {};
  const items = ctx.session.results || [];
  const total = items.length;
  if (!total) return await ctx.answerCbQuery('Aucun résultat');
  const page = Math.max((ctx.session.page || 0) - 1, 0);
  ctx.session.page = page;
  const mode = ctx.session.viewMode || 'normal';
  await ctx.editMessageText(formatResults([items[page]]), {
    parse_mode: 'Markdown',
    ...resultActionsMenu(page, total, mode)
  });
});

bot.action('page_info', async (ctx) => { await ctx.answerCbQuery(`Page ${(ctx.session?.page || 0) + 1}/${ctx.session?.results?.length || 1}`); });

// Résultat actions
bot.action('result_deep', async (ctx) => {
  ctx.session = ctx.session || {};
  const query = ctx.session.lastQuery;
  if (!query) return await ctx.answerCbQuery('Aucune recherche précédente');
  if (!ctx.session.normalResults) ctx.session.normalResults = ctx.session.results || [];
  if (!ctx.session.normalPage) ctx.session.normalPage = ctx.session.page || 0;
  try {
    const bodies = parseInputAllPerms(query);
    const body = bodies[0] || { nom_famille: query };
    const { items } = await searchDeep(body);
    ctx.session.results = items;
    ctx.session.page = 0;
    ctx.session.viewMode = 'deep';
    const text = items.length ? formatResultsDeep(items) : '❌ Aucun résultat approfondi.';
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...resultActionsMenu(0, items.length, 'deep')
    });
  } catch (e) {
    await ctx.editMessageText(`❌ **Erreur**\n\n${esc(e.message)}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Retour', 'back_main')]])
    });
  }
});

bot.action('result_family', async (ctx) => {
  ctx.session = ctx.session || {};
  const currentResults = ctx.session.normalResults || ctx.session.results || [];
  const currentPage = ctx.session.normalPage || ctx.session.page || 0;
  const currentItem = currentResults[currentPage];
  if (!currentItem) return await ctx.answerCbQuery('Aucun résultat à utiliser');
  if (!ctx.session.normalResults) ctx.session.normalResults = currentResults;
  if (!ctx.session.normalPage) ctx.session.normalPage = currentPage;
  try {
    const { items } = await searchFamily(currentItem);
    ctx.session.results = items;
    ctx.session.page = 0;
    ctx.session.viewMode = 'family';
    const text = items.length ? formatFamily(items) : '❌ Aucun lien familial trouvé (même adresse, téléphone ou email).';
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...resultActionsMenu(0, items.length, 'family')
    });
  } catch (e) {
    await ctx.editMessageText(`❌ **Erreur**\n\n${esc(e.message)}`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Retour', 'back_main')]])
    });
  }
});

bot.action('result_back', async (ctx) => {
  ctx.session = ctx.session || {};
  const items = ctx.session.normalResults || [];
  if (!items.length) return await ctx.answerCbQuery('Plus de résultats en cache');
  const page = ctx.session.normalPage || 0;
  ctx.session.results = items;
  ctx.session.page = page;
  ctx.session.viewMode = 'normal';
  ctx.session.normalResults = null;
  ctx.session.normalPage = null;
  await ctx.editMessageText(formatResults([items[page]]), {
    parse_mode: 'Markdown',
    ...resultActionsMenu(page, items.length, 'normal')
  });
});

bot.action('result_export', async (ctx) => {
  ctx.session = ctx.session || {};
  const items = ctx.session.results || [];
  const query = ctx.session.lastQuery || 'recherche';
  if (!items.length) return await ctx.answerCbQuery('Aucun résultat à exporter');
  try {
    const tktContent = exportToTkt(items, query);
    const filename = `scarface_${Date.now()}.tkt`;
    await ctx.replyWithDocument({
      source: Buffer.from(tktContent, 'utf-8'),
      filename
    }, { caption: `📥 Résultats "${query}"` });
    await ctx.answerCbQuery('✅ Fichier envoyé');
  } catch (e) {
    await ctx.answerCbQuery('❌ Erreur export');
  }
});

// Admin
bot.action('admin_menu', async (ctx) => { await handleAdminAction(ctx); });
bot.action(/^admin_/, async (ctx) => {
  if (!isAdmin(ctx)) return await ctx.answerCbQuery('⛔ Accès réservé');
  await handleAdminAction(ctx);
});

bot.hears(/^\/admin/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Accès réservé');
  await showAdminMenu(ctx);
});

bot.hears(/^\/premium (\d+)(?:\s+(.+))?$/, async (ctx) => { await handleSetPremium(ctx, ctx.match[1], ctx.match[2]); });
bot.hears(/^\/unpremium (\d+)$/, async (ctx) => { await handleRemovePremium(ctx, ctx.match[1]); });
bot.hears(/^\/approve (\d+)(?:\s+(.+))?$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await handleApprove(ctx, ctx.match[1], ctx.match[2] || '1m');
});
bot.hears(/^\/reject (\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  await handleReject(ctx, ctx.match[1]);
});
bot.hears(/^\/setlimit (\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return;
  setConfig('daily_limit', ctx.match[1]);
  await ctx.reply(`✅ Limite changée à **${ctx.match[1]}** recherche(s)`, { parse_mode: 'Markdown' });
});

bot.hears(/^\/cancel$/, async (ctx) => {
  ctx.session = ctx.session || {};
  if (ctx.session.waitingBroadcast) {
    ctx.session.waitingBroadcast = false;
    await ctx.reply('❌ Broadcast annulé.', { ...Markup.inlineKeyboard([[Markup.button.callback('👑 Admin', 'admin_menu')]]) });
  }
  if (ctx.session.searchType) {
    ctx.session.searchType = null;
    await ctx.reply('❌ Annulé.', { ...Markup.inlineKeyboard([[Markup.button.callback('🔍 Recherche', 'search_general')]]) });
  }
});

// Broadcast
bot.on('text', async (ctx) => {
  ctx.session = ctx.session || {};

  if (ctx.session.waitingBroadcast && isAdmin(ctx)) {
    const users = getAllUsers();
    let sent = 0, failed = 0;
    const msg = ctx.message.text;
    await ctx.reply(`📨 Envoi à ${users.length} utilisateurs...`);
    for (const user of users) {
      try {
        await ctx.telegram.sendMessage(user.id, msg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔍 Rechercher', 'search_general')]])
        });
        sent++;
      } catch { failed++; }
    }
    ctx.session.waitingBroadcast = false;
    await ctx.reply(
      `✅ **Broadcast terminé !**\n━━━━━━━━━━━━━━━━━━━━━\n✅ Envoyé : ${sent}\n❌ Échec : ${failed}\n━━━━━━━━━━━━━━━━━━━━━`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('👑 Admin', 'admin_menu')]]) }
    );
    return;
  }

  if (ctx.session.waitingPaymentProof) {
    await handlePaymentProof(ctx, ctx.message.text);
    return;
  }

  if (ctx.session.searchType === 'general') {
    const query = ctx.message.text.trim();
    if (!query || query.length < 3) {
      await ctx.reply('❌ Requête trop courte (minimum 3 caractères)');
      return;
    }

    const user = getUser(ctx.from.id);
    if (!canSearch(user)) {
      ctx.session.searchType = null;
      await ctx.reply('❌ **Limite atteinte !**\n\n⭐ Passe Premium.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('⭐ Premium', 'premium_info')]])
      });
      return;
    }

    const statusMsg = await ctx.reply(`🔍 Recherche en cours...`, { parse_mode: 'Markdown' });

    try {
      const bodies = parseInputAllPerms(query);
      if (!bodies.length || (!bodies[0].nom_famille && !bodies[0].telephone && !bodies[0].email)) {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          '❌ Aucune info détectée.\n\nEnvoie au moins un nom, un téléphone (06...) ou un email.',
          { ...Markup.inlineKeyboard([[Markup.button.callback('🔍 Réessayer', 'search_general')]]) }
        );
        return;
      }

      const { items } = await searchGeneral(bodies);
      incrementSearch(ctx.from.id);
      ctx.session.searchType = null;
      ctx.session.lastQuery = query;
      ctx.session.results = items;
      ctx.session.page = 0;
      ctx.session.viewMode = 'normal';
      ctx.session.normalResults = null;
      ctx.session.normalPage = null;

      saveSearch(ctx.from.id, query, 'general', JSON.stringify(items));

      if (!items.length) {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          '❌ **Aucun résultat trouvé** pour ta recherche.',
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔍 Réessayer', 'search_general')]]) }
        );
        return;
      }

      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
        formatResults([items[0]]),
        { parse_mode: 'Markdown', ...resultActionsMenu(0, items.length) }
      );
    } catch (e) {
      ctx.session.searchType = null;
      console.error('Search error:', e.message);
      const detail = esc(e.message).length > 500 ? esc(e.message).slice(0, 500) + '...' : esc(e.message);
      const errMsg = `❌ **Erreur de recherche**\n━━━━━━━━━━━━━━━━━━━━━\n${detail}\n━━━━━━━━━━━━━━━━━━━━━`;
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          errMsg,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔍 Réessayer', 'search_general')]]) }
        );
      } catch {
        await ctx.reply(errMsg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔍 Réessayer', 'search_general')]])
        });
      }
    }
    return;
  }
});

// Handle payment photo (PayPal screenshot)
bot.on('photo', async (ctx) => {
  ctx.session = ctx.session || {};
  if (ctx.session.waitingPaymentProof) {
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;
    await ctx.reply(`📸 Image reçue, traitement...`);
    await handlePaymentProof(ctx, `[Photo: ${fileId}]`);
    return;
  }
});

bot.catch((err) => {
  if (err.message && err.message.includes('message is not modified')) return;
  console.error('Bot error:', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
  if (err.response) console.error('Telegram response:', JSON.stringify(err.response));
  if (err.description) console.error('Telegram description:', err.description);
});

initDb().then(() => bot.launch()).then(() => {
  console.log('🔥 Scarface OSINT Bot démarré !');
  console.log(`👑 Admin ID: ${ADMIN_ID}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
