import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';

const configPath = path.resolve('database', 'hell-alerts-telegram.json');
const args = new Set(process.argv.slice(2));

if (fs.existsSync(configPath) && !args.has('--replace')) {
  console.error('Ya existe una sesión de Telegram. No la sobrescribí.');
  console.error('Si necesitas reemplazarla, revoca primero la sesión en Telegram y vuelve a ejecutar con --replace.');
  process.exit(1);
}

if (!stdin.isTTY) {
  console.error('Este asistente requiere una terminal interactiva.');
  process.exit(1);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
let client;

try {
  console.log('Configura la sesión de Telegram que escuchará @LMEvents, INFO Lords Mobile y Kata KwF Atlas.');
  console.log('Asegúrate de que esta cuenta de Telegram ya esté unida al grupo INFO Lords Mobile.');
  console.log('Obtén API ID y API Hash en https://my.telegram.org/apps.');
  console.log('Si activas .onax en WhatsApp, los comandos / enviados al grupo se ejecutarán con esta cuenta de Telegram.');
  console.log('No compartas el código de inicio ni el archivo de sesión con nadie.\n');

  const apiIdText = (await rl.question('API ID: ')).trim();
  const apiHash = (await rl.question('API Hash: ')).trim();
  const phoneNumber = (await rl.question('Número de Telegram con código de país: ')).trim();

  if (!/^\d+$/.test(apiIdText) || !/^[\da-f]{32}$/i.test(apiHash) || !/^\+\d{7,15}$/.test(phoneNumber)) {
    throw new Error('API ID, API Hash o número telefónico tienen un formato inválido.');
  }

  client = new TelegramClient(new StringSession(''), Number(apiIdText), apiHash, {
    connectionRetries: 5
  });

  await client.start({
    phoneNumber: async () => phoneNumber,
    phoneCode: async () => (await rl.question('Código que Telegram envió a tu cuenta: ')).trim(),
    password: async (hint) => {
      console.log(`Verificación en dos pasos${hint ? ` (pista: ${hint})` : ''}.`);
      return rl.question('Contraseña de Telegram: ');
    },
    emailAddress: async () => (await rl.question('Correo de verificación de Telegram: ')).trim(),
    emailVerification: async () => ({
      type: 'code',
      code: (await rl.question('Código enviado a tu correo: ')).trim()
    }),
    onError: (error) => {
      console.error(`Error de autenticación de Telegram: ${error.message}`);
    }
  });

  const channel = await client.getEntity('LMEvents');
  const infoDialogs = (await client.getDialogs({ limit: 1000 }))
    .filter(dialog =>
      (dialog.isGroup || dialog.isChannel) &&
      dialog.title?.trim().toLocaleLowerCase('es') === 'info lords mobile'
    );
  if (infoDialogs.length !== 1) {
    throw new Error(
      `Se esperaba encontrar exactamente un grupo o canal llamado "INFO Lords Mobile", pero se encontraron ${infoDialogs.length}.`
    );
  }
  const self = await client.getMe();
  const config = {
    apiId: Number(apiIdText),
    apiHash,
    session: client.session.save(),
    telegramUserId: String(self.id),
    channelId: String(channel.id),
    createdAt: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });

  console.log(`\nSesión guardada localmente en ${configPath}.`);
  console.log('Revisa que esta cuenta esté unida a @LMEvents, INFO Lords Mobile y Kata KwF Atlas; después reinicia NAX.');
} catch (error) {
  console.error(`\nNo se pudo configurar Telegram: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (client) {
    try {
      await client.disconnect();
    } catch (error) {
      console.error(`No se pudo cerrar la conexión de configuración de Telegram: ${error.message}`);
    }
  }
  rl.close();
}
