/* ============================================================
   EA FC Pro - App (UI + Firebase)
   Fluxo: dados (cloud) -> funções de render. Nunca lemos o DOM
   para calcular nada. Inputs em foco nunca são recriados.
   ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = FC.escapeHtml;
const MODOS = {
    classico: { nome: 'Clássico', desc: '3 turnos, todos contra todos.' },
    liga: { nome: 'Liga', desc: 'Pontos corridos com rodadas (2 jogadores: 32 rodadas; 3+: ida e volta).' },
    mata: { nome: 'Mata-mata', desc: 'Chave eliminatória sorteada. Empate vai para os pênaltis.' }
};

let db, ref = null, salaAtual = '', cloud = {}, primeiraCarga = true;
let viewSig = '', rodadaSel = null, lastLocal = 0, chaveGravando = false, adminSig = '';
let filtros = new Set(lerLS('FC_FILTROS', ['top3']));
let mudo = lerLS('FC_MUDO', false);
let audioCtx = null;

function lerLS(k, padrao) { try { const v = localStorage.getItem(k); return v === null ? padrao : JSON.parse(v); } catch { return padrao; } }
function gravarLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignora */ } }

/* ====================== UI helpers ====================== */
function toast(msg, tipo = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + tipo; el.textContent = msg; el.setAttribute('role', 'status');
    $('toast-root').appendChild(el);
    setTimeout(() => el.remove(), 3800);
}

const UI = {
    /** Modal acessível. Retorna objeto com valores dos campos (ou true), ou null se cancelado. */
    modal({ title, html = '', fields = [], ok = 'OK', cancel = 'Cancelar', danger = false, validar }) {
        return new Promise((resolve) => {
            const root = $('modal-root');
            const anterior = document.activeElement;
            root.innerHTML = `
            <div class="modal-backdrop">
              <div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
                <h3 id="m-title">${esc(title)}</h3>
                <div>${html}</div>
                <form id="m-form" novalidate>
                  ${fields.map(f => `<label for="f-${f.id}">${esc(f.label)}</label>
                    <input id="f-${f.id}" type="${f.type || 'text'}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''}
                      maxlength="${f.maxlength || 40}" placeholder="${esc(f.placeholder || '')}" value="${esc(f.value || '')}" autocomplete="off">`).join('')}
                  <p id="m-err" class="form-err" role="alert"></p>
                  <div class="modal-actions">
                    ${cancel ? `<button type="button" class="btn ghost" data-m="cancel">${esc(cancel)}</button>` : ''}
                    <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button>
                  </div>
                </form>
              </div>
            </div>`;
            const fim = (v) => { document.removeEventListener('keydown', tecla); root.innerHTML = ''; anterior && anterior.focus && anterior.focus(); resolve(v); };
            const tecla = (e) => { if (e.key === 'Escape' && cancel) fim(null); };
            document.addEventListener('keydown', tecla);
            const form = $('m-form');
            const cancelBtn = root.querySelector('[data-m="cancel"]');
            if (cancelBtn) cancelBtn.onclick = () => fim(null);
            root.querySelector('.modal-backdrop').addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-backdrop') && cancel) fim(null); });
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const valores = {};
                fields.forEach(f => { valores[f.id] = $('f-' + f.id).value.trim(); });
                if (validar) {
                    const erro = await validar(valores);
                    if (erro) { $('m-err').textContent = erro; return; }
                }
                fim(fields.length ? valores : true);
            });
            const primeiro = fields.length ? $('f-' + fields[0].id) : form.querySelector('button[type=submit]');
            primeiro && primeiro.focus();
        });
    },
    confirmar(opts) { return UI.modal({ ok: 'Confirmar', ...opts }).then(r => !!r); }
};

function beep(freq = 660, dur = 0.12) {
    if (mudo) return;
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = freq; g.gain.value = 0.07;
        o.connect(g); g.connect(audioCtx.destination);
        o.start(); o.stop(audioCtx.currentTime + dur);
    } catch { /* sem áudio */ }
}
const fanfare = () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.2), i * 170));

function aplicarTema(t) {
    document.documentElement.dataset.theme = t;
    $('btn-tema').textContent = t === 'dark' ? '🌙' : '☀️';
    document.querySelector('meta[name="theme-color"]').content = t === 'dark' ? '#0b0f19' : '#f4f6f9';
}

function mudarAba(aba) {
    document.querySelectorAll('.tab-btn').forEach(b => {
        const ativo = b.dataset.tab === aba;
        b.classList.toggle('active', ativo);
        b.setAttribute('aria-selected', String(ativo));
    });
    ['campeonato', 'stats', 'ajustes'].forEach(id => {
        const el = $('tab-' + id);
        if (el) el.hidden = (id !== aba);
    });
}

/* ====================== Estado derivado ====================== */
function jogadoresDe(c) {
    let lista = [];
    if (Array.isArray(c.jogadores)) lista = c.jogadores;
    else if (c.jogadores && typeof c.jogadores === 'object') lista = Object.values(c.jogadores);
    else if (typeof c.players === 'string') lista = c.players.split(',');   // formato antigo
    return FC.normalizarJogadores(lista, MAX_JOGADORES);
}
const nomes = () => jogadoresDe(cloud);
const getModo = () => cloud.modo || (cloud.categoria === 'temporada' ? 'liga' : 'classico');
const fixtures = () => FC.gerarFixtures(getModo(), nomes().length, cloud.jogos || {}, cloud.chave);
function rankKey() {
    const m = getModo();
    return m === 'liga' ? 'ranking_temporada' : m === 'mata' ? 'ranking_mata' : (nomes().length === 2 ? 'ranking_duelo' : 'ranking_torneio');
}
function tituloModo() {
    const m = getModo(), n = nomes().length;
    if (m === 'liga') return n === 2 ? 'Liga Elite · 32 rodadas' : 'Liga Elite';
    if (m === 'mata') return 'Copa Mata-mata';
    return n === 2 ? 'Duelo Elite X1' : 'Torneio Champions';
}
function partidasHistoricas() {
    const out = [];
    Object.keys(cloud.historico || {}).sort().forEach(k => (cloud.historico[k].jogos || []).forEach(p => out.push(p)));
    return out;
}
const todasPartidas = () => partidasHistoricas().concat(FC.partidasDoEstado(nomes(), fixtures().grupos, cloud.jogos));

