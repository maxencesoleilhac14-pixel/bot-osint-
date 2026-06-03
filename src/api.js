import https from 'https';

const BRIX_API_KEY = process.env.BRIX_API_KEY;

const BRIX_HOST = 'brixhub.net';
const BRIX_PATH = '/api/v1';

function esc(str) {
  return String(str || '').replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function httpsRequest(path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: BRIX_HOST,
      port: 443,
      path: `${BRIX_PATH}${path}`,
      method: 'POST',
      headers: {
        'X-API-Key': BRIX_API_KEY,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: timeoutMs
    };

    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          const isHtml = typeof body === 'string' && body.trim().startsWith('<!');
          resolve({ status: res.statusCode, body: isHtml ? null : body, raw: body });
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', (e) => reject(e));
    if (data) req.write(data);
    req.end();
  });
}

async function request(method, path, body = null) {
  try {
    const res = await httpsRequest(path, body, 20000);
    if (res.status !== 200) {
      const isHtml = typeof res.raw === 'string' && res.raw.trim().startsWith('<!');
      if (isHtml) {
        throw new Error('❌ Bloqué par Cloudflare. Vérifie que User-Agent et X-API-Key sont corrects.');
      }
      throw new Error(`API ${res.status}: ${String(res.raw || '').slice(0, 200)}`);
    }
    return res.body;
  } catch (e) {
    throw new Error(`🌐 Erreur réseau : ${esc(e.message || 'inconnue')}`);
  }
}

function fieldLabel(key) {
  const labels = {
    nom_famille: 'Nom de famille', prenom: 'Prénom', nom_naissance: 'Nom de naissance',
    nom_affichage: 'Nom d\'affichage', nom_utilisateur: 'Nom d\'utilisateur',
    date_naissance: 'Date naissance', annee_naissance: 'Année naissance',
    lieu_naissance: 'Lieu naissance', ville_naissance: 'Ville naissance',
    jour_naissance: 'Jour naissance', mois_naissance: 'Mois naissance',
    age: 'Âge', genre: 'Genre', civilite: 'Civilité',
    telephone: 'Téléphone', mobile: 'Mobile', email: 'Email',
    adresse: 'Adresse', complement_adresse: 'Complément adresse',
    code_postal: 'Code postal', ville: 'Ville', departement: 'Département',
    region: 'Région', pays: 'Pays',
    profession: 'Profession', fonction: 'Fonction', societe: 'Société',
    siren: 'SIREN', siret: 'SIRET',
    nir: 'NIR', iban: 'IBAN', bic: 'BIC',
    immatriculation: 'Plaque', marque: 'Marque', modele: 'Modèle',
    vin_plaque: 'VIN/Plaque', numero_serie: 'Numéro série',
    steam_id: 'Steam ID', discord_id: 'Discord ID', live_id: 'Live ID',
    xbox_live_id: 'Xbox Live ID', fivem_id: 'FiveM ID',
    fivem_license: 'FiveM License', fivem_license2: 'FiveM License 2',
    adresse_ip: 'Adresse IP',
    reseaux: 'Réseaux sociaux', socials: 'Réseaux sociaux',
    famille: 'Famille', famille_nom: 'Nom famille', lien: 'Lien',
    mere: 'Mère', pere: 'Père', conjoint: 'Conjoint(e)',
    enfants: 'Enfants', frere_soeur: 'Frères/Soeurs',
    created_at: 'Créé le', updated_at: 'Mis à jour'
  };
  return labels[key] || key;
}

function sources(item) {
  const s = item._sources || item._source_files || [];
  return s.length ? `📦 ${s.slice(0, 3).map(esc).join(', ')}${s.length > 3 ? ` +${s.length - 3}` : ''}` : '';
}

function formatItem(item, index, total) {
  const name = `${esc(item.prenom || '')} ${esc(item.nom_famille || '')}`.trim() || 'Inconnu';
  const lines = [`━━━ ${index}/${total} ━━━`];
  lines.push(`👤 **${name.toUpperCase()}**`);
  lines.push('');
  lines.push('─── Contact ───');
  if (item.telephone) lines.push(`📱 ${esc(item.telephone)}`);
  if (item.email) lines.push(`📧 ${esc(item.email)}`);
  if (item.adresse) lines.push(`📍 ${esc(item.adresse)}`);
  if (item.ville || item.code_postal) lines.push(`🏙️ ${esc(item.ville || '')} ${esc(item.code_postal || '')}`.trim());
  lines.push('');
  if (item.date_naissance || item.genre || item.nir || item.profession) {
    lines.push('─── Identité ───');
    if (item.genre) lines.push(`⚤ Genre : ${esc(item.genre)}`);
    if (item.civilite) lines.push(`🎩 Civilité : ${esc(item.civilite)}`);
    if (item.date_naissance) lines.push(`🎂 Naissance : ${esc(item.date_naissance)}`);
    if (item.age) lines.push(`📅 Âge : ${esc(item.age)}`);
    if (item.profession) lines.push(`💼 ${esc(item.profession)}`);
    if (item.fonction) lines.push(`📋 ${esc(item.fonction)}`);
    if (item.nir) lines.push(`🆔 NIR : ${esc(item.nir)}`);
    if (item.societe) lines.push(`🏢 ${esc(item.societe)}`);
    if (item.nom_utilisateur) lines.push(`👤 Username : ${esc(item.nom_utilisateur)}`);
    lines.push('');
  }
  const src = sources(item);
  if (src) lines.push(`🔗 ${src}`);
  return lines.join('\n');
}

