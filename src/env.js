// Load settings from .env next to package.json, so the app also starts with a plain `node src/server.js`
// (the Windows/Mac start files). The server install passes --env-file instead; variables already set win.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../.env', import.meta.url));
if (process.env.NODE_ENV !== 'test' && fs.existsSync(file)) process.loadEnvFile(file);