/* ====================== Firebase / Salas ====================== */
async function iniciar() {
    aplicarTema(lerLS('FC_TEMA', 'light'));
    $('btn-som').textContent = mudo ? '🔕' : '🔔';
    montarFiltros(); updateDatalist(); ligarEventos();

    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.database();
    try { await firebase.auth().signInAnonymously(); }
    catch (e) { console.warn('Login anônimo indisponível (habilite em Authentication > Sign-in method).', e); }
    db.ref('.info/connected').on('value', s => setSync(!!s.val()));

    const params = new URLSearchParams(location.search);
    const daUrl = params.get('sala');
    const daSessao = sessionStorage.getItem('FC_SESSION_ROOM');
    if (daUrl) await abrirSala(daUrl);
    else if (daSessao) await abrirSala(daSessao);
    mostrarRecentes();
}

function setSync(on) {
    $('sync').className = 'sync ' + (on ? 'on' : 'off');
    $('sync-txt').textContent = on ? 'Sincronizado' : 'Offline';
}

function mostrarRecentes() {
    const lista = lerLS('FC_RECENTES', []);
    $('recentes').hidden = !lista.length;
    $('recentes-lista').innerHTML = lista.map(s => `<button class="btn small" data-sala="${esc(s)}">${esc(s)}</button>`).join('');
}
function lembrarSala(sala) {
    const l = [sala, ...lerLS('FC_RECENTES', []).filter(x => x !== sala)].slice(0, 3);
    gravarLS('FC_RECENTES', l);
}

async function criarSalaFluxo() {
    const r = await UI.modal({
        title: 'Nova sala',
        fields: [
            { id: 'nome', label: 'Nome da sala', placeholder: 'Ex: ResenhaDeSexta', maxlength: 30 },
            { id: 'admin', label: 'PIN de administrador (mín. 4)', type: 'password', inputmode: 'numeric' },
            { id: 'entrada', label: 'PIN de entrada (opcional)', type: 'password', inputmode: 'numeric' }
        ],
        ok: 'Criar sala',
        validar: async (v) => {
            const sala = FC.sanitizarSala(v.nome);
            if (sala.length < 3) return 'O nome precisa de ao menos 3 letras/números (sem espaços ou . # $ [ ] /).';
            if (v.admin.length < 4) return 'O PIN de administrador precisa de ao menos 4 caracteres.';
            if (v.entrada && v.entrada.length < 4) return 'O PIN de entrada precisa de ao menos 4 caracteres.';
            try { if ((await db.ref('salas/' + sala).once('value')).exists()) return 'Já existe uma sala com esse nome. Use "Entrar em sala".'; }
            catch (e) { return 'Não foi possível verificar a sala: ' + e.message; }
            return '';
        }
    });
    if (!r) return;
    const sala = FC.sanitizarSala(r.nome), salt = FC.gerarSalt();
    const meta = { criadoEm: firebase.database.ServerValue.TIMESTAMP, salt, adminHash: await FC.hashPin(r.admin, sala + salt) };
    if (r.entrada) meta.entradaHash = await FC.hashPin(r.entrada, sala + salt);
    try { await db.ref('salas/' + sala).set({ meta, modo: 'classico' }); }
    catch (e) { return toast('Erro ao criar a sala: ' + e.message, 'erro'); }
    if (meta.entradaHash) { const m = (await db.ref('salas/' + sala + '/meta/entradaHash').once('value')).val(); sessionStorage.setItem('FC_OK_' + sala, m); }
    sessionStorage.setItem('FC_ADM_' + sala, '1');
    entrarApp(sala);
    toast('Sala criada! Toque em 🔗 para convidar os amigos.', 'ok');
}

async function entrarSalaFluxo() {
    const r = await UI.modal({
        title: 'Entrar em sala', ok: 'Entrar',
        fields: [{ id: 'nome', label: 'Nome da sala', maxlength: 30 }],
        validar: (v) => FC.sanitizarSala(v.nome).length < 3 ? 'Informe o nome da sala.' : ''
    });
    if (r) await abrirSala(r.nome);
}

async function abrirSala(bruto) {
    const sala = FC.sanitizarSala(bruto);
    if (!sala) return false;
    try {
        const snap = await db.ref('salas/' + sala).once('value');
        if (!snap.exists()) { toast('Sala não encontrada. Confira o nome ou crie uma nova.', 'erro'); sessionStorage.removeItem('FC_SESSION_ROOM'); return false; }
        const meta = (snap.val() || {}).meta || {};
        if (meta.entradaHash && sessionStorage.getItem('FC_OK_' + sala) !== meta.entradaHash) {
            const r = await UI.modal({
                title: 'Sala protegida', ok: 'Entrar',
                fields: [{ id: 'pin', label: 'PIN de entrada', type: 'password', inputmode: 'numeric' }],
                validar: async (v) => (await FC.hashPin(v.pin, sala + (meta.salt || ''))) === meta.entradaHash ? '' : 'PIN incorreto.'
            });
            if (!r) return false;
            sessionStorage.setItem('FC_OK_' + sala, meta.entradaHash);
        }
    } catch (e) { toast('Erro ao acessar a sala: ' + e.message, 'erro'); return false; }
    entrarApp(sala);
    return true;
}

function entrarApp(sala) {
    if (ref) ref.off();                       // evita listeners acumulados
    salaAtual = sala; cloud = {}; primeiraCarga = true; viewSig = ''; rodadaSel = null; adminSig = '';
    sessionStorage.setItem('FC_SESSION_ROOM', sala);
    lembrarSala(sala);
    const w = $('welcome-screen');
    w.classList.add('saindo');
    setTimeout(() => { w.hidden = true; }, 600);
    $('main-app').hidden = false;
    $('admin-panel').hidden = true;
    $('label-sala').textContent = 'Sala: ' + sala;
    mudarAba('campeonato');

    ref = db.ref('salas/' + sala);
    ref.on('value', (snap) => {
        const novo = snap.val() || {};
        if (!primeiraCarga) avisarNovosResultados(cloud, novo);
        cloud = novo; primeiraCarga = false;
        garantirChave();
        render();
    }, (err) => toast('Sem permissão ou erro de leitura: ' + err.message, 'erro'));
}

