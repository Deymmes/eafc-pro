# EA FC Pro – Elite Edition (projeto novo)

Projeto Firebase: **eafc-pro-novo** (já configurado em `config.js`).

## Arquivos
index.html · style.css · config.js · logic.js · app.js · sw.js · manifest.json · icon.png · telainicial.jpg · database.rules.json

## Para funcionar
1. Firebase > Authentication > Sign-in method > **Anônimo** ativado.
2. Firebase > Realtime Database > **Regras** > colar o conteúdo de `database.rules.json` > Publicar.
3. Publicar a pasta num endereço HTTPS (ex.: Netlify Drop).
4. Ao mudar qualquer arquivo depois, aumente `VERSAO` em `sw.js`.
