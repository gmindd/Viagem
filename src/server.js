import 'dotenv/config';
import crypto from 'node:crypto';
import { createApp } from './app.js';
import { DB_FILE } from './lib/db.js';

// Em produção o segredo tem de ser fixo, senão as sessões caem a cada reinício
if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      'ERRO: falta a variável SESSION_SECRET. Gera uma com:\n' +
        "  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
    );
    process.exit(1);
  }
  process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('AVISO: SESSION_SECRET não definido — a usar um segredo temporário (só para desenvolvimento).');
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const server = createApp().listen(port, host, () => {
  console.log(`Viagem a correr em http://${host}:${port}`);
  console.log(`Base de dados: ${DB_FILE}`);
});

// Encerramento limpo para que o Docker consiga parar o contentor depressa
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