function sairDaSala() {
    if (ref) ref.off(); ref = null; salaAtual = ''; cloud = {};
    sessionStorage.removeItem('FC_SESSION_ROOM');
    history.replaceState(null, '', location.pathname);
    $('main-app').hidden = true;
    const w = $('welcome-screen'); w.hidden = false; requestAnimationFrame(() => w.classList.remove('saindo'));
    mostrarRecentes();
}

function garantirChave() {
    if (getModo() !== 'mata' || chaveGravando) return;
    const n = nomes().length;
    if (n < 2 || FC.chaveValida(cloud.chave, n)) return;
    chaveGravando = true;
    const nova = FC.embaralhar([...Array(n).keys()]);
    ref.child('chave').transaction(cur => FC.chaveValida(cur, n) ? undefined : nova)
        .catch(() => { }).finally(() => { chaveGravando = false; });
}

function avisarNovosResultados(prev, novo) {
    if (Date.now() - lastLocal < 2500) return;     // foi uma escrita nossa
    const pj = prev.jogos || {}, nj = novo.jogos || {}, n = jogadoresDe(novo);
    Object.entries(nj).forEach(([id, jg]) => {
        const a = FC.lerJogo(pj[id]), b = FC.lerJogo(jg);
        if (!FC.completo(a) && FC.completo(b)) {
            const m = id.match(/^c\d+_p(\d+)_p(\d+)_k/);
            toast(m && n[m[1]] ? `📣 ${n[m[1]]} ${b.g1} × ${b.g2} ${n[m[2]]}` : '📣 Novo resultado lançado!');
            beep(880, 0.15);
        }
    });
}

const gravar = (promessa) => promessa.catch(e => toast('Falha ao salvar: ' + e.message, 'erro'));
function gravarJogo(id, patch) { lastLocal = Date.now(); return gravar(ref.child('jogos/' + id).update(patch)); }

/* ====================== Render ====================== */
function render() {
    if (!salaAtual) return;
    const n = nomes(), modo = getModo(), f = fixtures();
    const temJogadores = n.length >= 2;

    $('mode-title').textContent = tituloModo();
    $('modo-desc').textContent = MODOS[modo].desc;
    document.querySelectorAll('.seg-btn').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.modo === modo)));
    $('players-count').textContent = `(${n.length}/${MAX_JOGADORES})`;
    if ($('tab-players-badge')) $('tab-players-badge').textContent = String(n.length);
    $('chips').innerHTML = n.map((nm, i) => `<span class="chip">${esc(nm)}<button data-rm="${i}" aria-label="Remover ${esc(nm)}">×</button></span>`).join('');

    $('vazio').hidden = temJogadores;
    $('conteudo').hidden = !temJogadores;
    renderStats();
    renderHistorico();
    if (!temJogadores) return;

    renderHonra(n);
    $('sec-tabela').hidden = modo === 'mata';
    if (modo !== 'mata') renderTabela(n, f);
    $('titulo-confrontos').textContent = modo === 'mata' ? 'Chave Eliminatória' : 'Confrontos';
    renderJogos(n, f, modo);
    renderRivalidade(n);
    if (!$('admin-panel').hidden) renderAdminEdit();
}

function renderHonra(n) {
    const hist = cloud[rankKey()] || {};
    const medalha = (i, v) => (v > 0 ? ['🥇', '🥈', '🥉'][i] : '') || `${i + 1}º`;
    const lista = (campo) => [...n].sort((a, b) => ((hist[b] || {})[campo] || 0) - ((hist[a] || {})[campo] || 0))
        .map((p, i) => { const v = (hist[p] || {})[campo] || 0; return `<div class="rank-item"><span>${medalha(i, v)} ${esc(p)}</span><b>${v}</b></div>`; }).join('');
    $('hist-titulos').innerHTML = lista('titulos');
    $('hist-pontos').innerHTML = lista('pontos');
    $('hist-gols').innerHTML = lista('gols');
    const rotulo = { ranking_duelo: 'Duelo', ranking_torneio: 'Torneio', ranking_temporada: 'Liga', ranking_mata: 'Mata-mata' }[rankKey()];
    $('titulo-honra').textContent = `Quadro de Honra · ${rotulo}`;
}

function renderTabela(n, f) {
    const tab = FC.calcularTabela(n, f.grupos, cloud.jogos);
    const ultimas = (arr) => {
        const u = arr.slice(-5);
        if (!u.length) return '<span class="muted">-</span>';
        return '<div class="ultimas">' + u.map(r => r === 'V' ? '<span class="form-badge form-v" title="Vitória" aria-label="Vitória">V</span>'
            : r === 'E' ? '<span class="form-badge form-e" title="Empate" aria-label="Empate">E</span>'
                : '<span class="form-badge form-d" title="Derrota" aria-label="Derrota">D</span>').join('') + '</div>';
    };
    $('corpo-tabela').innerHTML = tab.map((p, i) => `
        <tr class="${i === 0 && p.pj ? 'lider' : ''}">
            <td class="sticky"><span class="pos">${i + 1}</span>${esc(p.nome)}</td>
            <td class="td-pts">${p.pts}</td><td>${p.pj}</td><td>${p.v}</td><td>${p.e}</td><td>${p.d}</td>
            <td>${p.sg > 0 ? '+' : ''}${p.sg}</td>
            <td class="col-form">${ultimas(p.ultimas)}</td>
        </tr>`).join('');
}

