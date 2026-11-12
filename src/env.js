// Imported first by the CLI so that .env is applied before any other module reads process.env.
import { loadEnv } from './config.js';

loadEnv();
