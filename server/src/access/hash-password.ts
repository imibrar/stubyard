/**
 * Prints a password hash for STUBYARD_ADMIN_PASSWORD_HASH.
 *
 *   ./scripts/npm.sh run hash-password -w server          (from a checkout; asks for the password)
 *   docker exec -it stubyard node dist/access/hash-password.js
 *   printf '%s' "$PASSWORD" | node dist/access/hash-password.js
 *
 * The password is read from the terminal (not echoed) or from stdin, never from the command line, so it does not end up
 * in the shell history or the process list.
 */
import { hashPassword, MIN_PASSWORD_LENGTH } from './password.js';

const CTRL_C = String.fromCharCode(3);
const BACKSPACE = [String.fromCharCode(8), String.fromCharCode(127)];

async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          return resolve(value);
        }
        if (ch === CTRL_C) {
          done();
          return reject(new Error('cancelled'));
        }
        if (BACKSPACE.includes(ch)) value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.replace(/\r?\n$/, '');
}

async function main() {
  let password: string;
  if (process.stdin.isTTY) {
    password = await readHidden('Password: ');
    const again = await readHidden('Again: ');
    if (password !== again) throw new Error('The two passwords differ');
  } else {
    password = await readStdin();
  }
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  process.stdout.write(`${hashPassword(password)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
