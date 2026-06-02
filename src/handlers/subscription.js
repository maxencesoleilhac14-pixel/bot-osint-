import { Markup } from 'telegraf';
import { getUser, setPremium, removePremium, getConfig, createPendingPayment } from '../db.js';

const ADMIN_ID = parseInt(process.env.ADMIN_ID);

function esc(str) {
  return String(str || '').replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

const TIERS = {
  '1m':  { label: '1 mois',  price: '8€',     months: 1 },
  '3m':  { label: '3 mois',  price: '16.50€', months: 3 },
  '12m': { label: '1 an',    price: '25.50€', months: 12 }
};

const PAYMENT_METHODS = [
  { id: 'paypal',      label: 'PayPal',        icon: '💳', desc: 'Envoie la capture d\'écran du paiement' },
  { id: 'paysafecard', label: 'Paysafecard',   icon: '🎴', desc: 'Envoie le code Paysafecard' },
  { id: 'card',        label: 'Carte bancaire', icon: '💳', desc: 'Envoie les infos de paiement (nom + montant)' }
];

function isPaymentEnabled(methodId) {
  const cfg = getConfig(`payment_${methodId}`);
  return cfg ? cfg.value === 'on' : methodId === 'paysafecard';
}

function tierKeyboard() {
  const rows = Object.entries(TIERS).map(([id, t]) =>
    [Markup.button.callback(`⭐ ${t.label} — ${t.price}`, `tier_select_${id}`)]
  );
  rows.push([Markup.button.callback('🔙 Retour', 'back_main')]);
  return Markup.inlineKeyboard(rows);
}

function paymentMethodKeyboard(tierId) {
  const rows = [];
  for (const m of PAYMENT_METHODS) {
    if (isPaymentEnabled(m.id)) {
      rows.push([Markup.button.callback(`${m.icon} ${m.label}`, `pay_method_${tierId}_${m.id}`)]);
    }
  }
  rows.push([Markup.button.callback('🔙 Retour offres', 'premium_info')]);
  return Markup.inlineKeyboard(rows);
}

function paymentProofKeyboard(tierId, methodId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ J\'ai envoyé', `pay_done_${tierId}_${methodId}`)],
    [Markup.button.callback('🔙 Retour', `premium_info`)]
  ]);
}

function adminPaymentConfigKeyboard() {
  const rows = [];
  for (const m of PAYMENT_METHODS) {
    const enabled = isPaymentEnabled(m.id);
    const status = enabled ? '✅ ON' : '❌ OFF';
    rows.push([Markup.button.callback(`${m.icon} ${m.label} [${status}]`, `paytoggle_${m.id}`)]);
  }
  rows.push([Markup.button.callback('🔙 Retour admin', 'admin_menu')]);
  return Markup.inlineKeyboard(rows);
}

function getPaypalEmail() {
  const cfg = getConfig('paypal_email');
  return cfg ? cfg.value : 'scarface@example.com';
}

async function showPremiumInfo(ctx) {
  const user = getUser(ctx.from.id);
  if (user?.is_premium) {
    await ctx.editMessageText(
      `⭐ **TU ES DÉJÀ PREMIUM !**\n━━━━━━━━━━━━━━━━━━━━━\nMerci pour ton soutien ❤️\n💎 Recherches illimitées activées`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Retour', 'back_main')]]) }
    );
    return;
  }
  await ctx.editMessageText(
    `⭐ **PREMIUM SCARFACE OSINT**
━━━━━━━━━━━━━━━━━━━━━
🆓 Gratuit : 1 recherche/jour
⭐ Premium : Recherches illimitées

**Choisis ton offre :**
━━━━━━━━━━━━━━━━━━━━━
📌 1 mois  — **8€**
📌 3 mois  — **16.50€**
📌 1 an    — **25.50€**
━━━━━━━━━━━━━━━━━━━━━`,
    { parse_mode: 'Markdown', ...tierKeyboard() }
  );
}

