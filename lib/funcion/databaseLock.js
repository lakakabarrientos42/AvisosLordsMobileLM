import fs from 'fs';

export function acquireDatabaseLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      fs.closeSync(fd);
      process.on('exit', () => {
        try {
          const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (lock.pid === process.pid) fs.unlinkSync(lockPath);
        } catch (error) {
          if (error.code !== 'ENOENT') console.error('[database lock] No se pudo liberar el bloqueo:', error.message);
        }
      });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      let lock;
      try {
        lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch (readError) {
        throw new Error(`No se puede leer ${lockPath}; verifica y elimina el archivo solo si el bot está detenido.`, { cause: readError });
      }

      if (!Number.isInteger(lock.pid) || lock.pid <= 0) {
        throw new Error(`El bloqueo ${lockPath} no contiene un PID válido; verifica y elimina el archivo solo si el bot está detenido.`);
      }

      try {
        process.kill(lock.pid, 0);
        throw new Error(`Ya hay otra instancia del bot (PID ${lock.pid}) usando database.json. Detén esa instancia antes de iniciar otra.`);
      } catch (processError) {
        if (processError.code !== 'ESRCH') throw processError;
      }

      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
    }
  }

  throw new Error(`No se pudo adquirir el bloqueo de ${lockPath}.`);
}
