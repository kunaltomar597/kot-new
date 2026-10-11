// A stand-in for the server (`dist/main.js`) in the service host's tests (P0-16b). It answers the
// health check on PORT and behaves as FAKE_BEHAVIOUR says (comma-separated):
//   hang-first     answers once, then blocks its event loop (first start only)
//   restart-first  exits with 75, a restart that is meant (first start only)
//   degraded       answers 503, as when the database is down
//   ignore-stop    does not close when asked
// Each start appends its PID to FAKE_DIR/starts.log; a stop writes FAKE_DIR/closed-<pid>.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const dir = process.env.FAKE_DIR ?? '.';
const behaviour = (process.env.FAKE_BEHAVIOUR ?? '').split(',');
const startsFile = join(dir, 'starts.log');
/** Starts before this one; no file yet is none (read at once, not checked first). */
function earlierStarts() {
  try {
    return readFileSync(startsFile, 'utf8').split('\n').filter(Boolean).length;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}
const earlier = earlierStarts();
const first = earlier === 0;
appendFileSync(startsFile, `${String(process.pid)}\n`);

const server = createServer((request, response) => {
  if (request.url !== '/api/v1/health') {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.statusCode = behaviour.includes('degraded') ? 503 : 200;
  response.setHeader('content-type', 'application/json');
  response.end('{"status":"ok"}');
  if (first && behaviour.includes('hang-first')) {
    setTimeout(() => {
      const until = Number.MAX_SAFE_INTEGER;
      while (Date.now() < until) {
        // Stuck.
      }
    }, 50);
  }
});

server.listen(Number(process.env.PORT), '127.0.0.1', () => {
  if (first && behaviour.includes('restart-first')) setTimeout(() => process.exit(75), 100);
});

function close(why) {
  if (behaviour.includes('ignore-stop')) return;
  writeFileSync(join(dir, `closed-${String(process.pid)}`), why);
  server.close();
  process.exit(0);
}
process.on('message', (message) => {
  if (message?.type === 'rp:shutdown') close('shutdown');
});
process.on('disconnect', () => close('disconnect'));
