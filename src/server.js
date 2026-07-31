import 'dotenv/config';
import crypto from 'node:crypto';
import { resolveDbFile } from './lib/db-path.js';
import { checkEnvironment, reportProblems } from './lib/startup-check.js';

const DB_FILE = resolveDbFile();

// A verificação corre antes de qualquer import que abra a base de dados,
// para que um deploy mal configurado explique o problema em vez de rebentar.
const { errors, warnings, isProduction } = checkEnvironment({ dbFile: DB_FILE });
reportProblems({ errors, warnings });

if (errors.length) {
  process.exit(1);
}

// Fora de produção um segredo temporário chega (as sessões caem a cada reinício)
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[AVISO] SESSION_SECRET não definido — a usar um segredo temporário (só para desenvolvimento).');
}

// Import dinâmico: só depois de a configuração estar validada
const { createApp } = await import('./app.js');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const server = createApp().listen(port, host, () => {
  console.log(`Viagem a correr em http://${host}:${port}`);
  console.log(`Base de dados: ${DB_FILE}`);
  console.log(`Modo: ${isProduction ? 'produção' : 'desenvolvimento'}`);
  if (process.env.BASE_URL) console.log(`Links de partilha: ${process.env.BASE_URL}/e/...`);
});

// Encerramento limpo para que o Docker consiga parar o contentor depressa
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
