import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
try {
  writeFileSync('.local/env', `export API_TOKEN=${randomBytes(32).toString('hex')}\nexport DATABASE_URL='postgresql:///pi_sec_workbench_dev?host=/tmp&sslmode=disable'\n`, { flag: 'wx', mode: 0o600 });
  console.log('Local credentials ready in .local/env (ignored by Git).');
} catch (error) {
  if (error.code === 'EEXIST') console.log('Existing local credentials preserved.');
  else throw error;
}