function formatItemDeep(item, index, total) {
  const name = `${esc(item.prenom || '')} ${esc(item.nom_famille || '')}`.trim() || 'Inconnu';
  const lines = [`━━━ ${index}/${total} — ${name.toUpperCase()} ━━━`];
  lines.push('');
  lines.push('─── Identité ───');
  const idFields = ['nom_famille', 'prenom', 'nom_naissance', 'nom_affichage', 'nom_utilisateur', 'civilite', 'genre', 'date_naissance', 'age', 'lieu_naissance', 'ville_naissance', 'profession', 'fonction', 'societe', 'siren', 'siret', 'nir'];
  for (const k of idFields) {
    if (item[k]) lines.push(`${fieldLabel(k)} : ${esc(String(item[k]))}`);
  }
  lines.push('');
  lines.push('─── Contact ───');
  const contactFields = ['telephone', 'mobile', 'email', 'adresse', 'complement_adresse', 'code_postal', 'ville', 'departement', 'region', 'pays'];
  for (const k of contactFields) {
    if (item[k]) lines.push(`${fieldLabel(k)} : ${esc(String(item[k]))}`);
  }
  lines.push('');
  lines.push('─── Gaming / ID ───');
  const gamingFields = ['steam_id', 'discord_id', 'live_id', 'xbox_live_id', 'fivem_id', 'fivem_license', 'fivem_license2', 'adresse_ip', 'iban', 'bic', 'immatriculation', 'marque', 'modele', 'vin_plaque', 'numero_serie'];
  for (const k of gamingFields) {
    if (item[k]) lines.push(`${fieldLabel(k)} : ${esc(String(item[k]))}`);
  }
  const src = sources(item);
  if (src) lines.push(`\n🔗 ${src}`);
  return lines.join('\n');
}

function formatItemFamily(person, index, total) {
  const name = `${esc(person.prenom || '')} ${esc(person.nom_famille || '')}`.trim() || 'Inconnu';
  const lines = [`━━━ ${index}/${total} ━━━`];
  lines.push(`👤 **${name.toUpperCase()}**`);
  if (person.nom_famille) lines.push(`👤 Nom : ${esc(person.nom_famille)}`);
  if (person.prenom) lines.push(`👤 Prénom : ${esc(person.prenom)}`);
  if (person.date_naissance) lines.push(`🎂 Naissance : ${esc(person.date_naissance)}`);
  if (person.telephone) lines.push(`📱 ${esc(person.telephone)}`);
  if (person.email) lines.push(`📧 ${esc(person.email)}`);
  if (person.adresse) lines.push(`📍 ${esc(person.adresse)}`);
  if (person.ville || person.code_postal) lines.push(`🏙️ ${esc(person.ville || '')} ${esc(person.code_postal || '')}`.trim());
  if (person.nir) lines.push(`🆔 NIR : ${esc(person.nir)}`);
  if (person.lien) lines.push(`🔗 Lien : ${esc(person.lien)}`);
  if (person.mere) lines.push(`👩 Mère : ${esc(person.mere)}`);
  if (person.pere) lines.push(`👨 Père : ${esc(person.pere)}`);
  if (person.conjoint) lines.push(`💑 Conjoint(e) : ${esc(person.conjoint)}`);
  if (person.enfants) {
    const kids = Array.isArray(person.enfants) ? person.enfants.map(esc).join(', ') : esc(person.enfants);
    lines.push(`👶 Enfants : ${kids}`);
  }
  if (person.frere_soeur) {
    const siblings = Array.isArray(person.frere_soeur) ? person.frere_soeur.map(esc).join(', ') : esc(person.frere_soeur);
    lines.push(`👫 Frères/Sœurs : ${siblings}`);
  }
  return lines.join('\n');
}

function truncate(text, max = 2500) {
  if (text.length > max) return text.substring(0, max - 3) + '...';
  return text;
}