async function showTierInfo(ctx, tierId) {
  const tier = TIERS[tierId];
  if (!tier) return;
  ctx.session = ctx.session || {};
  ctx.session.selectedTier = tierId;

  const available = PAYMENT_METHODS.filter(m => isPaymentEnabled(m.id));
  if (!available.length) {
    await ctx.editMessageText(
      `❌ Aucun moyen de paiement disponible pour le moment.`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Retour', 'premium_info')]]) }
    );
    return;
  }

  await ctx.editMessageText(
    `⭐ **${tier.label} — ${tier.price}**
━━━━━━━━━━━━━━━━━━━━━
✅ Recherches illimitées
✅ Accès à toutes les fonctions

**Choisis ton moyen de paiement :**
━━━━━━━━━━━━━━━━━━━━━`,
    { parse_mode: 'Markdown', ...paymentMethodKeyboard(tierId) }
  );
}

async function showPaymentMethod(ctx, tierId, methodId) {
  const tier = TIERS[tierId];
  const method = PAYMENT_METHODS.find(m => m.id === methodId);
  if (!tier || !method) return;

  ctx.session = ctx.session || {};
  ctx.session.selectedTier = tierId;
  ctx.session.selectedMethod = methodId;

  let instructions = '';
  switch (methodId) {
    case 'paypal':
      instructions = `💳 **Paiement PayPal**
━━━━━━━━━━━━━━━━━━━━━
💰 ${tier.label} — ${tier.price}

📧 Envoie **${tier.price}** à l'adresse PayPal :
\`${getPaypalEmail()}\`

📸 Ensuite, clique sur "J'ai envoyé" et envoie la **capture d'écran** du paiement.`;
      break;
    case 'paysafecard':
      instructions = `🎴 **Paiement Paysafecard**
━━━━━━━━━━━━━━━━━━━━━
💰 ${tier.label} — ${tier.price}

🔑 Achète un code Paysafecard de **${tier.price}**

📤 Ensuite, clique sur "J'ai envoyé" et envoie le **code** ici.`;
      break;
    case 'card':
      instructions = `💳 **Paiement par Carte**
━━━━━━━━━━━━━━━━━━━━━
💰 ${tier.label} — ${tier.price}

📝 Envoie les infos suivantes :
• Nom complet
• Montant : ${tier.price}

📤 Clique sur "J'ai envoyé" et envoie les infos ici.`;
      break;
  }

  await ctx.editMessageText(instructions, {
    parse_mode: 'Markdown',
    ...paymentProofKeyboard(tierId, methodId)
  });
}

async function handlePaymentDone(ctx, tierId, methodId) {
  const tier = TIERS[tierId];
  const method = PAYMENT_METHODS.find(m => m.id === methodId);
  if (!tier || !method) return;

  ctx.session = ctx.session || {};
  ctx.session.waitingPaymentProof = true;
  ctx.session.paymentTier = tierId;
  ctx.session.paymentMethod = methodId;

  await ctx.editMessageText(
    `📤 **Envoie ta confirmation de paiement**
━━━━━━━━━━━━━━━━━━━━━
📦 Offre : ${tier.label} — ${tier.price}
💳 Méthode : ${method.icon} ${method.label}

${
  methodId === 'paypal'
    ? '📸 Envoie la **capture d\'écran** de ton paiement PayPal.'
    : methodId === 'paysafecard'
    ? '🔑 Envoie le **code Paysafecard** ici.'
    : '📝 Envoie les **infos de paiement** ici.'
}

📨 Dès que tu envoies, l\'administrateur sera notifié.
⏳ Tu auras une réponse sous peu.

┌─────────────────────────┐
│   Envoie ton justificatif   │
└─────────────────────────┘`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Annuler', 'back_main')]
      ])
    }
  );
}