/* ---- Confrontos: reconstrói só quando a ESTRUTURA muda; valores são sincronizados no lugar ---- */
function grupoConcluido(g) {
    return g.jogos.filter(j => !j.bye).every(j => j.i != null && j.j != null && FC.completo(FC.lerJogo((cloud.jogos || {})[j.id])));
}
function renderJogos(n, f, modo) {
    const todos = FC.todosJogos(f.grupos);
    const feitos = todos.filter(j => j.i != null && j.j != null && FC.completo(FC.lerJogo((cloud.jogos || {})[j.id]))).length;
    $('progress-bar').style.width = todos.length ? (feitos / todos.length * 100) + '%' : '0%';
    $('progress-txt').textContent = `${feitos}/${todos.length} jogos`;

    if (modo === 'liga') {
        if (rodadaSel === null || rodadaSel >= f.grupos.length) {
            const idx = f.grupos.findIndex(g => !grupoConcluido(g));
            rodadaSel = idx === -1 ? f.grupos.length - 1 : idx;
        }
    } else rodadaSel = null;

    const sig = [modo, n.join(','), rodadaSel, f.grupos.map(g => g.jogos.map(j => `${j.id}:${j.i}:${j.j}:${j.bye ? 'b' : ''}`).join(',')).join(';')].join('|');
    if (sig !== viewSig) { viewSig = sig; $('lista-confrontos').innerHTML = buildJogosHtml(f, n, modo); }
    syncJogos(f, n, modo);
}

function buildJogosHtml(f, n, modo) {
    if (modo === 'liga') {
        const g = f.grupos[rodadaSel];
        const opts = f.grupos.map((gr, i) => `<option value="${i}" ${i === rodadaSel ? 'selected' : ''}>${esc(gr.titulo)}${gr.fase ? ' · ' + gr.fase : ''}${grupoConcluido(gr) ? ' ✔' : ''}</option>`).join('');
        return `<div class="match-section">
            <div class="round-nav">
                <button class="icon-btn" data-action="rod-ant" aria-label="Rodada anterior">‹</button>
                <select id="rod-select" class="t-input" aria-label="Escolher rodada">${opts}</select>
                <button class="icon-btn" data-action="rod-prox" aria-label="Próxima rodada">›</button>
            </div>
            <button class="btn small ghost" data-action="rod-pend" style="width:100%;margin-bottom:6px">Ir para a próxima rodada pendente</button>
            <h3 class="match-title">${esc(g.titulo)}${g.fase ? ' · ' + esc(g.fase) : ''}</h3>
            ${g.jogos.map(j => rowHtml(j, n, modo)).join('')}
        </div>`;
    }
    return f.grupos.map(g => `<section class="match-section"><h3 class="match-title">${esc(g.titulo)}</h3>${g.jogos.map(j => rowHtml(j, n, modo)).join('')}</section>`).join('');
}

function rowHtml(fx, n, modo) {
    if (fx.bye) { const nome = n[fx.i ?? fx.j]; return `<div class="bye-row"><b>${esc(nome)}</b> avança direto (folga) 🎟️</div>`; }
    const a = fx.i == null ? 'A definir' : n[fx.i], b = fx.j == null ? 'A definir' : n[fx.j];
    const jogadorLinha = (nome, t) => `
        <div class="p-row">
            <div class="p-info">
                <span class="p-name">${esc(nome)}</span>
                <div class="team-box">
                    <span class="team-badge" data-role="b${t}" aria-hidden="true"></span>
                    <input class="t-input" data-field="t${t}" list="lista-times" maxlength="30" placeholder="Escolher time" aria-label="Time de ${esc(nome)}">
                </div>
            </div>
            <input type="number" inputmode="numeric" min="0" max="99" step="1" placeholder="0" class="score-input" data-field="g${t}" aria-label="Gols de ${esc(nome)}">
        </div>`;
    return `<div class="match-row" data-id="${fx.id}">
        ${jogadorLinha(a, 1)}
        ${jogadorLinha(b, 2)}
        ${modo === 'mata' ? `<div class="pen-row" data-role="pen" hidden>Pênaltis
            <input type="number" inputmode="numeric" min="0" max="99" data-field="p1" aria-label="Pênaltis de ${esc(a)}"> ×
            <input type="number" inputmode="numeric" min="0" max="99" data-field="p2" aria-label="Pênaltis de ${esc(b)}"></div>` : ''}
        <div class="row-foot" data-role="foot">
            <button class="act-btn" data-action="sortear" data-role="btn-sortear" type="button">🎲 Sortear times</button>
            <button class="act-btn" data-action="acao" data-role="btn" type="button">Confirmar</button>
        </div>
    </div>`;
}

function syncJogos(f, n, modo) {
    const mapa = {}; FC.todosJogos(f.grupos).forEach(x => { mapa[x.id] = x; });
    document.querySelectorAll('#lista-confrontos .match-row').forEach(row => {
        const fx = mapa[row.dataset.id]; if (!fx) return;
        const jg = FC.lerJogo((cloud.jogos || {})[fx.id]);
        const tbd = fx.i == null || fx.j == null;
        const set = (campo, v) => {
            const el = row.querySelector(`[data-field="${campo}"]`); if (!el) return;
            const txt = v === null || v === '' ? '' : String(v);
            if (el !== document.activeElement && el.value !== txt) el.value = txt;
            el.disabled = tbd || (campo[0] !== 't' ? jg.final : false);
        };
        set('t1', jg.t1); set('t2', jg.t2); set('g1', jg.g1); set('g2', jg.g2); set('p1', jg.p1); set('p2', jg.p2);
        const completo = FC.completo(jg);
        row.classList.toggle('final', jg.final); row.classList.toggle('tbd', tbd);
        const pen = row.querySelector('[data-role="pen"]');
        if (pen) pen.hidden = !(completo && jg.g1 === jg.g2);
        row.querySelector('[data-role="b1"]').textContent = BADGE_TIME[jg.t1] || '';
        row.querySelector('[data-role="b2"]').textContent = BADGE_TIME[jg.t2] || '';

        const foot = row.querySelector('[data-role="foot"]');
        const btnSortear = row.querySelector('[data-role="btn-sortear"]');
        const btn = row.querySelector('[data-role="btn"]');
        foot.hidden = tbd;
        if (jg.final) {
            btnSortear.hidden = true;
            foot.classList.add('single');
            btn.textContent = '✔ Confirmado · Reabrir';
            btn.className = 'act-btn';
            btn.disabled = false;
            btn.setAttribute('aria-label', 'Reabrir resultado');
            btn.dataset.estado = 'reabrir';
        } else {
            btnSortear.hidden = false;
            foot.classList.remove('single');
            btn.textContent = 'Confirmar';
            btn.className = completo ? 'act-btn confirm' : 'act-btn';
            btn.disabled = !completo;
            btn.setAttribute('aria-label', 'Confirmar resultado');
            btn.dataset.estado = 'confirmar';
        }
    });
}

