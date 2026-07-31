import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { SqliteSessionStore } from './lib/session-store.js';
import { loadUser } from './middleware/auth.js';
import { csrf } from './middleware/csrf.js';
import { flash } from './middleware/flash.js';
import { pendingBadge } from './lib/notifications.js';
import { VOTE_LABELS } from './routes/proposals.js';
import { router as authRouter } from './routes/auth.js';
import { router as passwordResetRouter } from './routes/password-reset.js';
import { router as profileRouter } from './routes/profile.js';
import { router as eventsRouter } from './routes/events.js';
import {
  formatDate,
  formatDateTime,
  formatKm,
  isPastDate,
  weekdayOf,
  labelFor,
  DIFFICULTIES,
  BIKE_TYPES,
  STATUS_LABELS,
  PHASES,
  VISIBILITIES,
  JOIN_POLICIES,
  WEEKDAY_INITIALS_PT
} from './lib/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

export function createApp() {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';

  // Atrás de nginx/Traefik no VPS: confia no primeiro proxy para IP e https
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(rootDir, 'views'));
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          // Os mosaicos do mapa vêm do OpenStreetMap; o resto continua local
          imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org'],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"]
        }
      },
      // Permite que o mapa/percurso seja aberto noutro site sem avisos do browser
      crossOriginEmbedderPolicy: false
    })
  );

  app.use(express.static(path.join(rootDir, 'public'), { maxAge: isProduction ? '7d' : 0 }));

  app.use(
    session({
      name: 'viagem.sid',
      secret: process.env.SESSION_SECRET,
      store: new SqliteSessionStore(),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        maxAge: 1000 * 60 * 60 * 24 * 30
      }
    })
  );

  // Base URL usada para construir os links de partilha.
  // Corre antes do csrf para que a página de erro do CSRF já tenha estes dados.
  app.use((req, res, next) => {
    req.appBaseUrl = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    res.locals.appBaseUrl = req.appBaseUrl;
    res.locals.currentPath = req.path;
    next();
  });

  app.use(flash);
  app.use(loadUser);
  app.use(pendingBadge);

  // A leitura do corpo vem depois da sessão e dos dados do cabeçalho, de
  // propósito: um corpo mal formado rebenta aqui, e a página de erro precisa
  // desses dados para se desenhar. Tem de vir antes do csrf, que lê o corpo.
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  // O mapa marca as divisões da rota via fetch, em JSON
  app.use(express.json({ limit: '32kb' }));

  app.use(csrf);

  // Helpers disponíveis em todas as vistas
  app.locals.formatDate = formatDate;
  app.locals.formatDateTime = formatDateTime;
  app.locals.formatKm = formatKm;
  app.locals.isPastDate = isPastDate;
  app.locals.weekdayOf = weekdayOf;
  app.locals.labelFor = labelFor;
  app.locals.DIFFICULTIES = DIFFICULTIES;
  app.locals.BIKE_TYPES = BIKE_TYPES;
  app.locals.STATUS_LABELS = STATUS_LABELS;
  app.locals.PHASES = PHASES;
  app.locals.VISIBILITIES = VISIBILITIES;
  app.locals.JOIN_POLICIES = JOIN_POLICIES;
  app.locals.WEEKDAYS = WEEKDAY_INITIALS_PT;
  app.locals.VOTE_LABELS = VOTE_LABELS;
  app.locals.appName = process.env.APP_NAME || 'Viagem';

  app.get('/', (req, res) => {
    if (req.user) return res.redirect('/painel');
    return res.render('home', { title: 'Organiza passeios de bicicleta com os amigos' });
  });

  // Endpoint de saúde para o healthcheck do Docker / monitorização do VPS
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(authRouter);
  app.use(passwordResetRouter);
  app.use(profileRouter);
  app.use(eventsRouter);

  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Página não encontrada',
      status: 404,
      message: 'Não encontrámos esta página.'
    });
  });

  // eslint-disable-next-line no-unused-vars -- o Express exige os 4 argumentos
  app.use((err, req, res, next) => {
    // Corpo mal formado ou grande de mais é culpa do pedido, não do servidor:
    // responder 500 escondia a causa e sujava o log com erros que não são bugs.
    const isBadBody = err.type === 'entity.parse.failed' || err.type === 'entity.too.large';
    const status = isBadBody ? 400 : 500;

    if (!isBadBody) console.error(err);

    // Rede de segurança: se o erro acontecer antes dos middlewares que enchem
    // res.locals, a página de erro não teria os dados que o cabeçalho usa e
    // falhava a renderizar — trocando um erro tratado por um 500 em branco.
    res.locals.user ??= null;
    res.locals.csrfToken ??= '';
    res.locals.pendingTotal ??= 0;
    res.locals.currentPath ??= req.path;
    res.locals.flash ??= null;

    if (req.accepts('html')) {
      return res.status(status).render('error', {
        title: isBadBody ? 'Pedido inválido' : 'Erro',
        status,
        message: isBadBody
          ? 'O pedido chegou mal formado. Volta atrás e tenta de novo.'
          : 'Algo correu mal do nosso lado. Tenta de novo daqui a pouco.'
      });
    }
    return res.status(status).json({
      error: isBadBody ? 'Pedido inválido.' : 'Erro interno.'
    });
  });

  return app;
}
