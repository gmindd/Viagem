# Viagem

App auto-alojada para um grupo de amigos organizar passeios de bicicleta:
cada pessoa cria conta com email e palavra-passe, cria passeios, e partilha
um link. Os passeios podem ser abertos a quem tiver o link ou protegidos por
uma palavra-passe própria.

## O que faz

**Contas**
- Registo com email + palavra-passe (guardada com bcrypt, 12 rondas).
- **Recuperação de palavra-passe** por email, com link válido 2 horas e de
  uso único. Guarda-se o hash do token, nunca o token.
- Perfil com nome, telemóvel, outro contacto (Instagram/Strava/Telegram) e nota pessoal.
- Alteração de palavra-passe com confirmação da actual.

**Fases da viagem**

O organizador escolhe a fase nas definições, e a página muda com ela:

| Fase | O que acontece |
| --- | --- |
| **A combinar datas** | Ainda não há data. Cada participante marca num calendário os dias em que pode. Vê-se quantas pessoas podem em cada dia (mapa de calor) **e quem são** — por pessoa, com os blocos de dias seguidos que marcou. |
| **A votar nas datas** | O organizador põe alguns blocos de datas a votação — sugeridos a partir das disponibilidades, ou à mão — e o grupo responde *pode ser* / *talvez* / *não posso*. No fim escolhe-se um e a viagem avança. |
| **Preparação** | Data marcada. Entram os percursos — vários ficheiros GPX, um por etapa, para viagens de vários dias. |
| **Confirmado** | Está tudo fechado. |
| **Concluído** | Já aconteceu; sai da lista de viagens a decorrer. |

**Duração da viagem**
- Define quantos dias dura e se têm de ser **seguidos**.
- A disponibilidade é validada em função disso: numa viagem de 3 dias seguidos,
  marcar 3 dias soltos é recusado com a explicação do porquê. Se os dias
  puderem ser separados, bastam 3 dias quaisquer.
- As sugestões de datas só contam quem pode em *todos* os dias de cada bloco.

**Mapa do percurso**
- Cada GPX tem um mapa, com o traçado desenhado sobre o OpenStreetMap.
- **Pontos de interesse** ao longo da rota: restaurantes, dormidas, campismo,
  água, oficinas de bicicletas e mercearias, vindos do OpenStreetMap, com
  raio de procura configurável (400 m a 3 km) e filtros por categoria.
- **Divisão em etapas**: cada participante clica no percurso onde acha que
  cada dia deve acabar. As propostas de toda a gente ficam visíveis no mapa e
  numa lista, com o quilómetro exacto. Cada um apaga as suas; quem organiza
  apaga quaisquer.

**Percursos**
- Vários GPX por viagem, com número de dia, para travessias de várias etapas.
- A distância e o desnível de cada etapa são calculados a partir do próprio
  ficheiro — não é preciso escrevê-los à mão — e somados no total da viagem.
- Em alternativa (ou além disso), links do Komoot, Strava ou RideWithGPS.

**Quem pode ver, e como se entra**

Duas escolhas independentes, ambas nas definições da viagem:

| Visibilidade | Aparece na lista do site? | Quem chega pelo link |
| --- | --- | --- |
| **Pública** | Sim | Entra directamente |
| **Privada** | Sim | Vê a ficha, mas só entra por convite, palavra-passe ou pedido aprovado |
| **Secreta** | Não | Só quem tiver o link a encontra; entra pela forma escolhida |

As formas de entrada são *entrada livre*, *palavra-passe* ou *pedido de adesão*
(o organizador aceita ou recusa, e vê a mensagem de quem pediu). Uma viagem
pública é sempre de entrada livre — a app normaliza a combinação sozinha.

Independentemente disso, o organizador pode emitir **links de convite** que
deixam entrar directamente, com limite de utilizações e data de validade.

**O que só os membros vêem**

Quem ainda não faz parte da viagem vê apenas a ficha resumida: nome, fase,
número de participantes e como entrar. Ponto de encontro, percursos, mural,
calendário e lista de participantes ficam reservados a membros. Os contactos
de cada pessoa só o organizador os vê, e pode exportá-los em CSV.

**Moderadores**
- Quem organiza pode promover participantes a moderadores.
- Moderadores gerem a lista de material e podem disparar avisos por email para
  o grupo. Não mexem nas definições da viagem nem na lista de participantes —
  isso continua a ser só de quem organiza.

**Material a levar**
- Acrescenta-se pelo artigo, família e quantidade: *Câmara de ar · Mecânica · 3*.
- Cada unidade por atribuir aparece como um **balão clicável**. Três câmaras de
  ar são três balões; clicar num deles tira-o da lista e passa a ser teu.
- Os teus balões ficam preenchidos, com um × para os devolveres à lista. Os dos
  outros aparecem a tracejado, só para consulta.
- Os balões são agrupados por **família**, cada uma com a sua cor — atribuída a
  partir do nome, por isso a mesma família fica sempre com a mesma cor.
- Resumo no fim com o que cada participante ficou de levar, e contadores do que
  já está garantido e do que falta atribuir.

**Avisos do mural por email**
- Qualquer participante escreve no mural. Quem organiza e os moderadores têm um
  botão para reenviar essa mensagem por email a toda a gente da viagem.
