import bcrypt from 'bcrypt';
import db from './db.js';

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  console.error('Usage: node create-admin.js <username> <password>');
  process.exit(1);
}

const passwordHash = await bcrypt.hash(password, 12);

const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  db.prepare('UPDATE users SET passwordHash = ? WHERE username = ?').run(passwordHash, username);
  console.log(`Password updated for user "${username}"`);
} else {
  db.prepare('INSERT INTO users (username, passwordHash) VALUES (?, ?)').run(username, passwordHash);
  console.log(`Admin user "${username}" created`);
}
