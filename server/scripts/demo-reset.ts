// A fresh, current demo (#115): drops and recreates the database in DATABASE_URL, migrates it and seeds it.
// Only for a database whose name ends in _demo; any other name is refused, so this can never wipe real data.
//
//   DATABASE_URL=postgres://kernel:kernel@localhost:5432/kernel_demo npm run demo:reset -w server
import pg from 'pg';

const url = new URL(process.env.DATABASE_URL ?? '');
const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
if (!/^[A-Za-z0-9_]+_demo$/.test(name)) {
  console.error(`Refusing: "${name || '(none)'}" does not end in _demo. demo:reset only drops demo databases.`);
  process.exit(1);
}
const admin = new URL(url);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
// The name is checked above to be [A-Za-z0-9_]+_demo, so quoting it is enough.
await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
await client.query(`CREATE DATABASE "${name}"`);
await client.end();
console.log(`Recreated ${name}; seeding…`);
await import('./seed-demo.js');