- A mensagem fica marcada como enviada, com data, para não sair duas vezes.

**Inscrições e coordenação**
- Cada pessoa marca *Vou* / *Talvez* / *Não vou*, com uma nota opcional.
- Limite opcional de vagas, com bloqueio automático quando esgotam.
- Mural de mensagens por viagem, para combinar boleias, dormidas e ritmo.
- **Link de partilha** próprio (`/e/<código>`), com botão de copiar e partilha
  nativa no telemóvel.

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

**Escolhe o build pack Dockerfile, não o Nixpacks.** Os painéis costumam
detectar "projecto Node" e usar Nixpacks por omissão, o que ignora por completo
o Dockerfile deste repositório — e com ele o volume de dados, o healthcheck e o
utilizador não-root. No Coolify: *Configuration* → *Build Pack* → **Dockerfile**.

Com Nixpacks a app até arranca, mas a base de dados fica dentro do contentor e
**desaparece a cada redeploy**. Se preferires mesmo ficar com Nixpacks, monta um
volume em `/data` e define `DATABASE_FILE=/data/viagem.db` à mão — a app avisa
no arranque enquanto isso não estiver feito.

Restantes pontos de atenção:

**O ficheiro `.env` não existe no servidor.** Está no `.gitignore`, por isso
nunca é clonado. As variáveis têm de ser definidas na interface do painel, na
secção *Environment Variables*. No mínimo:

| Variável         | Valor                                    |
| ---------------- | ---------------------------------------- |
| `SESSION_SECRET` | 96 caracteres aleatórios (ver abaixo)    |
| `BASE_URL`       | `https://viagem.oteudominio.pt`          |
| `TZ`             | `Europe/Lisbon`                          |
| `RESEND_API_KEY` | chave do Resend (opcional — ver abaixo)  |
| `EMAIL_FROM`     | `Viagem <viagem@oteudominio.pt>`         |

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

## Actualizações e migrações do esquema

O esquema é gerido por **migrações versionadas** (`src/lib/migrations.js`), com
a versão aplicada guardada na própria base de dados (`PRAGMA user_version`).
Em cada arranque a app aplica apenas as que faltam, e cada uma corre dentro de
uma transacção: se falhar a meio, é revertida por inteiro e a app não arranca —
prefere-se não abrir a abrir com o esquema a meio.

Antes de aplicar qualquer migração, e sempre que a base de dados já tem contas,
é gravada uma cópia completa ao lado do ficheiro:

```
/data/backup-v0-2026-07-31T16-04-37.db
```

A regra das migrações é só acrescentar — tabelas, colunas, índices — ou
transformar dados existentes. Nenhuma apaga colunas ou tabelas com dados de
utilizadores. Actualizar é, por isso, o mesmo de sempre:

```bash
git pull
docker compose up -d --build
```

Os dados mantêm-se, e o log do arranque diz exactamente o que foi aplicado.

> **Nota sobre a actualização para as fases (migração 2):** as viagens criadas
> antes desta versão não apareciam em lado nenhum — só se lá chegava por link.
> Para não as expor sem o dono decidir, passaram todas a **secretas**, mantendo
> a forma de entrada que já tinham (livre, ou por palavra-passe). Se quiseres
> alguma delas listada no site, muda a visibilidade nas definições da viagem.

## Emails (Resend)

A app envia emails em três situações: recuperação de palavra-passe, aviso ao
organizador quando alguém pede para entrar, e aviso a quem pediu quando há
decisão. Também há um botão para avisar o grupo de que há datas para votar.

**Sem configuração, a app funciona à mesma** — simplesmente não envia nada. Os
pedidos de adesão continuam visíveis no menu *Pedidos*. A única coisa que fica
mesmo indisponível é a recuperação de palavra-passe: sem email não há como
entregar o link.

Para activar:

1. Cria conta em <https://resend.com> (o plano gratuito chega bem para um
   grupo de amigos).
2. **Domains → Add Domain**, e acrescenta os registos DNS que te derem (SPF e
   DKIM) no teu fornecedor de domínio. Sem o domínio verificado, o envio falha.
3. **API Keys → Create**, e define no servidor:

```
RESEND_API_KEY=re_...
EMAIL_FROM=Viagem <viagem@oteudominio.pt>
```

O domínio de `EMAIL_FROM` tem de ser o que verificaste no passo 2.

Se o envio falhar, a acção que o originou **não é desfeita** — um pedido de
adesão fica registado mesmo que o email não saia — e a falha é escrita no log
com o motivo.

## Pontos de interesse no mapa

Os pontos vêm do OpenStreetMap, através da [Overpass API](https://overpass-api.de).
É um serviço comunitário gratuito, por isso a app **guarda os resultados** e só
volta a consultá-lo quando pedires ou passada uma semana. Não é preciso
configurar nada; se tiveres um servidor Overpass próprio, define `OVERPASS_URL`.

Os mosaicos do mapa vêm dos servidores do OpenStreetMap. Para um grupo de
amigos o volume é irrelevante, mas se a app crescer convém usar um fornecedor
de mosaicos próprio, como pede a [política de utilização](https://operations.osmfoundation.org/policies/tiles/).

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
