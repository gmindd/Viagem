import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { SqliteSessionStore } from './lib/session-store.js';
import { loadUser } from './middleware/auth.js';
import { csrf } from './middleware/csrf.js';
import { flash } from './middleware/flash.js';
import { router as authRouter } from './routes/auth.js';
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
          imgSrc: ["'self'", 'data:'],
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

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
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
  app.locals.appName = process.env.APP_NAME || 'Viagem';

  app.get('/', (req, res) => {
    if (req.user) return res.redirect('/painel');
    return res.render('home', { title: 'Organiza passeios de bicicleta com os amigos' });
  });

  // Endpoint de saúde para o healthcheck do Docker / monitorização do VPS
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(authRouter);
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
    console.error(err);
    res.status(500).render('error', {
      title: 'Erro',
      status: 500,
      message: 'Algo correu mal do nosso lado. Tenta de novo daqui a pouco.'
    });
  });

  return app;
}
