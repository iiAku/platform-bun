import type { Server as BunNativeServer } from "bun";
import { Server as TlsServer } from "node:tls";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BunHttpServer, type BunHttpServerOptions } from "./bun-http-server.js";

/**
 * TLS lifecycle facade. Nest identifies HTTPS with instanceof tls.Server.
 * The base server is never bound: Bun.serve owns all listening and TLS I/O.
 */
export class BunHttpsServer extends TlsServer {
  private readonly delegate: BunHttpServer;
  // Node server settings of https.Server, carried by the delegate
  declare timeout: number;
  declare keepAliveTimeout: number;
  declare keepAliveTimeoutBuffer: number;
  declare headersTimeout: number;
  declare requestTimeout: number;
  declare maxHeadersCount: number | null;
  declare maxRequestsPerSocket: number | null;
  constructor(
    listener: (req: IncomingMessage, res: ServerResponse) => void,
    options: BunHttpServerOptions,
  ) {
    super();
    this.delegate = new BunHttpServer(listener, options);
    // Applications reach the server through req.socket.server
    this.delegate.owner = this;
    for (const event of ["request", "error", "listening", "close"]) {
      this.delegate.on(event, (...args: any[]) => this.emit(event, ...args));
    }
  }
  get nativeServer(): BunNativeServer<unknown> | undefined {
    return this.delegate.nativeServer;
  }
  listen(...args: any[]): this {
    (this.delegate.listen as Function)(...args);
    return this;
  }
  address() {
    return this.delegate.address();
  }
  close(callback?: (error?: Error) => void): this {
    this.delegate.close(callback);
    return this;
  }
  closeAllConnections() {
    return this.delegate.closeAllConnections();
  }
  closeIdleConnections() {
    return this.delegate.closeIdleConnections();
  }
  getConnections(callback: (error: Error | null, count: number) => void) {
    this.delegate.getConnections(callback);
    return this;
  }
  setTimeout(timeout?: number, callback?: () => void): this {
    this.delegate.setTimeout(timeout, callback);
    return this;
  }
  ref(): this {
    this.delegate.ref();
    return this;
  }
  unref(): this {
    this.delegate.unref();
    return this;
  }
  [Symbol.asyncDispose]() {
    return this.delegate[Symbol.asyncDispose]();
  }
}

Object.defineProperty(BunHttpsServer.prototype, "listening", {
  get() {
    return this.delegate?.listening ?? false;
  },
});
for (const name of [
  "timeout",
  "keepAliveTimeout",
  "keepAliveTimeoutBuffer",
  "headersTimeout",
  "requestTimeout",
  "maxHeadersCount",
  "maxRequestsPerSocket",
] as const) {
  Object.defineProperty(BunHttpsServer.prototype, name, {
    get() {
      return this.delegate?.[name];
    },
    set(value: number | null) {
      // The tls.Server constructor runs before the delegate exists
      if (this.delegate !== undefined) this.delegate[name] = value;
    },
    configurable: true,
  });
}
