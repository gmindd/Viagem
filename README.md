# Viagem

App auto-alojada para um grupo de amigos organizar passeios de bicicleta:
cada pessoa cria conta com email e palavra-passe, cria passeios, e partilha
um link. Os passeios podem ser abertos a quem tiver o link ou protegidos por
uma palavra-passe própria.

## O que faz

**Contas**
- Registo com email + palavra-passe (guardada com bcrypt, 12 rondas).
- Perfil com nome, telemóvel, outro contacto (Instagram/Strava/Telegram) e nota pessoal.
- Alteração de palavra-passe com confirmação da actual.

**Passeios**
- Data, hora e ponto de encontro; data de fim para viagens de vários dias.
- Distância, desnível, dificuldade, tipo de bicicleta e link do percurso (Komoot, Strava, …).
- Limite opcional de vagas, com bloqueio automático quando esgotam.
- **Link de partilha** próprio (`/e/<código>`), com botão de copiar e partilha nativa no telemóvel.

**Visibilidade**
- `Aberto` — qualquer pessoa com o link vê os detalhes; para se inscrever tem de ter conta.
- `Protegido` — além do link, é preciso a palavra-passe do passeio para ver seja o que for.
  O desbloqueio fica guardado na sessão de quem acertou.

**Inscrições e coordenação**
- Cada pessoa marca *Vou* / *Talvez* / *Não vou*, com uma nota opcional.
- Mural de mensagens por passeio, para combinar boleias e ritmo.
- Só quem organiza vê os contactos dos inscritos e pode exportá-los em CSV.

## Stack

Node.js 22 · Express · SQLite (better-sqlite3) · EJS · sessões em cookie assinado.
Sem build step, sem dependências de front-end, sem serviços externos — arranca
com um `docker compose up` e guarda tudo num único ficheiro SQLite.

## Instalação no VPS

### 1. Clonar e configurar

```bash
git clone <url-do-repo> viagem
cd viagem
cp .env.example .env
```

Gera o segredo das sessões e coloca-o no `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

No `.env`, preenche pelo menos:

```
SESSION_SECRET=<o valor gerado acima>
BASE_URL=https://viagem.oteudominio.pt
```

`BASE_URL` é o que aparece nos links de partilha — se ficar errado, os links
que enviares apontam para o sítio errado.

### 2. Arrancar

```bash
docker compose up -d --build
docker compose logs -f
```

A app fica em `127.0.0.1:3000`, acessível apenas a partir do próprio servidor.
O nginx trata do exterior e do HTTPS.

### 3. Nginx + HTTPS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/viagem
sudo nano /etc/nginx/sites-available/viagem          # substitui o domínio
sudo ln -s /etc/nginx/sites-available/viagem /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d viagem.oteudominio.pt
```

O `certbot` trata do certificado e da renovação automática.

> Os cookies de sessão são marcados `secure` quando `NODE_ENV=production`,
> por isso a app **precisa** de HTTPS em produção — sem ele o login não persiste.

### 4. Actualizar

```bash
git pull
docker compose up -d --build
```

A base de dados vive no volume `viagem-data` e não é tocada pelas actualizações.

## Instalação num painel (Coolify, Dokploy, CapRover…)

Se estiveres a usar um painel em vez do `docker compose` à mão, atenção a isto:

**O ficheiro `.env` não existe no servidor.** Está no `.gitignore`, por isso
nunca é clonado. As variáveis têm de ser definidas na interface do painel, na
secção *Environment Variables*. No mínimo:

| Variável         | Valor                                    |
| ---------------- | ---------------------------------------- |
| `SESSION_SECRET` | 96 caracteres aleatórios (ver abaixo)    |
| `BASE_URL`       | `https://viagem.oteudominio.pt`          |
| `TZ`             | `Europe/Lisbon`                          |

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Sem `SESSION_SECRET` a app recusa-se a arrancar e o painel entra em ciclo de
reinícios até desistir. É propositado: arrancar com um segredo aleatório faria
com que todas as sessões caíssem a cada reinício, o que dá um bug muito mais
difícil de perceber do que uma recusa clara no arranque.

**Volume persistente:** monta um volume em `/data`. Sem isso a base de dados
desaparece a cada actualização.

**HTTPS:** o painel trata do certificado. Confirma que está activo antes de
testares o login — os cookies de sessão são `Secure` e não sobrevivem a HTTP.

### O contentor reinicia sem parar

O motivo está sempre escrito nas primeiras linhas do log do arranque. Se o
separador *Logs* aparecer vazio, é porque o contentor já morreu e não há nada
a correr — procura antes no log do **deployment**, ou reinicia e lê o log logo
nos primeiros segundos.

A app escreve um bloco explícito a dizer o que falta:

```
====================================================================
  A APP NÃO ARRANCOU — configuração incompleta
====================================================================

  1. Falta a variável SESSION_SECRET
     ...
```

Os dois motivos habituais são `SESSION_SECRET` em falta e a pasta `/data` sem
permissão de escrita para o utilizador `node` do contentor. Se for o segundo:

```bash
docker compose exec -u root viagem chown -R node:node /data
```

## Cópias de segurança

Tudo está num ficheiro SQLite. Para uma cópia consistente com a app a correr:

```bash
docker compose exec viagem node -e "
  const db = require('better-sqlite3')('/data/viagem.db');
  db.backup('/data/backup-' + new Date().toISOString().slice(0,10) + '.db');
"
docker compose cp viagem:/data/. ./backups/
```

Vale a pena pôr isto num `cron` diário e levar as cópias para fora do VPS.

## Desenvolvimento local

```bash
npm install
npm run dev
```

Abre <http://localhost:3000>. Sem `SESSION_SECRET` definido é gerado um
temporário (as sessões caem a cada reinício) e a base de dados fica em
`data/viagem.db`.

## Estrutura

```
src/
  server.js              arranque, variáveis de ambiente, encerramento limpo
  app.js                 montagem do Express, segurança, helpers das vistas
  lib/
    schema.sql           esquema SQLite (idempotente)
    db.js                ligação à base de dados
    session-store.js     store de sessões sobre better-sqlite3
    helpers.js           validação, formatação de datas, listas de opções
  middleware/
    auth.js              carregamento do utilizador, rotas privadas
    csrf.js              token CSRF sincronizado na sessão
    flash.js             mensagens entre pedidos
  routes/
    auth.js              registo, login, logout
    profile.js           perfil e alteração de palavra-passe
    events.js            passeios, inscrições, mural, partilha, CSV
views/                   templates EJS (partials + páginas)
public/
  css/style.css          todos os estilos
  js/app.js              todo o JavaScript do cliente
  assets/images/         favicon e imagens
deploy/
  nginx.conf.example     proxy reverso de exemplo
```

## Notas de segurança

- Palavras-passe (de conta e de evento) guardadas com bcrypt; nunca em claro.
- Sessão regenerada no login e no registo, para evitar fixação de sessão.
- Token CSRF obrigatório em todos os POST.
- Content-Security-Policy restritiva (`default-src 'self'`), sem scripts nem
  estilos inline em lado nenhum.
- Limite de tentativas de login e registo por IP (30 em cada 15 minutos).
- Links de partilha com 10 caracteres aleatórios (~10^15 combinações), gerados
  com `crypto.randomBytes`.
- Os contactos de cada participante só são mostrados a quem organiza o passeio.

O modelo de segurança é o de uma app entre amigos: quem tiver o link de um
passeio aberto vê os detalhes. Para algo mais fechado, usa a opção protegida
por palavra-passe.