function formatResults(items) {
  if (!items || !items.length) return '❌ **Aucun résultat trouvé.**';
  const total = items.length;
  const lines = [`🔎 **${total} profil(s) trouvé(s)**`];
  items.forEach((item, i) => lines.push('', formatItem(item, i + 1, total)));
  return truncate(lines.join('\n'));
}

function formatResultsDeep(items) {
  if (!items || !items.length) return '❌ **Aucun résultat approfondi.**';
  const total = items.length;
  const lines = [`🔍 **RECHERCHE APPROFONDIE — ${total} résultat(s)**`];
  items.forEach((item, i) => lines.push('', formatItemDeep(item, i + 1, total)));
  return truncate(lines.join('\n'));
}

function formatFamily(items) {
  if (!items || !items.length) return '❌ **Aucun lien familial trouvé.**';
  const total = items.length;
  const lines = [`👨‍👩‍👧‍👦 **FAMILLE — ${total} personne(s) liée(s)**`];
  items.forEach((item, i) => lines.push('', formatItemFamily(item, i + 1, total)));
  return truncate(lines.join('\n'));
}

function exportToTkt(items, query) {
  let text = `═══════════════════════════════════════\n`;
  text += `       SCARFACE OSINT - RÉSULTATS\n`;
  text += `═══════════════════════════════════════\n`;
  text += `Date: ${new Date().toLocaleString('fr-FR')}\n`;
  text += `Requête: ${query}\n`;
  text += `Résultats: ${items.length}\n`;
  text += `═══════════════════════════════════════\n\n`;
  items.forEach((item, i) => {
    text += `--- Résultat ${i + 1} ---\n`;
    for (const [key, val] of Object.entries(item)) {
      if (val !== null && val !== undefined && val !== '') {
        if (typeof val === 'object') {
          text += `  ${key}: ${JSON.stringify(val)}\n`;
        } else {
          text += `  ${key}: ${val}\n`;
        }
      }
    }
    text += '\n';
  });
  text += `═══════════════════════════════════════\n`;
  text += `Généré par Scarface OSINT Bot\n`;
  return text;
}

function extractResults(data) {
  if (Array.isArray(data)) return data;
  if (data && data.data && Array.isArray(data.data.results)) return data.data.results;
  if (data && data.data && Array.isArray(data.data)) return data.data;
  return [];
}

function idKey(item) {
  return item._es_ids ? item._es_ids[0] : (item.email || item.telephone || item.nom_famille + (item.prenom || ''));
}

function mergeResults(arrays) {
  const seen = new Set();
  const merged = [];
  for (const arr of arrays) {
    for (const item of arr) {
      const key = idKey(item);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
  }
  return merged;
}

async function searchGeneral(bodies) {
  if (!Array.isArray(bodies)) bodies = [bodies];
  let lastError = null;
  const promises = bodies.map(b =>
    request('POST', '/search', b)
      .then(extractResults)
      .catch(e => { lastError = e; return []; })
  );
  const results = await Promise.all(promises);
  const items = mergeResults(results);
  if (!items.length && lastError) throw lastError;
  return { items, raw: { combined: true, queries: bodies.length } };
}

async function searchDeep(body) {
  body.flexible = true;
  const data = await request('POST', '/search', body);
  return { items: extractResults(data), raw: data };
}

async function searchFamilyByAddress(adresse, codePostal, ville) {
  const body = {};
  if (adresse) body.adresse = adresse;
  if (codePostal) body.code_postal = codePostal;
  if (ville) body.ville = ville;
  body.flexible = true;
  const data = await request('POST', '/search', body);
  return extractResults(data);
}

async function searchFamily(item) {
  const searches = [];
  if (item.adresse) searches.push(searchFamilyByAddress(item.adresse, item.code_postal, item.ville));
  if (item.telephone) searches.push(request('POST', '/search', { telephone: item.telephone }).then(extractResults).catch(() => []));
  if (item.email) searches.push(request('POST', '/search', { email: item.email }).then(extractResults).catch(() => []));

  const results = await Promise.all(searches);
  const all = results.flat();
  const seen = new Set();
  const unique = [];
  for (const p of all) {
    const key = p._es_ids ? p._es_ids[0] : (p.telephone || p.email || p.nom_famille + (p.prenom || ''));
    if (!seen.has(key) && key) {
      seen.add(key);
      unique.push(p);
    }
  }
  // Remove the original person from family list
  const origKey = item._es_ids ? item._es_ids[0] : (item.telephone || item.email || '');
  const filtered = unique.filter(p => {
    const pk = p._es_ids ? p._es_ids[0] : (p.telephone || p.email || '');
    return pk !== origKey;
  });

  return { items: filtered.slice(0, 50), raw: { total: filtered.length } };
}

export {
  esc, request, formatResults, formatResultsDeep, formatFamily, exportToTkt,
  searchGeneral, searchDeep, searchFamily
};
