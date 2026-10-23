/* ============================================================
   EA FC Pro - Configuração
   Obs.: a apiKey do Firebase Web é pública por design. Quem protege
   os dados são as Security Rules (veja database.rules.json).
   ============================================================ */
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBR_t-wZ8Gvo9PiLZn1Z053BKXT1KMKS54",
    authDomain: "eafc-pro-novo.firebaseapp.com",
    databaseURL: "https://eafc-pro-novo-default-rtdb.firebaseio.com",
    projectId: "eafc-pro-novo",
    storageBucket: "eafc-pro-novo.firebasestorage.app",
    messagingSenderId: "760091065300",
    appId: "1:760091065300:web:ad6ba00a29d51e2037f441"
};

const MAX_JOGADORES = 8;

const TIMES = {
    ing: ["Man. City", "Liverpool", "Chelsea", "Arsenal", "Tottenham", "Man. United", "Newcastle", "Aston Villa", "West Ham", "Brighton"],
    esp: ["Real Madrid", "Barcelona", "Atlético Madrid", "Girona", "Sevilla", "Real Sociedad", "Betis", "Villarreal"],
    ita: ["Inter Milão", "Juventus", "AC Milan", "Napoli", "Atalanta", "AS Roma", "Lazio", "Fiorentina"],
    ale: ["Bayer Leverkusen", "Bayern München", "Borussia Dortmund", "RB Leipzig", "Stuttgart", "Eintracht Frankfurt"],
    fra: ["PSG", "Monaco", "Marseille", "Lille", "Lyon"],
    sel: ["Brasil 🇧🇷", "Espanha 🇪🇸", "França 🇫🇷", "Argentina 🇦🇷", "Portugal 🇵🇹", "Inglaterra 🏴󠁧󠁢󠁥󠁮󠁧󠁿", "Alemanha 🇩🇪", "Holanda 🇳🇱", "Bélgica 🇧🇪"],
    top3: ["Real Madrid", "Man. City", "Bayern München", "PSG", "Inter Milão", "Liverpool", "Bayer Leverkusen", "Arsenal"]
};

/* Filtros exibidos na tela (rótulo claro + descrição) */
const FILTROS = [
    { id: "top3", rotulo: "⭐ Top", desc: "Os melhores times" },
    { id: "ing", rotulo: "🏴 ING" },
    { id: "esp", rotulo: "🇪🇸 ESP" },
    { id: "ita", rotulo: "🇮🇹 ITA" },
    { id: "ale", rotulo: "🇩🇪 ALE" },
    { id: "fra", rotulo: "🇫🇷 FRA" },
    { id: "sel", rotulo: "🌍 SEL" }
];

/* "Escudo" simples: emoji da liga ao lado do nome do time */
const BADGE_LIGA = { ing: "🏴", esp: "🇪🇸", ita: "🇮🇹", ale: "🇩🇪", fra: "🇫🇷", sel: "🌍" };
const BADGE_TIME = (() => {
    const mapa = {};
    ["ing", "esp", "ita", "ale", "fra", "sel"].forEach(l => TIMES[l].forEach(t => { mapa[t] = BADGE_LIGA[l]; }));
    return mapa;
})();
