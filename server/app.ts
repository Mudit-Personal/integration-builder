import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApp } from '../src/app-service.ts';
import { migrate, neonSql, type Sql } from '../src/db.ts';

const url = process.env.DATABASE_URL;
// Once per cold start. A failed start is retried by the next request instead of sticking.
let db: Promise<Sql | null> | null = null;
const connect = () => (db ??= url ? neonSql(url).then(async sql => { await migrate(sql); return sql; }).catch(e => { db = null; throw e; }) : Promise.resolve(null));

export default (req: IncomingMessage, res: ServerResponse) => handleApp(req, res, { db: connect() });
