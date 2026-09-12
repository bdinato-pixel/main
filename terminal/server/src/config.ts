import { join } from 'node:path';

export interface Config {
  port: number;
  dataFile: string;
  /** Serve the built web UI from this directory when it exists. */
  webDist: string;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8720),
    dataFile: process.env.DATA_FILE ?? join(process.cwd(), 'data', 'terminal.json'),
    webDist: process.env.WEB_DIST ?? join(process.cwd(), '..', 'web', 'dist'),
  };
}