function renderRivalidade(n) {
    const s1 = $('p1-select'), s2 = $('p2-select');
    const wrap = $('rival-selects-wrap');
    if (wrap) wrap.hidden = n.length <= 2;
    const sig = n.join('|');
    if (s1.dataset.sig !== sig) {
        const v1 = n.includes(s1.value) ? s1.value : n[0], v2 = n.includes(s2.value) && s2.value !== v1 ? s2.value : n.find(x => x !== v1);
        const opts = n.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
        s1.innerHTML = opts; s2.innerHTML = opts; s1.value = v1; s2.value = v2; s1.dataset.sig = sig;
    }
    const a = s1.value, b = s2.value;
    $('rival-name-1').textContent = a; $('rival-name-2').textContent = b;
    if (!a || !b || a === b) { $('rival-extra').textContent = 'Escolha dois jogadores diferentes.'; return; }
    const legado = (cloud.rivalidade || {})[[a, b].sort().join('_vs_')];
    const r = FC.rivalidade(todasPartidas(), a, b, legado);
    $('rival-v-1').textContent = r.va; $('rival-v-2').textContent = r.vb;
    const tot = r.va + r.vb, perc = tot ? (r.va / tot) * 100 : 50;
    $('bar-1').style.width = perc + '%'; $('bar-2').style.width = (100 - perc) + '%';
    $('rival-extra').textContent = r.e ? `${r.e} empate(s) registrado(s)` : (tot ? '' : 'Ainda sem jogos entre vocês.');
}

