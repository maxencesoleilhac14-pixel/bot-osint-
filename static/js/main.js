document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('navToggle');
    if (toggle) toggle.onclick = () => document.querySelector('.nav-links').classList.toggle('open');

    const mode = document.getElementById('searchMode');
    const tabs = document.querySelectorAll('.tab');
    const panels = document.querySelectorAll('.tab-panel');
    if (mode && tabs.length) {
        tabs.forEach(t => t.addEventListener('click', () => {
            tabs.forEach(x => x.classList.remove('active'));
            t.classList.add('active');
            panels.forEach(p => p.classList.remove('open'));
            const panel = document.getElementById('tab-' + t.dataset.tab);
            if (panel) panel.classList.add('open');
            mode.value = t.dataset.tab;
        }));
    }

    document.querySelectorAll('.alert').forEach(a => setTimeout(() => { a.style.opacity = '0'; setTimeout(() => a.remove(), 300); }, 5000));

    const trail = document.getElementById('cursorTrail');
    if (trail) {
        document.addEventListener('mousemove', e => {
            trail.style.left = e.clientX + 'px';
            trail.style.top = e.clientY + 'px';
        });
    }

    document.querySelectorAll('.fam-btn').forEach(btn => {
        btn.addEventListener('click', async function() {
            const section = this.nextElementSibling;
            const tree = section.querySelector('.fam-tree');
            const isOpen = section.classList.contains('open');
            if (isOpen) {
                this.classList.remove('open');
                section.classList.remove('open');
                return;
            }
            this.classList.add('open');
            section.classList.add('open');
            if (tree.dataset.loaded) {
                section.classList.add('open');
                return;
            }
            tree.dataset.loaded = '1';
            this.innerHTML = '⏳ Recherche des liens familiaux...';
            try {
                const r = await fetch('/api/search/family', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        nom: this.dataset.nom,
                        prenom: this.dataset.prenom,
                        adresse: this.dataset.adresse,
                        cp: this.dataset.cp,
                        ville: this.dataset.ville,
                        telephone: this.dataset.tel,
                        email: this.dataset.email
                    })
                });
                if (r.status === 403) {
                    tree.innerHTML = '<div class="fam-node"><span class="val" style="color:var(--orange)">💎 Réservé aux abonnés Premium</span></div>';
                    this.innerHTML = '🌳 Détails Famille';
                    return;
                }
                const d = await r.json();
                if (d.related && d.related.length) {
                    let html = '<h4>👨‍👩‍👧‍👦 ' + d.related.length + ' lien(s) familial(aux) trouvé(s)</h4>';
                    d.related.forEach(p => {
                        const nom = p.profil.nom_famille || '';
                        const prenom = p.profil.prenom || '';
                        const email = p.profil.email || '';
                        const tel = p.profil.telephone || '';
                        const adr = p.profil.adresse || '';
                        const ville = p.profil.ville || '';
                        const age = p.profil.age || '';
                        html += '<div class="fam-node clickable" data-nom="' + nom + '" data-prenom="' + prenom + '" data-email="' + email + '" data-tel="' + tel + '" data-adresse="' + adr + '" data-ville="' + ville + '">';
                        html += '<span class="rel">' + p.lien + '</span>';
                        html += '<span class="val">' + (prenom + ' ' + nom).trim() + '</span>';
                        if (age) html += '<span class="sep">·</span><span class="val" style="font-size:.76em;color:var(--text3)">' + age + ' ans</span>';
                        html += '<span class="sep">|</span>';
                        html += '<span class="val" style="font-size:.76em;color:var(--text3)">' + (email || tel || adr || ville) + '</span>';
                        html += '</div>';
                    });
                    tree.innerHTML = html;
                    this.innerHTML = '🌳 ' + d.related.length + ' lien(s) trouvé(s) ▼';
                    tree.querySelectorAll('.fam-node.clickable').forEach(node => {
                        node.addEventListener('click', function() {
                            const f = document.createElement('form');
                            f.method = 'POST';
                            f.action = '/search/results';
                            const add = (n, v) => { if (v) { const i = document.createElement('input'); i.type = 'hidden'; i.name = n; i.value = v; f.appendChild(i); } };
                            add('mode', 'identite');
                            add('nom', this.dataset.nom);
                            add('prenom', this.dataset.prenom);
                            add('email', this.dataset.email);
                            add('telephone', this.dataset.tel);
                            add('adresse', this.dataset.adresse);
                            add('ville', this.dataset.ville);
                            document.body.appendChild(f);
                            f.submit();
                        });
                    });
                } else {
                    tree.innerHTML = '<h4>👨‍👩‍👧‍👦 Liens familiaux</h4><div class="fam-node"><span class="val" style="color:var(--text3)">Aucun lien familial trouvé pour ce profil</span></div>';
                    this.innerHTML = '🌳 Aucun lien trouvé';
                }
            } catch(e) {
                tree.innerHTML = '<h4>👨‍👩‍👧‍👦 Liens familiaux</h4><div class="fam-node"><span class="val" style="color:var(--red)">Erreur lors de la recherche</span></div>';
                this.innerHTML = '🌳 Détails Famille';
            }
        });
    });
});