async function handlePaymentProof(ctx, proof) {
  ctx.session = ctx.session || {};
  const tierId = ctx.session.paymentTier;
  const methodId = ctx.session.paymentMethod;
  const tier = TIERS[tierId];
  const method = PAYMENT_METHODS.find(m => m.id === methodId);

  if (!tier || !method) {
    await ctx.reply('❌ Erreur : session expirée, recommence.');
    return;
  }

  ctx.session.waitingPaymentProof = false;

  createPendingPayment(ctx.from.id, ctx.from.username || '', tierId, methodId, proof);

  const isPhoto = proof.startsWith('[Photo:');
  const fileId = isPhoto ? proof.match(/\[Photo: (.+)\]/)[1] : null;

  const adminMsg =
    `💳 **NOUVELLE DEMANDE PREMIUM**
━━━━━━━━━━━━━━━━━━━━━
👤 Utilisateur : ${esc(ctx.from.first_name || 'Inconnu')}
🆔 ID : \`${ctx.from.id}\`
👤 Username : @${ctx.from.username || 'aucun'}
📦 Offre : ${tier.label} — ${tier.price}
💳 Paiement : ${method.icon} ${method.label}
📝 Justificatif :
\`\`\`
${isPhoto ? '[Photo - voir ci-dessus]' : esc(proof.substring(0, 500))}
\`\`\`
━━━━━━━━━━━━━━━━━━━━━`;

  if (isPhoto && fileId) {
    await ctx.telegram.sendPhoto(ADMIN_ID, fileId, {
      caption: adminMsg,
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`✅ Approuver ${ctx.from.id} ${tierId}`, `approve_${ctx.from.id}_${tierId}`)],
        [Markup.button.callback(`❌ Refuser ${ctx.from.id}`, `reject_${ctx.from.id}`)]
      ])
    });
  } else {
    await ctx.telegram.sendMessage(ADMIN_ID, adminMsg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`✅ Approuver ${ctx.from.id} ${tierId}`, `approve_${ctx.from.id}_${tierId}`)],
        [Markup.button.callback(`❌ Refuser ${ctx.from.id}`, `reject_${ctx.from.id}`)]
      ])
    });
  }

  await ctx.reply(
    `✅ **Demande envoyée !**
━━━━━━━━━━━━━━━━━━━━━
📦 Offre : ${tier.label} — ${tier.price}
💳 ${method.icon} ${method.label}

⏳ L'administrateur va vérifier et activer ton Premium sous peu.

📌 Tu recevras une confirmation ici même.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Menu principal', 'back_main')]
      ])
    }
  );

  ctx.session.paymentTier = null;
  ctx.session.paymentMethod = null;
}

async function handleApprove(ctx, targetId, tierId) {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const id = parseInt(targetId);
    const user = getUser(id);
    if (!user) {
      await ctx.answerCbQuery('❌ Utilisateur introuvable');
      return;
    }

    const tier = TIERS[tierId] || TIERS['1m'];
    const until = new Date();
    until.setMonth(until.getMonth() + tier.months);
    setPremium(until.toISOString(), id);

    if (ctx.callbackQuery) {
      await ctx.editMessageText(
        `✅ **Premium approuvé ✅**
━━━━━━━━━━━━━━━━━━━━━
👤 ${esc(user.first_name || user.username)}
🆔 \`${id}\`
📦 ${tier.label} — ${tier.price}
📅 Valide jusqu'au : ${until.toLocaleDateString('fr-FR')}
━━━━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'Markdown' }
      );
    }

    await ctx.telegram.sendMessage(id,
      `⭐ **FÉLICITATIONS ! ✅**
━━━━━━━━━━━━━━━━━━━━━
Ton paiement a été **validé** !

📦 ${tier.label} — ${tier.price}
✅ Recherches illimitées activées
📅 Valide jusqu'au : ${until.toLocaleDateString('fr-FR')}
━━━━━━━━━━━━━━━━━━━━━
Merci pour ton soutien ❤️`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔍 Rechercher', 'search_general')]]) }
    );
  } catch (e) {
    await ctx.answerCbQuery(`❌ Erreur: ${e.message}`);
  }
}

async function handleReject(ctx, targetId) {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const id = parseInt(targetId);
    const user = getUser(id);

    if (ctx.callbackQuery) {
      await ctx.editMessageText(
        `❌ **Demande refusée ❌**
━━━━━━━━━━━━━━━━━━━━━
👤 ${esc(user ? (user.first_name || user.username) : id)}
🆔 \`${id}\`
━━━━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'Markdown' }
      );
    }

    await ctx.telegram.sendMessage(id,
      `❌ **Paiement refusé**
━━━━━━━━━━━━━━━━━━━━━
Malheureusement, ta demande de Premium a été **refusée**.

❌ Raison : le justificatif n'a pas été validé.

📌 Contacte l'admin pour plus d'infos.
━━━━━━━━━━━━━━━━━━━━━`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⭐ Réessayer', 'premium_info')]]) }
    );
  } catch (e) {
    await ctx.answerCbQuery(`❌ Erreur: ${e.message}`);
  }
}

async function togglePaymentMethod(ctx, methodId) {
  if (ctx.from.id !== ADMIN_ID) return;
  const current = isPaymentEnabled(methodId) ? 'on' : 'off';
  const newVal = current === 'on' ? 'off' : 'on';
  const { setConfig } = await import('../db.js');
  setConfig(`payment_${methodId}`, newVal);
  await ctx.answerCbQuery(newVal === 'on' ? '✅ Activé' : '❌ Désactivé');
}

async function showPaymentConfig(ctx) {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.editMessageText(
    `⚙️ **CONFIGURATION PAIEMENTS**
━━━━━━━━━━━━━━━━━━━━━
Active ou désactive les moyens de paiement :

Clique sur un moyen pour le basculer.`,
    { parse_mode: 'Markdown', ...adminPaymentConfigKeyboard() }
  );
}

async function handleSetPremium(ctx, targetId, tierId) {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const id = parseInt(targetId);
    const user = getUser(id);
    if (!user) {
      await ctx.reply(`❌ Utilisateur \`${id}\` introuvable.`, { parse_mode: 'Markdown' });
      return;
    }
    const tier = TIERS[tierId] || TIERS['1m'];
    const until = new Date();
    until.setMonth(until.getMonth() + tier.months);
    setPremium(until.toISOString(), id);

    await ctx.reply(
      `✅ **Premium activé !**
━━━━━━━━━━━━━━━━━━━━━
👤 ${esc(user.first_name || user.username)}
🆔 \`${id}\`
📦 ${tier.label} — ${tier.price}
📅 Valide jusqu'au : ${until.toLocaleDateString('fr-FR')}
━━━━━━━━━━━━━━━━━━━━━`,
      { parse_mode: 'Markdown' }
    );

    await ctx.telegram.sendMessage(id,
      `⭐ **FÉLICITATIONS !**
━━━━━━━━━━━━━━━━━━━━━
Tu es maintenant **Premium** !
📦 ${tier.label} — ${tier.price}
✅ Recherches illimitées activées
📅 Valide jusqu'au : ${until.toLocaleDateString('fr-FR')}
━━━━━━━━━━━━━━━━━━━━━
Merci pour ton soutien ❤️`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔍 Rechercher', 'search_general')]]) }
    );
  } catch (e) {
    await ctx.reply(`❌ Erreur : ${e.message}`);
  }
}

async function handleRemovePremium(ctx, targetId) {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const id = parseInt(targetId);
    removePremium(id);
    await ctx.reply(`✅ Premium retiré pour \`${id}\``, { parse_mode: 'Markdown' });
  } catch (e) {
    await ctx.reply(`❌ Erreur : ${e.message}`);
  }
}

export {
  TIERS, showPremiumInfo, showTierInfo, showPaymentMethod,
  handlePaymentDone, handlePaymentProof,
  handleApprove, handleReject, togglePaymentMethod,
  showPaymentConfig, handleSetPremium, handleRemovePremium,
  adminPaymentConfigKeyboard, PAYMENT_METHODS
};
