import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
try {
  writeFileSync('.env', `API_TOKEN=${randomBytes(32).toString('hex')}\nPOSTGRES_PASSWORD=${randomBytes(24).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with fresh credentials. Keep it private.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env already exists; preserved.');
  else throw error;
}