function renderStats() {
    const partidas = todasPartidas(), box = $('stats');
    if (!partidas.length) { box.innerHTML = '<div class="empty-state" style="grid-column:1/-1;margin:0"><p class="muted">Jogue algumas partidas e as estatísticas aparecem aqui.</p></div>'; return; }
    const s = FC.estatisticas(partidas);
    const card = (k, v, sub = '') => `<div class="stat-card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
    const melhor = s.jogadores[0];
    box.innerHTML = [
        card('Partidas', s.total, 'incluindo histórico'),
        melhor ? card('Melhor aproveitamento', `${esc(melhor.nome)} · ${melhor.aproveitamento}%`, `${melhor.v}V ${melhor.e}E ${melhor.d}D`) : '',
        s.goleada ? card('Maior goleada', `${s.goleada.g1} × ${s.goleada.g2}`, `${esc(s.goleada.n1)} x ${esc(s.goleada.n2)}`) : '',
        s.seqTop ? card('Maior sequência', `${esc(s.seqTop.nome)} · ${s.seqTop.qtd} vitórias`) : '',
        s.timeTop ? card('Time que mais vence', esc(s.timeTop.time), `${s.timeTop.v}V em ${s.timeTop.j} jogos`) : ''
    ].join('');
}

function renderHistorico() {
    const h = cloud.historico || {}, keys = Object.keys(h).sort().reverse().slice(0, 10), box = $('historico');
    if (!keys.length) { box.innerHTML = '<p class="muted small">Quando você encerrar um campeonato, ele fica salvo aqui.</p>'; return; }
    box.innerHTML = keys.map(k => {
        const e = h[k], data = e.ts ? new Date(e.ts).toLocaleDateString('pt-BR') : '';
        return `<details class="hist"><summary>🏆 ${esc(e.campeao)} <span class="muted small">· ${esc((MODOS[e.modo] || {}).nome || e.modo)} · ${data}</span></summary>
            <div class="hist-jogos">${(e.jogos || []).map(p => `<div>${esc(p.n1)} <b>${p.g1} × ${p.g2}</b> ${esc(p.n2)}${p.p1 != null ? ` <span class="muted">(pên. ${p.p1}×${p.p2})</span>` : ''}</div>`).join('') || '<div>Sem partidas registradas.</div>'}</div></details>`;
    }).join('');
}

/* ====================== Ações ====================== */
function timesAtivos() { const s = new Set(); filtros.forEach(f => (TIMES[f] || []).forEach(t => s.add(t))); return [...s]; }
function updateDatalist() { $('lista-times').innerHTML = timesAtivos().map(t => `<option value="${esc(t)}">`).join(''); }
function montarFiltros() {
    const box = $('filter-ui');
    FILTROS.forEach(fl => {
        const b = document.createElement('button');
        b.className = 'filter-chip'; b.dataset.filtro = fl.id; b.textContent = fl.rotulo;
        b.setAttribute('aria-pressed', String(filtros.has(fl.id)));
        box.appendChild(b);
    });
}
function salvarFiltros() { gravarLS('FC_FILTROS', [...filtros]); document.querySelectorAll('.filter-chip').forEach(b => b.setAttribute('aria-pressed', String(filtros.has(b.dataset.filtro)))); updateDatalist(); }

function sortearTimes(id) {
    const pool = timesAtivos(), f = fixtures();
    const grupo = f.grupos.find(g => g.jogos.some(j => j.id === id));
    const escopo = getModo() === 'liga' && grupo ? new Set(grupo.jogos.map(j => j.id)) : null;   // liga: só evita repetir na mesma rodada
    const usados = new Set();
    Object.entries(cloud.jogos || {}).forEach(([k, jg]) => { if (k === id || (escopo && !escopo.has(k))) return; [jg.t1, jg.t2].forEach(t => t && usados.add(t)); });
    let disp = pool.filter(t => !usados.has(t)), reiniciou = false;
    if (disp.length < 2) { disp = [...pool]; reiniciou = true; }
    if (disp.length < 2) return toast('Ative ao menos uma liga com 2+ times nos filtros.', 'erro');
    const t1 = disp[Math.floor(Math.random() * disp.length)];
    const resto = disp.filter(t => t !== t1), t2 = resto[Math.floor(Math.random() * resto.length)];
    gravarJogo(id, { t1, t2 }); beep(520, 0.08);
    if (reiniciou) toast('Todos os times do filtro já foram usados: sorteio reiniciado.');
}

async function onAcao(btn) {
    const id = btn.closest('.match-row').dataset.id, est = btn.dataset.estado;
    if (est === 'sortear') return sortearTimes(id);
    if (est === 'confirmar') {
        const jg = FC.lerJogo((cloud.jogos || {})[id]);
        if (getModo() === 'mata' && jg.g1 === jg.g2 && (jg.p1 === null || jg.p2 === null || jg.p1 === jg.p2)) return toast('Empate no mata-mata: informe os pênaltis (sem empate).', 'erro');
        await gravarJogo(id, { g1: jg.g1, g2: jg.g2, final: true }); beep(784, 0.15); return toast('Resultado confirmado ✔', 'ok');
    }
    if (est === 'reabrir') {
        if (await UI.confirmar({ title: 'Reabrir resultado?', html: '<p class="muted">O placar volta a ficar editável e a tabela será recalculada.</p>', ok: 'Reabrir' })) gravarJogo(id, { final: null, tentativas: null });
    }
}

function onChange(e) {
    if (e.target.id === 'rod-select') { rodadaSel = Number(e.target.value); viewSig = ''; return render(); }
    const el = e.target.closest('[data-field]'); if (!el) return;
    const id = el.closest('.match-row').dataset.id, campo = el.dataset.field;
    let v;
    if (campo[0] === 't') v = el.value.trim().slice(0, 30) || null;
    else if (el.value === '') v = null;
    else { v = FC.numero(el.value); if (v === null) { toast('O placar deve ser um número inteiro de 0 a 99.', 'erro'); syncJogos(fixtures(), nomes(), getModo()); return; } }
    gravarJogo(id, { [campo]: v });
}

async function mudarJogadores(lista) {
    const novos = FC.normalizarJogadores(lista, MAX_JOGADORES), atuais = nomes();
    if (novos.join('|') === atuais.join('|')) return;
    const qtd = Object.values(cloud.jogos || {}).filter(j => FC.completo(FC.lerJogo(j))).length;
    if (qtd || cloud.chave) {
        const ok = await UI.confirmar({
            title: 'Mudar participantes?', danger: true, ok: 'Mudar e apagar placares',
            html: `<p>Isso vai <b>apagar ${qtd} resultado(s)</b> lançados no campeonato atual${getModo() === 'mata' ? ' e sortear uma nova chave' : ''}. O ranking e o histórico <b>não</b> são afetados.</p>`
        });
        if (!ok) return;
    }
    gravar(ref.update({ jogadores: novos.length ? novos : null, jogos: null, chave: null })); rodadaSel = null;
}

async function mudarModo(modo) {
    if (modo === getModo()) return;
    const qtd = Object.values(cloud.jogos || {}).filter(j => FC.completo(FC.lerJogo(j))).length;
    if (qtd) {
        const ok = await UI.confirmar({ title: `Mudar para ${MODOS[modo].nome}?`, danger: true, ok: 'Mudar e apagar placares', html: `<p>Os <b>${qtd} resultado(s)</b> do campeonato atual serão apagados, pois cada modo tem seus próprios confrontos.</p>` });
        if (!ok) return;
    }
    rodadaSel = null;
    gravar(ref.update({ modo, categoria: null, jogos: null, chave: null }));
}

async function limparPlacares() {
    const qtd = Object.keys(cloud.jogos || {}).length;
    if (!qtd) return toast('Não há placares para limpar.');
    if (await UI.confirmar({ title: 'Limpar placares?', danger: true, ok: 'Limpar', html: `<p>Serão apagados os placares e times de <b>${qtd}</b> jogo(s) do campeonato atual.</p>` })) gravar(ref.child('jogos').remove());
}

/* ---- Administração ---- */
async function garantirAdmin() {
    const sala = salaAtual, meta = cloud.meta || {};
    if (sessionStorage.getItem('FC_ADM_' + sala) === '1') return true;
    if (!meta.adminHash) {
        const r = await UI.modal({
            title: 'Defina o PIN de administrador',
            html: '<p class="muted">Esta sala ainda não tem PIN de administrador. Defina um para proteger encerrar campeonato, ajustar ranking e reset.</p>',
            fields: [{ id: 'pin', label: 'Novo PIN (mín. 4 caracteres)', type: 'password', inputmode: 'numeric' }], ok: 'Definir PIN',
            validar: (v) => v.pin.length < 4 ? 'Use ao menos 4 caracteres.' : ''
        });
        if (!r) return false;
        const salt = meta.salt || FC.gerarSalt();
        try { await ref.child('meta').update({ adminHash: await FC.hashPin(r.pin, sala + salt), salt }); }
        catch (e) { toast('Não foi possível salvar o PIN: ' + e.message, 'erro'); return false; }
        sessionStorage.setItem('FC_ADM_' + sala, '1'); toast('PIN de administrador definido ✔', 'ok'); return true;
    }
    const r = await UI.modal({
        title: 'Acesso de administrador', ok: 'Confirmar',
        fields: [{ id: 'pin', label: 'PIN de administrador', type: 'password', inputmode: 'numeric' }],
        validar: async (v) => (await FC.hashPin(v.pin, sala + (meta.salt || ''))) === meta.adminHash ? '' : 'PIN incorreto.'
    });
    if (!r) return false;
    sessionStorage.setItem('FC_ADM_' + sala, '1'); return true;
}

async function abrirAdmin() {
    const p = $('admin-panel');
    if (!p.hidden) { p.hidden = true; return; }
    if (!(await garantirAdmin())) return;
    p.hidden = false; adminSig = ''; renderAdminEdit(); p.scrollIntoView({ behavior: 'smooth' });
}

function renderAdminEdit() {
    const n = nomes(), rk = rankKey(), sig = rk + '|' + n.join(',');
    if (sig === adminSig) return;       // não recria enquanto o admin digita
    adminSig = sig;
    const hist = cloud[rk] || {};
    $('admin-info').textContent = `Editando o ranking: ${$('titulo-honra').textContent.replace(/^.*Quadro de Honra · /, '')}`;
    $('admin-edit-container').innerHTML = '<div class="admin-edit-row" style="font-weight:800;color:var(--gold)"><span>Jogador</span><span>🏆</span><span>📈</span><span>⚽</span></div>' +
        n.map((p, i) => { const d = hist[p] || {}; return `<div class="admin-edit-row"><span>${esc(p)}</span>
            <input type="number" min="0" class="admin-input" data-ed="${i}:titulos" value="${d.titulos || 0}" aria-label="Títulos de ${esc(p)}">
            <input type="number" min="0" class="admin-input" data-ed="${i}:pontos" value="${d.pontos || 0}" aria-label="Pontos de ${esc(p)}">
            <input type="number" min="0" class="admin-input" data-ed="${i}:gols" value="${d.gols || 0}" aria-label="Gols de ${esc(p)}"></div>`; }).join('');
}

async function salvarAjusteRanking() {
    const n = nomes(), rk = rankKey();
    const novo = JSON.parse(JSON.stringify(cloud[rk] || {}));     // preserva jogadores que não estão na lista atual
    n.forEach((p, i) => {
        const g = (c) => Math.max(0, parseInt(document.querySelector(`[data-ed="${i}:${c}"]`).value, 10) || 0);
        novo[p] = { titulos: g('titulos'), pontos: g('pontos'), gols: g('gols') };
    });
    await gravar(ref.child(rk).set(novo)); toast('Ranking atualizado ✔', 'ok');
}

function fazerBackup() {
    const blob = new Blob([JSON.stringify(cloud, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `backup_${salaAtual}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function resetTotal() {
    const r = await UI.modal({
        title: 'Reset total', danger: true, ok: 'Apagar tudo',
        html: `<p>Isso apaga <b>toda</b> a sala (ranking, histórico e jogos) e não pode ser desfeito. Faça um backup antes.</p>`,
        fields: [{ id: 'nome', label: `Digite o nome da sala (${salaAtual}) para confirmar` }],
        validar: (v) => v.nome === salaAtual ? '' : 'O nome não confere.'
    });
    if (!r) return;
    await gravar(ref.remove()); sessionStorage.removeItem('FC_ADM_' + salaAtual); sairDaSala();
}

/* ---- Encerrar campeonato ---- */
async function finalizar() {
    const n = nomes(), modo = getModo(), f = fixtures();
    if (n.length < 2) return;
    const tab = FC.calcularTabela(n, f.grupos, cloud.jogos);
    const partidas = FC.partidasDoEstado(n, f.grupos, cloud.jogos);
    if (!partidas.length) return toast('Lance ao menos um resultado antes de encerrar.', 'erro');
    let campeao;
    if (modo === 'mata') {
        if (f.campeao == null) return toast('A final ainda não foi decidida.', 'erro');
        campeao = n[f.campeao];
    } else campeao = tab[0].nome;
    const todos = FC.todosJogos(f.grupos), pend = todos.length - partidas.length;

    const ok = await UI.confirmar({
        title: 'Encerrar campeonato?', ok: 'Encerrar',
        html: `<div class="champ"><div class="trofeu">🏆</div><div class="nome">${esc(campeao)}</div><p class="muted small">campeão · ${esc(tituloModo())}</p></div>
               ${pend > 0 ? `<p>⚠️ Ainda há <b>${pend}</b> jogo(s) sem resultado; eles não serão contados.</p>` : '<p>✔ Todos os jogos foram concluídos.</p>'}
               <p class="muted small">Os resultados vão para o <b>histórico</b>, o ranking é atualizado e os placares são zerados.</p>`
    });
    if (!ok || !(await garantirAdmin())) return;

    const rk = rankKey(), hist = JSON.parse(JSON.stringify(cloud[rk] || {}));
    n.forEach(p => { hist[p] = hist[p] || { titulos: 0, pontos: 0, gols: 0 }; });
    hist[campeao].titulos = (hist[campeao].titulos || 0) + 1;
    tab.forEach(t => { hist[t.nome].pontos = (hist[t.nome].pontos || 0) + t.pts; hist[t.nome].gols = (hist[t.nome].gols || 0) + t.gm; });
    const chave = ref.child('historico').push().key;
    const entrada = {
        ts: firebase.database.ServerValue.TIMESTAMP, modo, campeao, jogadores: n,
        tabela: tab.map(t => ({ nome: t.nome, pts: t.pts, pj: t.pj, v: t.v, e: t.e, d: t.d, gm: t.gm, gc: t.gc })),
        jogos: partidas.map(p => ({ n1: p.n1, n2: p.n2, g1: p.g1, g2: p.g2, t1: p.t1 || '', t2: p.t2 || '', p1: p.p1, p2: p.p2 }))
    };
    try { await ref.update({ [rk]: hist, ['historico/' + chave]: entrada, jogos: null, chave: null }); }
    catch (e) { return toast('Falha ao encerrar: ' + e.message, 'erro'); }

    rodadaSel = null;
    confetti({ particleCount: 220, spread: 90, origin: { y: 0.6 } }); fanfare();
    await UI.modal({
        title: '🎉 Temos um campeão!', ok: 'Fechar', cancel: null,
        html: `<div class="champ"><div class="trofeu">🏆</div><div class="nome">${esc(campeao)}</div>
               <table><tbody>${tab.slice(0, 3).map((t, i) => `<tr><td>${['🥇', '🥈', '🥉'][i]}</td><td style="text-align:left"><b>${esc(t.nome)}</b></td><td>${t.pts} pts</td><td>${t.v}V</td></tr>`).join('')}</tbody></table></div>`
    });
}

/* ---- Compartilhar ---- */
function linkSala() { return location.origin + location.pathname + '?sala=' + encodeURIComponent(salaAtual); }
async function convidar() {
    const protegida = !!(cloud.meta || {}).entradaHash;
    const texto = `Bora jogar EA FC! Entre na sala "${salaAtual}"${protegida ? ' (peça o PIN pra mim)' : ''}: ${linkSala()}`;
    if (navigator.share) { try { await navigator.share({ title: 'EA FC Pro', text: texto, url: linkSala() }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(texto); toast('Convite copiado! Cole no WhatsApp 📲', 'ok'); }
    catch { window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank', 'noopener'); }
}

async function compartilharTabela() {
    const n = nomes(), tab = FC.calcularTabela(n, fixtures().grupos, cloud.jogos);
    const W = 900, linha = 64, H = 200 + tab.length * linha, c = document.createElement('canvas');
    c.width = W; c.height = H; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#0f172a'); g.addColorStop(1, '#1e3a8a');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = '#f59e0b'; x.font = '900 40px Inter, system-ui, sans-serif'; x.fillText('EA FC PRO · ' + tituloModo().toUpperCase(), 40, 70);
    x.fillStyle = '#cbd5e1'; x.font = '24px Inter, system-ui, sans-serif'; x.fillText(`Sala ${salaAtual} · ${new Date().toLocaleDateString('pt-BR')}`, 40, 110);
    const cols = [['Pts', 520], ['PJ', 600], ['V', 670], ['E', 730], ['D', 790], ['SG', 850]];
    x.fillStyle = '#94a3b8'; x.font = '700 22px Inter, system-ui, sans-serif'; cols.forEach(([t, px]) => x.fillText(t, px, 160));
    tab.forEach((p, i) => {
        const y = 200 + i * linha;
        if (i === 0 && p.pj) { x.fillStyle = 'rgba(245,158,11,.18)'; x.fillRect(24, y - 30, W - 48, linha - 8); }
        x.fillStyle = '#fff'; x.font = '800 30px Inter, system-ui, sans-serif'; x.fillText(`${i + 1}  ${p.nome}`, 40, y + 14);
        x.font = '800 28px Inter, system-ui, sans-serif';
        [[p.pts, 520], [p.pj, 600], [p.v, 670], [p.e, 730], [p.d, 790], [(p.sg > 0 ? '+' : '') + p.sg, 850]].forEach(([v, px]) => x.fillText(String(v), px, y + 14));
    });
    c.toBlob(async (blob) => {
        const file = new File([blob], `tabela_${salaAtual}.png`, { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Classificação' }); return; } catch (e) { if (e.name === 'AbortError') return; } }
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
        toast('Imagem salva! Envie no grupo 📸', 'ok');
    });
}

/* ====================== Eventos ====================== */
function ligarEventos() {
    $('btn-criar').onclick = criarSalaFluxo;
    $('btn-entrar').onclick = entrarSalaFluxo;
    $('recentes-lista').onclick = (e) => { const b = e.target.closest('[data-sala]'); if (b) abrirSala(b.dataset.sala); };
    $('btn-voltar').onclick = async () => { if (await UI.confirmar({ title: 'Voltar ao início?', html: '<p class="muted">Você sai desta sala neste aparelho. Os dados continuam salvos.</p>', ok: 'Sair' })) sairDaSala(); };
    $('label-sala').onclick = convidar;
    $('btn-convidar').onclick = convidar;
    $('btn-tema').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; gravarLS('FC_TEMA', t); aplicarTema(t); };
    $('btn-som').onclick = () => { mudo = !mudo; gravarLS('FC_MUDO', mudo); $('btn-som').textContent = mudo ? '🔕' : '🔔'; if (!mudo) beep(); };

    const navTabs = document.querySelector('.bottom-nav');
    if (navTabs) navTabs.onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { mudarAba(b.dataset.tab); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
    if ($('btn-ir-ajustes')) $('btn-ir-ajustes').onclick = () => { mudarAba('ajustes'); $('novo-jogador') && $('novo-jogador').focus(); };

    document.querySelector('.segmented').onclick = (e) => { const b = e.target.closest('[data-modo]'); if (b) mudarModo(b.dataset.modo); };
    $('form-player').onsubmit = (e) => {
        e.preventDefault();
        const campo = $('novo-jogador'), nome = FC.sanitizarNome(campo.value);
        if (!nome) return toast('Digite um nome válido.', 'erro');
        const atuais = nomes();
        if (atuais.some(p => p.toLowerCase() === nome.toLowerCase())) return toast('Esse jogador já está na sala.', 'erro');
        if (atuais.length >= MAX_JOGADORES) return toast(`Máximo de ${MAX_JOGADORES} jogadores.`, 'erro');
        campo.value = ''; mudarJogadores([...atuais, nome]);
    };
    $('chips').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) mudarJogadores(nomes().filter((_, i) => i !== Number(b.dataset.rm))); };

    $('filter-ui').onclick = (e) => {
        if (e.target.id === 'btn-todos') { filtros = filtros.size === FILTROS.length ? new Set(['top3']) : new Set(FILTROS.map(f => f.id)); return salvarFiltros(); }
        const b = e.target.closest('[data-filtro]'); if (!b) return;
        filtros.has(b.dataset.filtro) ? filtros.delete(b.dataset.filtro) : filtros.add(b.dataset.filtro);
        if (!filtros.size) { filtros.add(b.dataset.filtro); toast('Mantenha ao menos uma liga ativa.'); }
        salvarFiltros();
    };

    const lista = $('lista-confrontos');
    lista.addEventListener('change', onChange);
    lista.addEventListener('click', (e) => {
        const b = e.target.closest('[data-action]'); if (!b) return;
        const a = b.dataset.action, tot = fixtures().grupos.length;
        if (a === 'sortear') return sortearTimes(b.closest('.match-row').dataset.id);
        if (a === 'acao') return onAcao(b);
        if (a === 'rod-ant') rodadaSel = Math.max(0, rodadaSel - 1);
        else if (a === 'rod-prox') rodadaSel = Math.min(tot - 1, rodadaSel + 1);
        else if (a === 'rod-pend') { const i = fixtures().grupos.findIndex(g => !grupoConcluido(g)); rodadaSel = i === -1 ? tot - 1 : i; if (i === -1) toast('Todas as rodadas estão concluídas 🎉'); }
        viewSig = ''; render();
    });
    $('p1-select').onchange = () => renderRivalidade(nomes());
    $('p2-select').onchange = () => renderRivalidade(nomes());

    $('btn-limpar').onclick = limparPlacares;
    $('btn-finalizar').onclick = finalizar;
    $('btn-img').onclick = compartilharTabela;
    $('btn-admin').onclick = abrirAdmin;
    $('btn-salvar-rank').onclick = salvarAjusteRanking;
    $('btn-backup').onclick = fazerBackup;
    $('btn-reset').onclick = resetTotal;
}

iniciar();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(err => console.log('SW não registrado:', err)));
}
