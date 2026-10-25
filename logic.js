/* ============================================================
   EA FC Pro - Lógica pura (sem DOM, sem Firebase)
   Tudo aqui é calculado a partir dos DADOS, nunca lendo a tela.
   ============================================================ */
(function (root) {
    'use strict';
    const FC = {};

    /* ---------- Segurança / sanitização ---------- */
    FC.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // Remove caracteres proibidos em chaves do Firebase (. # $ [ ] /) e os que quebram HTML
    FC.sanitizarNome = (s) => String(s ?? '')
        .replace(/[.#$\[\]\/\\<>"'`\u0000-\u001f]/g, '')
        .replace(/\s+/g, ' ').trim().slice(0, 20);

    FC.sanitizarSala = (s) => String(s ?? '')
        .replace(/[.#$\[\]\/\\<>"'`\s\u0000-\u001f]/g, '').slice(0, 30);

    FC.normalizarJogadores = (lista, max = 8) => {
        const vistos = new Set();
        const out = [];
        for (const bruto of lista || []) {
            const nome = FC.sanitizarNome(bruto);
            const k = nome.toLowerCase();
            if (nome && !vistos.has(k)) { vistos.add(k); out.push(nome); }
            if (out.length >= max) break;
        }
        return out;
    };

    FC.gerarSalt = () => {
        const a = new Uint8Array(8);
        (root.crypto || {}).getRandomValues ? root.crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.floor(Math.random() * 256); });
        return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
    };

    FC.hashPin = async (pin, salt) => {
        const txt = salt + '::' + pin;
        if (root.crypto && root.crypto.subtle) {
            const buf = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
            return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        }
        let h = 5381; // fallback (contexto não seguro)
        for (const ch of txt) h = ((h << 5) + h + ch.charCodeAt(0)) | 0;
        return 'f' + (h >>> 0).toString(16);
    };

    FC.embaralhar = (arr) => {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    };

    /* ---------- Jogos ---------- */
    FC.idJogo = (c, i, j, k) => `c${c}_p${i}_p${j}_k${k}`;   // mesmo formato do app antigo
    FC.idMata = (r, k) => `m${r}_${k}`;

    FC.numero = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
    };

    // Normaliza um jogo vindo do Firebase (aceita o formato antigo: strings e "tentativas")
    FC.lerJogo = (jg) => {
        jg = jg || {};
        return {
            g1: FC.numero(jg.g1), g2: FC.numero(jg.g2),
            p1: FC.numero(jg.p1), p2: FC.numero(jg.p2),
            t1: jg.t1 || '', t2: jg.t2 || '',
            final: !!jg.final || (Number(jg.tentativas) || 0) >= 2
        };
    };
    FC.completo = (jg) => jg.g1 !== null && jg.g2 !== null;

    // 1 = lado 1 venceu, 2 = lado 2, 0 = empate/indefinido. Considera pênaltis.
    FC.vencedorPartida = (p) => {
        if (p.g1 > p.g2) return 1;
        if (p.g2 > p.g1) return 2;
        if (p.p1 != null && p.p2 != null && p.p1 !== p.p2) return p.p1 > p.p2 ? 1 : 2;
        return 0;
    };

    FC.chaveValida = (c, n) => Array.isArray(c) && c.length === n &&
        new Set(c).size === n && c.every(x => Number.isInteger(x) && x >= 0 && x < n);

    // Algoritmo do círculo: rodadas com todos contra todos, para N jogadores
    FC.rodadasRoundRobin = (n) => {
        const arr = [...Array(n).keys()];
        if (n % 2) arr.push(-1);
        const m = arr.length, rodadas = [];
        for (let r = 0; r < m - 1; r++) {
            const pares = [];
            for (let k = 0; k < m / 2; k++) {
                let a = arr[k], b = arr[m - 1 - k];
                if (a === -1 || b === -1) continue;
                if ((r + k) % 2 === 1) [a, b] = [b, a];   // alterna o mando de campo
                pares.push([a, b]);
            }
            rodadas.push(pares);
            arr.splice(1, 0, arr.pop());
        }
        return rodadas;
    };

    const nomeFase = (qtd, r) => qtd === 1 ? 'Final' : qtd === 2 ? 'Semifinal' : qtd === 4 ? 'Quartas de final' : qtd === 8 ? 'Oitavas de final' : `Fase ${r + 1}`;

    /**
     * Gera a estrutura de jogos de acordo com o modo.
     * Retorna { grupos: [{titulo, fase?, jogos:[{id,i,j,bye?}]}], campeao }
     * (campeao só é preenchido no mata-mata)
     */
    FC.gerarFixtures = (modo, n, jogosRaw, chave) => {
        jogosRaw = jogosRaw || {};
        const grupos = [];
        if (n < 2) return { grupos, campeao: null };

        if (modo === 'liga') {
            if (n === 2) {
                for (let r = 1; r <= 32; r++) {
                    const c = r <= 16 ? 0 : 1;
                    const idFixo = FC.idJogo(c, 0, 1, r);
                    const idAntigo = FC.idJogo(c, 1, 0, r);
                    const usarAntigo = !jogosRaw[idFixo] && !!jogosRaw[idAntigo];
                    grupos.push({
                        titulo: `Rodada ${r}`,
                        fase: c === 0 ? '1º turno' : '2º turno',
                        jogos: [{ id: usarAntigo ? idAntigo : idFixo, i: usarAntigo ? 1 : 0, j: usarAntigo ? 0 : 1 }]
                    });
                }
            } else {
                const base = FC.rodadasRoundRobin(n);
                let r = 0;
                for (let ciclo = 0; ciclo < 2; ciclo++) {
                    base.forEach(pares => {
                        r++;
                        const jogos = pares.map(([a, b]) => {
                            const i = ciclo ? b : a, j = ciclo ? a : b;
                            return { id: FC.idJogo(ciclo, i, j, r), i, j };
                        });
                        grupos.push({ titulo: `Rodada ${r}`, fase: ciclo ? '2º turno' : '1º turno', jogos });
                    });
                }
            }
            return { grupos, campeao: null };
        }

        if (modo === 'mata') {
            const ordem = FC.chaveValida(chave, n) ? chave : [...Array(n).keys()];
            let size = 2; while (size < n) size *= 2;
            const slots = [...ordem]; while (slots.length < size) slots.push(null);
            let atual = [];
            for (let k = 0; k < size / 2; k++) atual.push([slots[k], slots[size - 1 - k]]);
            let r = 0, campeao = null;
            while (true) {
                const jogos = [], vencedores = [];
                atual.forEach(([a, b], k) => {
                    const id = FC.idMata(r, k);
                    if (r === 0 && (a === null || b === null)) {
                        jogos.push({ id, i: a, j: b, bye: true });
                        vencedores.push(a === null ? b : a);
                        return;
                    }
                    jogos.push({ id, i: a, j: b });
                    let v = null;
                    if (a !== null && b !== null) {
                        const jg = FC.lerJogo(jogosRaw[id]);
                        if (FC.completo(jg)) {
                            const w = FC.vencedorPartida(jg);
                            v = w === 1 ? a : w === 2 ? b : null;
                        }
                    }
                    vencedores.push(v);
                });
                grupos.push({ titulo: nomeFase(jogos.length, r), jogos });
                if (vencedores.length === 1) { campeao = vencedores[0]; break; }
                atual = [];
                for (let k = 0; k < vencedores.length; k += 2) atual.push([vencedores[k], vencedores[k + 1]]);
                r++;
            }
            return { grupos, campeao };
        }

        // Clássico: 3 turnos
        for (let c = 0; c < 3; c++) {
            const jogos = [];
            if (n === 2) { for (let k = 1; k <= 2; k++) jogos.push({ id: FC.idJogo(c, 0, 1, k), i: 0, j: 1 }); }
            else { for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) jogos.push({ id: FC.idJogo(c, i, j, 0), i, j }); }
            grupos.push({ titulo: `Turno ${c + 1}`, jogos });
        }
        return { grupos, campeao: null };
    };

    FC.todosJogos = (grupos) => grupos.flatMap(g => g.jogos).filter(f => !f.bye);

    FC.partidasDoEstado = (nomes, grupos, jogosRaw) => {
        const out = [];
        FC.todosJogos(grupos).forEach(fx => {
            if (fx.i == null || fx.j == null) return;
            const jg = FC.lerJogo((jogosRaw || {})[fx.id]);
            if (!FC.completo(jg)) return;
            out.push({ n1: nomes[fx.i], n2: nomes[fx.j], g1: jg.g1, g2: jg.g2, p1: jg.p1, p2: jg.p2, t1: jg.t1, t2: jg.t2 });
        });
        return out;
    };

    /* ---------- Classificação ---------- */
    FC.calcularTabela = (nomes, grupos, jogosRaw) => {
        const t = nomes.map((nome, idx) => ({ nome, idx, pts: 0, pj: 0, v: 0, e: 0, d: 0, gm: 0, gc: 0, sg: 0, ultimas: [] }));
        FC.todosJogos(grupos).forEach(fx => {
            if (fx.i == null || fx.j == null) return;
            const jg = FC.lerJogo((jogosRaw || {})[fx.id]);
            if (!FC.completo(jg)) return;
            const a = t[fx.i], b = t[fx.j];
            a.pj++; b.pj++;
            a.gm += jg.g1; a.gc += jg.g2; b.gm += jg.g2; b.gc += jg.g1;
            if (jg.g1 > jg.g2) { a.pts += 3; a.v++; b.d++; a.ultimas.push('V'); b.ultimas.push('D'); }
            else if (jg.g2 > jg.g1) { b.pts += 3; b.v++; a.d++; b.ultimas.push('V'); a.ultimas.push('D'); }
            else { a.pts++; b.pts++; a.e++; b.e++; a.ultimas.push('E'); b.ultimas.push('E'); }
        });
        t.forEach(x => {
            x.sg = x.gm - x.gc;
            x.aproveitamento = x.pj ? Math.round((x.pts / (3 * x.pj)) * 100) : 0;
        });
        // Desempate: pontos > vitórias > saldo > gols marcados > nome
        return t.sort((a, b) => b.pts - a.pts || b.v - a.v || b.sg - a.sg || b.gm - a.gm || a.nome.localeCompare(b.nome));
    };

    /* ---------- Estatísticas e rivalidade ---------- */
    FC.estatisticas = (partidas) => {
        const jog = {}, times = {}, seq = {}, melhor = {};
        let goleada = null;
        const get = (n) => jog[n] || (jog[n] = { nome: n, j: 0, v: 0, e: 0, d: 0, gm: 0, gc: 0 });
        partidas.forEach(p => {
            const a = get(p.n1), b = get(p.n2);
            a.j++; b.j++; a.gm += p.g1; a.gc += p.g2; b.gm += p.g2; b.gc += p.g1;
            const w = p.g1 > p.g2 ? 1 : p.g2 > p.g1 ? 2 : 0;
            if (w === 1) { a.v++; b.d++; } else if (w === 2) { b.v++; a.d++; } else { a.e++; b.e++; }
            [[p.n1, w === 1], [p.n2, w === 2]].forEach(([n, venceu]) => {
                seq[n] = venceu ? (seq[n] || 0) + 1 : 0;
                if ((seq[n] || 0) > (melhor[n] || 0)) melhor[n] = seq[n];
            });
            const diff = Math.abs(p.g1 - p.g2), tot = p.g1 + p.g2;
            if (diff > 0 && (!goleada || diff > goleada.diff || (diff === goleada.diff && tot > goleada.tot))) goleada = { ...p, diff, tot };
            const wp = FC.vencedorPartida(p);
            [[p.t1, wp === 1], [p.t2, wp === 2]].forEach(([tm, venceu]) => {
                if (!tm) return;
                const x = times[tm] || (times[tm] = { time: tm, j: 0, v: 0 });
                x.j++; if (venceu) x.v++;
            });
        });
        const jogadores = Object.values(jog).map(x => ({ ...x, aproveitamento: x.j ? Math.round(((x.v * 3 + x.e) / (3 * x.j)) * 100) : 0 }))
            .sort((a, b) => b.aproveitamento - a.aproveitamento || b.v - a.v);
        let seqTop = null;
        Object.entries(melhor).forEach(([nome, qtd]) => { if (qtd >= 2 && (!seqTop || qtd > seqTop.qtd)) seqTop = { nome, qtd }; });
        const timeTop = Object.values(times).filter(x => x.j >= 2)
            .sort((a, b) => b.v / b.j - a.v / a.j || b.v - a.v)[0] || null;
        return { total: partidas.length, goleada, jogadores, seqTop, timeTop };
    };

    FC.rivalidade = (partidas, a, b, legado) => {
        let va = 0, vb = 0, e = 0;
        partidas.forEach(p => {
            if (!((p.n1 === a && p.n2 === b) || (p.n1 === b && p.n2 === a))) return;
            const w = FC.vencedorPartida(p);
            if (w === 0) e++; else ((w === 1 ? p.n1 : p.n2) === a ? va++ : vb++);
        });
        if (legado) { va += Number(legado[a]) || 0; vb += Number(legado[b]) || 0; }
        return { va, vb, e };
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = FC;
    root.FC = FC;
})(typeof window !== 'undefined' ? window : globalThis);
