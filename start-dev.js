import { createServer } from 'vite';

const port = parseInt(process.env.PORT || '5173');

const server = await createServer({
  server: { host: true, port },
});

await server.listen();
server.printUrls();
