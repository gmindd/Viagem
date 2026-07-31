import fs from 'node:fs';
import path from 'node:path';

/**
 * Verifica a configuração antes de a app arrancar.
 * Devolve { errors, warnings } com mensagens já formatadas para o log,
 * para que um deploy falhado diga exactamente o que corrigir.
 */
export function checkEnvironment({ env = process.env, dbFile } = {}) {
  const isProduction = env.NODE_ENV === 'production';
  const errors = [];
  const warnings = [];

  checkSessionSecret(env, isProduction, errors, warnings);
  checkDataDirectory(dbFile, errors);
  checkBaseUrl(env, isProduction, warnings);

  return { errors, warnings, isProduction };
}

/** O segredo das sessões tem de ser fixo e longo em produção. */
function checkSessionSecret(env, isProduction, errors, warnings) {
  const secret = env.SESSION_SECRET;

  if (!secret) {
    if (isProduction) {
      errors.push({
        title: 'Falta a variável SESSION_SECRET',
        detail:
          'Sem ela os cookies de sessão não podem ser assinados e ninguém consegue iniciar sessão.\n' +
          'Gera um valor com:\n' +
          '    node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
          'Depois define SESSION_SECRET nas variáveis de ambiente do serviço.\n' +
          'Num painel tipo Coolify/Dokploy/CapRover isto faz-se na secção\n' +
          'Environment Variables — o ficheiro .env do repositório NÃO é usado,\n' +
          'porque está no .gitignore e nunca chega ao servidor.'
      });
    }
    return;
  }

  if (secret.length < 32) {
    warnings.push({
      title: 'SESSION_SECRET demasiado curto',
      detail: `Tem ${secret.length} caracteres; usa pelo menos 32 para os cookies serem difíceis de forjar.`
    });
  }
}

/** A pasta da base de dados tem de existir e ser gravável pelo utilizador do contentor. */
function checkDataDirectory(dbFile, errors) {
  if (!dbFile) return;
  const dir = path.dirname(dbFile);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    errors.push({
      title: `Não é possível escrever em ${dir}`,
      detail:
        `O sistema devolveu: ${err.code || err.message}\n` +
        'A base de dados SQLite vive nesta pasta, por isso a app não arranca sem ela.\n' +
        'Se estiveres a montar um volume, garante que pertence ao utilizador do contentor:\n' +
        `    docker compose exec -u root viagem chown -R node:node ${dir}\n` +
        'Em alternativa, aponta DATABASE_FILE para um caminho gravável.'
    });
  }
}

/** BASE_URL alimenta os links de partilha; se estiver errado, os links apontam para o sítio errado. */
function checkBaseUrl(env, isProduction, warnings) {
  if (!isProduction) return;

  if (!env.BASE_URL) {
    warnings.push({
      title: 'BASE_URL não está definido',
      detail:
        'Os links de partilha vão usar o endereço que o browser enviar em cada pedido.\n' +
        'Normalmente funciona atrás de um proxy bem configurado, mas define\n' +
        'BASE_URL=https://o-teu-dominio para os links serem sempre correctos.'
    });
    return;
  }

  if (!env.BASE_URL.startsWith('https://')) {
    warnings.push({
      title: 'BASE_URL não usa https',
      detail:
        'Em produção os cookies de sessão são marcados Secure e só viajam por HTTPS.\n' +
        'Sem certificado, o login não persiste: a pessoa entra e volta logo à página inicial.'
    });
  }
}

/** Escreve os problemas no log num bloco difícil de ignorar. */
export function reportProblems({ errors, warnings }) {
  for (const w of warnings) {
    console.warn(`\n[AVISO] ${w.title}\n${indent(w.detail)}`);
  }

  if (!errors.length) return;

  console.error(`\n${'='.repeat(68)}`);
  console.error('  A APP NÃO ARRANCOU — configuração incompleta');
  console.error('='.repeat(68));
  errors.forEach((e, i) => {
    console.error(`\n  ${i + 1}. ${e.title}\n${indent(e.detail, '     ')}`);
  });
  console.error(`\n${'='.repeat(68)}\n`);
}

/** Indenta um bloco de texto multi-linha para o log ficar legível. */
function indent(text, prefix = '  ') {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}
