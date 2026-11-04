import { createServer } from "node:http";

const body = "Hello world!";
createServer((_request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}).listen(Number(process.env.PORT ?? 3000));
